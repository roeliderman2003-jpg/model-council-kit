#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config';
import { selectProvider } from './providers/select';
import { getStore } from './store/db';
import { scrubForLog } from './context/redact';
import {
  blindCompareShape,
  councilConfigShape,
  gptGenerateShape,
  recordOutcomeShape,
  registerCandidateShape,
  routeTaskShape,
  routingStatsShape,
} from './schemas';
import {
  blindCompare,
  councilConfig,
  defaultDeps,
  gptGenerate,
  recordOutcomeTool,
  registerCandidate,
  routeTask,
  routingStats,
  type Deps,
  type ToolResult,
} from './tools';

/**
 * MCP server over stdio.
 *
 * stdout carries the protocol, so nothing else may ever be written there.
 * Every diagnostic goes to stderr, and every diagnostic passes through
 * scrubForLog first.
 */

function log(...parts: unknown[]): void {
  process.stderr.write(`[model-council] ${parts.map((p) => scrubForLog(p)).join(' ')}\n`);
}

/** Renders a tool result for the MCP content channel. */
function render<T>(result: ToolResult<T>): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  // Merge, never overwrite. A tool that carries notes inside its data (route_task
  // does) would otherwise have them silently replaced by the empty envelope list,
  // and the user would lose exactly the line explaining why the mode changed.
  const dataNotes = result.ok
    ? ((result.data as { notes?: unknown })?.notes as string[] | undefined)
    : undefined;
  const notes = [...new Set([...(dataNotes ?? []), ...result.notes])];
  const payload = result.ok
    ? { ok: true, ...(result.data as object), notes }
    : { ok: false, error: result.error, notes };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(result.ok ? {} : { isError: false }),
  };
  // isError stays false: a budget refusal or a missing key is a normal,
  // expected answer that Claude must read and act on, not a transport fault.
}

/**
 * Records which build this process loaded, for the doctor's staleness check.
 *
 * Timestamps cannot answer "is the running server current?" — tsc rewrites
 * dist on every build even when the output is identical. A content hash can,
 * and the running process is the only thing that knows which one it actually
 * loaded. Best effort: a server that cannot write this still serves fine.
 */
function recordRunningBuild(): void {
  try {
    const idFile = path.join(PROJECT_ROOT, 'dist', 'build-id.json');
    const buildId = fs.existsSync(idFile)
      ? (JSON.parse(fs.readFileSync(idFile, 'utf8')) as { build_id?: string }).build_id ?? null
      : null;
    const dir = path.join(PROJECT_ROOT, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'running-build.json'),
      JSON.stringify({ build_id: buildId, pid: process.pid, started_at: new Date().toISOString() }),
      'utf8',
    );
  } catch {
    /* a server that cannot record this still works; the check just degrades */
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  recordRunningBuild();

  // Provider and store are built on first use, not at startup. The host gives
  // a server 30 seconds to complete its handshake, and anything expensive
  // sitting before `connect` spends that budget for no benefit — a server that
  // is merely slow to warm up looks exactly like one that is broken.
  let cached: Deps | null = null;
  let choiceNote: string | null = null;
  const deps = (): Deps => {
    if (!cached) {
      const choice = selectProvider(cfg);
      choiceNote = choice.note;
      cached = {
        cfg,
        provider: choice.provider,
        store: getStore(cfg),
        route: {
          billing: choice.billing,
          billed: choice.billed,
          note: choice.note,
          refuse: choice.refuse,
        },
      };
      log(
        `initialised · route=${choice.provider.id} ·`,
        `gpt=${choice.provider.isAvailable() ? 'available' : 'unavailable'} ·`,
        `store=${cached.store ? 'ok' : 'unavailable'} ·`,
        choice.billing,
      );
      if (choiceNote) log(choiceNote);
    }
    return cached;
  };

  const server = new McpServer(
    { name: 'model-council', version: '1.0.0' },
    {
      instructions: [
        'Model Council lets Claude consult OpenAI GPT models as a second expert.',
        '',
        'Claude runs the process. GPT is a contributor, not a replacement and not a judge of Claude.',
        '',
        'Normal flow:',
        '1. route_task  — decide the working mode and say why, in one sentence, to the user.',
        '2. gpt_generate — when the mode sends work to GPT.',
        '3. blind_compare — when both models produced a candidate. Pass author_a/author_b for the',
        '   record; they are stored but never shown to the judge.',
        '4. record_outcome — later, when a real number comes back. Outcomes outrank the judge.',
        '',
        'Rules that are enforced here, not left to your discretion:',
        '- When Claude and GPT compete, Claude may not declare itself the winner. Use blind_compare.',
        '- A verdict of NEEDS_USER_DECISION must be shown to the user with both candidates. Do not',
        '  pick one on their behalf.',
        '- A hard-constraint failure disqualifies a candidate no matter how good it reads.',
        '- An explicit instruction from the user overrides every routing default.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'route_task',
    {
      title: 'Decide the working mode',
      description:
        'Decides whether a task goes to Claude alone, GPT alone, both in competition, or the user. Returns the mode, a one-sentence reason, and whether a shadow sample was drawn. Costs nothing and calls no API. Call this first for any task where consulting GPT is plausible.',
      inputSchema: routeTaskShape,
    },
    async (args) => render(routeTask(args as never, deps())),
  );

  server.registerTool(
    'gpt_generate',
    {
      title: 'Ask GPT for a candidate',
      description:
        'Sends a minimal context pack to an OpenAI model and returns one candidate plus its assumptions, the facts a human must verify, alternatives it set aside and its confidence. Redacts personal data, refuses restricted material without explicit approval, and enforces the budget. Pass dry_run:true to see exactly what would be sent without spending anything.',
      inputSchema: gptGenerateShape,
    },
    async (args) => render(await gptGenerate(args as never, deps())),
  );

  server.registerTool(
    'blind_compare',
    {
      title: 'Compare two candidates blind',
      description:
        'Scores two candidates against a rubric without telling the judge who wrote either one, with the A/B order randomised. Returns per-criterion scores, hard-constraint failures, the gap, and a verdict of A, B, TIE or NEEDS_USER_DECISION. The verdict is computed from the scores by code — the judge model has no field in which to name a winner. Objective checks you pass in outrank the scores.',
      inputSchema: blindCompareShape,
    },
    async (args) => render(await blindCompare(args as never, deps())),
  );

  server.registerTool(
    'record_outcome',
    {
      title: 'Record a real-world outcome',
      description:
        'Records what actually happened after a candidate was used — CPL, CTR, conversion, lead quality, close rate, cancellations, time to complete, revisions needed, tests passed, or your own rating. An outcome outranks any AI judgement on the same task and is reported separately in the statistics.',
      inputSchema: recordOutcomeShape,
    },
    async (args) => render(recordOutcomeTool(args as never, deps())),
  );

  server.registerTool(
    'routing_stats',
    {
      title: 'Show routing performance',
      description:
        'Performance by task type and model: task counts, win rates from the AI judge and from real outcomes reported separately, ties, how often the decision went to the user, estimated cost, average latency, and Wilson confidence intervals. Rows below the minimum sample size are flagged as too small to act on.',
      inputSchema: routingStatsShape,
    },
    async (args) => render(routingStats(args as never, deps())),
  );

  server.registerTool(
    'council_config',
    {
      title: 'Show the active configuration',
      description:
        'The active models, budgets, routing defaults, evaluation thresholds, privacy policy and installed rubrics, plus current spend and whether GPT is reachable. Contains no secrets.',
      inputSchema: councilConfigShape,
    },
    async (args) => render(councilConfig(args as never, deps())),
  );

  server.registerTool(
    'register_candidate',
    {
      title: "Record Claude's own candidate",
      description:
        "Records a candidate Claude produced so it appears in the history and the statistics alongside GPT's. Call this in COMPETITION mode before blind_compare, and after any Claude-only task whose outcome you intend to record later.",
      inputSchema: registerCandidateShape,
    },
    async (args) => render(registerCandidate(args as never, deps())),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handshake done. Everything costly happens on the first tool call.
  log('ready · provider and store initialise on first use');
}

main().catch((err) => {
  log('fatal:', (err as Error)?.message ?? String(err));
  process.exit(1);
});

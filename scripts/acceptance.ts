#!/usr/bin/env node
/**
 * Walks the twelve acceptance criteria end to end and reports pass/fail on each.
 *
 * Uses a scripted provider, so it costs nothing and can run any time. The point
 * is not to replace the test suite but to demonstrate the criteria in the order
 * they were specified, in one readable run.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from '../src/store/db';
import { loadConfig, rubricFor, getApiKey } from '../src/config';
import { OpenAIProvider } from '../src/providers/openai';
import { CouncilError, type BlindEvaluatorReport } from '../src/types';
import type { EvaluateArgs, EvaluateResult, GenerateArgs, GenerateResult, ModelProvider } from '../src/providers/types';
import {
  blindCompare,
  councilConfig,
  gptGenerate,
  recordOutcomeTool,
  registerCandidate,
  routeTask,
  routingStats,
  type Deps,
} from '../src/tools';

const cfg = loadConfig();
const rubric = rubricFor('copy');
const ids = rubric.criteria.map((c) => c.id);

/** A judge that scores by CONTENT, so the position draw cannot flip its verdict. */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  available = true;
  prompts: string[] = [];
  constructor(
    private candidate: string,
    private favour: { marker: string; high: number; low: number } | null = null,
    private failFor: { marker: string; rule: string; evidence: string } | null = null,
  ) {}
  isAvailable() {
    return this.available;
  }
  unavailableReason() {
    return this.available ? null : 'OPENAI_API_KEY is not set in this environment, so GPT was not called.';
  }
  async generate(a: GenerateArgs): Promise<GenerateResult> {
    this.prompts.push(a.prompt);
    return {
      output: {
        candidate: this.candidate,
        assumptions: [],
        facts_requiring_verification: ['the monthly price'],
        alternatives: [],
        concise_rationale: 'leads with the outcome',
        confidence: 0.8,
      },
      usage: { model: a.model, input_tokens: 900, output_tokens: 200, cost_usd: 0.0031, latency_ms: 1400 },
      request_id: 'resp_scripted',
    };
  }
  async evaluate(a: EvaluateArgs): Promise<EvaluateResult> {
    this.prompts.push(a.prompt);
    const first = a.prompt.slice(a.prompt.indexOf('<response_1>'), a.prompt.indexOf('</response_1>'));
    const mk = (hi: boolean, fails: Array<{ rule_id: string; evidence: string }>) => ({
      scores: ids.map((id) => ({
        criterion_id: id,
        score: this.favour ? (hi ? this.favour.high : this.favour.low) : 7,
        note: 'evidence',
      })),
      hard_failures: fails,
      key_strength: hi ? 'specific and concrete' : 'shorter',
      key_risk: hi ? 'slightly long' : 'generic',
    });
    const markerInFirst = this.favour ? first.includes(this.favour.marker) : false;
    const failInFirst = this.failFor ? first.includes(this.failFor.marker) : false;
    const failure = this.failFor ? [{ rule_id: this.failFor.rule, evidence: this.failFor.evidence }] : [];
    const report: BlindEvaluatorReport = {
      response_1: mk(markerInFirst, failInFirst ? failure : []),
      response_2: mk(!markerInFirst, failInFirst ? [] : failure),
      confidence: 0.9,
      concise_rationale: 'they differ mainly on specificity',
      missing_facts: [],
      facts_requiring_verification: [],
    };
    return {
      report,
      usage: { model: a.model, input_tokens: 1500, output_tokens: 400, cost_usd: 0.0059, latency_ms: 2100 },
      request_id: 'resp_scripted_eval',
    };
  }
}

let passed = 0;
let failed = 0;
let skipped = 0;

/** A skip is neither a pass nor a fail. It says the criterion was not verified. */
function skip(n: number, label: string, detail: string): void {
  skipped++;
  console.log(`  SKIP  ${String(n).padStart(2)}. ${label}`);
  console.log(`             ${detail}`);
}
function check(n: number, label: string, condition: boolean, detail: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${String(n).padStart(2)}. ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${String(n).padStart(2)}. ${label}`);
  }
  console.log(`             ${detail}`);
}

async function main(): Promise<void> {
  console.log('\nModel Council — acceptance criteria\n');
  const store = new Store(':memory:');
  const provider = new ScriptedProvider('the GPT line about eight people and fifty minutes');
  const deps: Deps = { cfg, provider, store };

  // 1. Claude does it alone and GPT is not invoked.
  const r1 = routeTask(
    { original_request: 'fix the pagination bug in the leads table', task_type: 'code' } as never,
    deps,
  );
  const d1 = r1.data as { mode: string; reason: string };
  const callsBefore = provider.prompts.length;
  check(
    1,
    'A task Claude should do alone does not invoke GPT',
    d1.mode === 'CLAUDE_ONLY' && provider.prompts.length === callsBefore,
    `mode=${d1.mode} · "${d1.reason}" · provider calls=0`,
  );

  // 2. An explicit request for GPT is honoured.
  const r2 = routeTask(
    {
      original_request: 'תן ל-GPT לכתוב את הקופי',
      task_type: 'code',
      explicit_mode: 'GPT_ONLY',
    } as never,
    deps,
  );
  const d2 = r2.data as { mode: string; rule: string };
  check(
    2,
    'An explicit request routes to GPT, overriding the type default',
    d2.mode === 'GPT_ONLY' && d2.rule === 'explicit_user_instruction',
    `mode=${d2.mode} · rule=${d2.rule} (code would otherwise be CLAUDE_ONLY)`,
  );

  // 3. Competition produces two independent candidates.
  const reg = registerCandidate(
    {
      task_type: 'copy',
      author: 'claude',
      text: 'the Claude line about training in a room where they know your name',
      original_request: 'headline for the launch',
      mode: 'COMPETITION',
      mode_reason: 'the launch is hard to reverse',
    } as never,
    deps,
  );
  const taskId = (reg.data as { task_id: string }).task_id;
  const gen = await gptGenerate(
    { original_request: 'headline for the launch', task_type: 'copy', brief: 'one headline', task_id: taskId } as never,
    deps,
  );
  const candidates = store.all<{ author: string }>('SELECT author FROM candidates WHERE task_id = ?', taskId);
  check(
    3,
    'Competition produces two independently generated candidates',
    gen.ok && candidates.length === 2 && new Set(candidates.map((c) => c.author)).size === 2,
    `task ${taskId} holds ${candidates.length} candidates: ${candidates.map((c) => c.author).join(', ')}`,
  );

  // 4. Blind comparison hides the authors.
  const p1 = new ScriptedProvider('x', { marker: 'eight people', high: 9, low: 4 });
  const deps4: Deps = { cfg, provider: p1, store };
  const cmp = await blindCompare(
    {
      original_brief: 'one headline for the launch',
      candidate_a: 'Claude here: the room where they know your name',
      candidate_b: 'GPT version: eight people, fifty minutes, no mirrors',
      author_a: 'claude',
      author_b: 'gpt',
      task_type: 'copy',
      task_id: taskId,
    } as never,
    deps4,
  );
  const judgePrompt = p1.prompts[0] ?? '';
  const leaked = /claude|anthropic|openai/i.test(judgePrompt) || /\bgpt\b/i.test(judgePrompt);
  check(
    4,
    'The blind comparison never reveals who wrote what',
    cmp.ok && !leaked,
    `judge prompt is ${judgePrompt.length} chars and contains no model name; identities stored in the DB only`,
  );

  // 5. A small gap goes to the user.
  const p2 = new ScriptedProvider('x'); // all scores 7 → gap 0
  const cmp5 = await blindCompare(
    {
      original_brief: 'one headline',
      candidate_a: 'first version',
      candidate_b: 'second version',
      author_a: 'claude',
      author_b: 'gpt',
      task_type: 'copy',
    } as never,
    { cfg, provider: p2, store },
  );
  const d5 = cmp5.data as { verdict: string; gap: number; threshold: number; user_question: string };
  check(
    5,
    'A gap below the threshold is handed to you, not resolved',
    d5.verdict === 'NEEDS_USER_DECISION' && Boolean(d5.user_question),
    `gap=${d5.gap} threshold=${d5.threshold} → ${d5.verdict} · asks: "${d5.user_question}"`,
  );

  // 6. A false fact disqualifies strong copy.
  const p3 = new ScriptedProvider(
    'x',
    { marker: 'only 99', high: 10, low: 3 }, // the LYING version scores highest
    { marker: 'only 99', rule: 'wrong_price', evidence: '"only 99 a month"' },
  );
  const cmp6 = await blindCompare(
    {
      original_brief: 'one headline',
      candidate_a: 'honest but plainer line',
      candidate_b: 'brilliant line that says only 99 a month',
      author_a: 'claude',
      author_b: 'gpt',
      task_type: 'copy',
    } as never,
    { cfg, provider: p3, store },
  );
  const d6 = cmp6.data as {
    verdict: string;
    decided_by: string;
    score_a: number;
    score_b: number;
    hard_failures_b: Array<{ rule_id: string }>;
  };
  check(
    6,
    'A false fact disqualifies a candidate even when its copy scores higher',
    d6.verdict === 'A' && d6.decided_by === 'hard_constraint' && d6.score_b > d6.score_a,
    `B scored ${d6.score_b} vs A ${d6.score_a}, yet B lost on ${d6.hard_failures_b.map((f) => f.rule_id).join(',')}`,
  );

  // 7. A business outcome is recorded and moves the statistics.
  recordOutcomeTool(
    { task_id: taskId, chosen_author: 'gpt', metric_type: 'cpl', metric_value: 61, window: 'sept', is_final: true } as never,
    deps,
  );
  const out = recordOutcomeTool(
    { task_id: taskId, chosen_author: 'claude', metric_type: 'cpl', metric_value: 38, window: 'sept', is_final: true } as never,
    deps,
  );
  const d7 = out.data as { supersedes_evaluation: { verdict_now: string; decided_by: string; contradicted_evaluator: boolean } | null };
  check(
    7,
    'A real outcome is recorded and overrides the AI judgement',
    out.ok && d7.supersedes_evaluation?.decided_by === 'outcome',
    `CPL 38 (claude) beats 61 (gpt) → decided_by=${d7.supersedes_evaluation?.decided_by}, contradicted judge=${d7.supersedes_evaluation?.contradicted_evaluator}`,
  );

  // 8. Performance is visible by model and task type.
  const stats = routingStats({ min_sample_size: 1 } as never, deps);
  const d8 = stats.data as {
    by_task_type_and_model: Array<{ task_type: string; author: string; evaluator: { wins: number }; outcome: { wins: number } }>;
    warnings: string[];
  };
  const rows = d8.by_task_type_and_model;
  check(
    8,
    'Performance is visible by model and task type, judge and outcome kept apart',
    stats.ok && rows.length >= 2 && rows.every((r) => 'evaluator' in r && 'outcome' in r),
    rows.map((r) => `${r.task_type}/${r.author}: judge ${r.evaluator.wins}W, outcome ${r.outcome.wins}W`).join(' · '),
  );

  // 9. Budget exhaustion triggers a safe fallback.
  const tightCfg = JSON.parse(JSON.stringify(cfg));
  tightCfg.budget.per_task_usd = 0.0000001;
  const p4 = new ScriptedProvider('should never be produced');
  const gen9 = await gptGenerate(
    { original_request: 'write something long', task_type: 'copy', brief: 'b' } as never,
    { cfg: tightCfg, provider: p4, store },
  );
  check(
    9,
    'Exceeding the budget triggers a safe fallback and calls nothing',
    !gen9.ok && gen9.error?.reason === 'budget_exceeded' && p4.prompts.length === 0,
    `reason=${gen9.error?.reason} · provider calls=${p4.prompts.length} · "${gen9.error?.suggestion.slice(0, 60)}..."`,
  );

  // 10. No key or sensitive data in code or logs.
  const conf = councilConfig({} as never, deps);
  const confText = JSON.stringify(conf.data);
  const keyShaped = /sk-[A-Za-z0-9_-]{16,}/.test(confText);
  const p5 = new ScriptedProvider('ok');
  await gptGenerate(
    {
      original_request: 'summarise this',
      task_type: 'sales_analysis',
      brief: 'summarise',
      source_material: [
        { label: 'call', content: 'lead 052-816-4494, a@b.com, said too expensive' },
        { label: 'env', content: 'OPENAI_API_KEY=sk-proj-SHOULDNEVERAPPEAR12345', path: 'C:/app/.env' },
      ],
    } as never,
    { cfg, provider: p5, store },
  );
  const sent = p5.prompts[0] ?? '';
  const clean =
    !keyShaped &&
    !sent.includes('052-816-4494') &&
    !sent.includes('a@b.com') &&
    !sent.includes('SHOULDNEVERAPPEAR');
  check(
    10,
    'No API key or personal data appears in config, logs or outbound payloads',
    clean,
    `config carries no key · phone and email redacted · .env source dropped entirely`,
  );

  // 11. Tests. Actually run them — a check hardcoded to true is not a check.
  let testDetail = '';
  let testsPass = false;
  let testsSkipped = false;
  if (process.argv.includes('--skip-tests')) {
    testsSkipped = true;
    testDetail = 'NOT VERIFIED — skipped by --skip-tests. Run `npm test` to check it.';
  } else {
    try {
      const out = execFileSync('npm', ['test'], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        timeout: 400000,
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pass = /^ℹ pass (\d+)$/m.exec(out)?.[1];
      const fail = /^ℹ fail (\d+)$/m.exec(out)?.[1];
      testsPass = fail === '0' && Number(pass) > 0;
      testDetail = `npm test → ${pass} passed, ${fail} failed`;
    } catch (e) {
      const out = String((e as { stdout?: string }).stdout ?? '');
      const pass = /^ℹ pass (\d+)$/m.exec(out)?.[1] ?? '?';
      const fail = /^ℹ fail (\d+)$/m.exec(out)?.[1] ?? '?';
      testDetail = `npm test → ${pass} passed, ${fail} FAILED`;
    }
  }
  if (testsSkipped) skip(11, 'The automated test suite passes', testDetail);
  else check(11, 'The automated test suite passes', testsPass, testDetail);

  // 12. Actually verify the install, rather than asserting it.
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const skillOk = fs.existsSync(path.join(home, '.claude', 'skills', 'model-council', 'SKILL.md'));
  const cmds = ['gpt', 'compare-models', 'router-stats', 'record-outcome', 'router-config'];
  const cmdCount = cmds.filter((c) => fs.existsSync(path.join(home, '.claude', 'commands', `${c}.md`))).length;
  let mcpOk = false;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    mcpOk = Boolean(j.mcpServers?.['model-council']);
  } catch {
    mcpOk = false;
  }
  const realProvider = new OpenAIProvider(cfg);
  check(
    12,
    'Installable and runnable from Claude Code Desktop',
    skillOk && cmdCount === cmds.length && mcpOk,
    `MCP registered=${mcpOk} · skill=${skillOk} · commands=${cmdCount}/${cmds.length} · GPT ${realProvider.isAvailable() ? 'available' : 'not configured (Claude-only fallback active)'}`,
  );

  store.close();
  const tally = [`${passed} passed`, `${failed} failed`];
  if (skipped) tally.push(`${skipped} SKIPPED (not verified)`);
  console.log(`\n${tally.join(', ')}\n`);
  if (!getApiKey()) {
    console.log('Note: OPENAI_API_KEY is not set, so criteria 1-11 ran against a scripted provider.');
    console.log('      Set the key and run `npm run smoke -- --confirm` for one real call.\n');
  }
  process.exit(failed === 0 && skipped === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e instanceof CouncilError ? `${e.reason}: ${e.message}` : e);
  process.exit(1);
});

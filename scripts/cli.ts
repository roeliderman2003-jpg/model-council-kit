#!/usr/bin/env node
/**
 * Terminal entry point.
 *
 * Everything Model Council does is reachable here, without the MCP transport.
 * That matters for two reasons: the MCP connection is one more thing that can
 * fail between you and the work, and a command you can run by hand is a command
 * you can debug. The tool handlers are exactly the ones the server calls, so
 * this is the same system, not a parallel implementation.
 *
 *   npm run council -- status
 *   npm run council -- route "write the landing page copy"
 *   npm run council -- gpt "write me a headline" --brief "one line, no hype"
 *   npm run council -- compare --brief "..." --a "..." --b "..."
 *   npm run council -- stats
 *   npm run council -- outcome <task_id> --author gpt --metric cpl --value 42 --window "sept"
 *   npm run council -- tasks
 */
import { loadConfig } from '../src/config';
import { selectProvider } from '../src/providers/select';
import { getStore } from '../src/store/db';
import { detectExplicitMode, detectTaskType } from '../src/routing/engine';
import {
  blindCompare,
  councilConfig,
  gptGenerate,
  recordOutcomeTool,
  registerCandidate,
  routeTask,
  routingStats,
  type Deps,
  type ToolResult,
} from '../src/tools';
import type { MetricType, TaskType } from '../src/types';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';

/** Reads `--name value` / `--name=value` / bare `--flag`. */
function opt(name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}
function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
/** First non-flag argument after the command. */
function positional(): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function deps(): Deps {
  const cfg = loadConfig();
  const choice = selectProvider(cfg);
  return { cfg, provider: choice.provider, store: getStore(cfg) };
}

/** Prints a result the way a person reads it, not the way JSON serialises. */
function show<T>(r: ToolResult<T>): number {
  if (!r.ok) {
    console.error(`\nFAILED (${r.error?.reason})\n  ${r.error?.message}`);
    if (r.error?.suggestion) console.error(`  → ${r.error.suggestion}`);
    for (const n of r.notes) console.error(`  note: ${n}`);
    console.error('');
    return 1;
  }
  if (flag('json')) {
    console.log(JSON.stringify({ ...(r.data as object), notes: r.notes }, null, 2));
    return 0;
  }
  return 0;
}

function notes(r: ToolResult<unknown>): void {
  for (const n of r.notes) console.log(`  · ${n}`);
}

async function main(): Promise<number> {
  const d = deps();

  switch (command) {
    case 'status': {
      const choice = selectProvider(d.cfg);
      const r = councilConfig({ section: 'all' } as never, d);
      if (!r.ok) return show(r);
      const c = r.data as {
        models: Record<string, string>;
        budget_now: { spent_today_usd: number; spent_month_usd: number; daily_limit_usd: number };
        store_available: boolean;
        gpt_available: boolean;
      };
      console.log('\nModel Council\n');
      console.log(`  route        ${choice.provider.id}${choice.provider.isAvailable() ? '' : '  (UNAVAILABLE)'}`);
      console.log(`  billing      ${choice.billing}`);
      if (choice.note) console.log(`  note         ${choice.note}`);
      console.log(`  codex model  ${c.models['codex_model']} · effort ${c.models['codex_reasoning_effort']}`);
      console.log(`  api models   generator ${c.models['generator']} · evaluator ${c.models['evaluator']}`);
      console.log(`  spend        $${c.budget_now.spent_today_usd.toFixed(4)} today of $${c.budget_now.daily_limit_usd}`);
      console.log(`  history      ${c.store_available ? 'available' : 'UNAVAILABLE'}`);
      console.log('');
      return 0;
    }

    case 'route': {
      const request = positional();
      if (!request) {
        console.error('\nUsage: npm run council -- route "<what you would ask>"\n');
        return 1;
      }
      const explicit = detectExplicitMode(request);
      const r = routeTask(
        {
          original_request: request,
          task_type: opt('type') || undefined,
          explicit_mode: explicit?.mode,
          high_stakes: flag('high-stakes'),
          irreversible: flag('irreversible'),
          money_impact_ils: opt('money') ? Number(opt('money')) : undefined,
        } as never,
        d,
      );
      if (!r.ok) return show(r);
      const x = r.data as { mode: string; reason: string; task_type: string; shadow: boolean };
      console.log(`\n  mode      ${x.mode}`);
      console.log(`  why       ${x.reason}`);
      console.log(`  detected  ${x.task_type}${explicit ? `  (explicit: ${explicit.reason})` : ''}`);
      if (x.shadow) console.log('  shadow    yes — the second model also answers, for measurement only');
      notes(r);
      console.log('');
      return 0;
    }

    case 'gpt': {
      const request = positional();
      if (!request) {
        console.error('\nUsage: npm run council -- gpt "<request>" --brief "<what it must achieve>"\n');
        console.error('Options: --type <task_type> --fact "..." (repeatable) --dry --json\n');
        return 1;
      }
      const facts = argv.filter((a, i) => argv[i - 1] === '--fact');
      const r = await gptGenerate(
        {
          original_request: request,
          task_type: (opt('type') as TaskType) || detectTaskType(request),
          brief: opt('brief') || request,
          approved_facts: facts.length ? facts : undefined,
          audience: opt('audience') || undefined,
          brand_voice: opt('voice') || undefined,
          sensitivity: (opt('sensitivity') as never) || undefined,
          dry_run: flag('dry'),
        } as never,
        d,
      );
      if (!r.ok || flag('json')) return show(r);
      const x = r.data as {
        dry_run?: boolean;
        prompt_preview?: string;
        candidate?: string;
        task_id?: string;
        facts_requiring_verification?: string[];
        usage?: { cost_usd: number; latency_ms: number };
      };
      if (x.dry_run) {
        console.log('\n--- exactly what would be sent ---\n');
        console.log(x.prompt_preview);
        console.log('\n--- nothing was sent ---\n');
        notes(r);
        return 0;
      }
      console.log(`\n${x.candidate}\n`);
      if (x.facts_requiring_verification?.length) {
        console.log('  verify before shipping:');
        for (const f of x.facts_requiring_verification) console.log(`    - ${f}`);
      }
      console.log(
        `  cost $${x.usage?.cost_usd.toFixed(4)} · ${Math.round((x.usage?.latency_ms ?? 0) / 1000)}s · task ${x.task_id}`,
      );
      notes(r);
      console.log('');
      return 0;
    }

    case 'compare': {
      const brief = opt('brief');
      const a = opt('a');
      const b = opt('b');
      if (!brief || !a || !b) {
        console.error('\nUsage: npm run council -- compare --brief "<brief>" --a "<version A>" --b "<version B>"\n');
        console.error('Options: --type <task_type> --author-a claude --author-b gpt --irreversible --dry --json\n');
        return 1;
      }
      const r = await blindCompare(
        {
          original_brief: brief,
          candidate_a: a,
          candidate_b: b,
          author_a: (opt('author-a') as never) || 'claude',
          author_b: (opt('author-b') as never) || 'gpt',
          task_type: (opt('type') as TaskType) || 'copy',
          irreversible: flag('irreversible'),
          dry_run: flag('dry'),
        } as never,
        d,
      );
      if (!r.ok || flag('json')) return show(r);
      const x = r.data as {
        dry_run?: boolean;
        judge_prompt?: string;
        verdict?: string;
        decided_by?: string;
        score_a?: number;
        score_b?: number;
        gap?: number;
        threshold?: number;
        hard_failures_a?: Array<{ rule_id: string; evidence: string }>;
        hard_failures_b?: Array<{ rule_id: string; evidence: string }>;
        key_strength_a?: string;
        key_strength_b?: string;
        key_risk_a?: string;
        key_risk_b?: string;
        escalation_reasons?: string[];
        user_question?: string | null;
        task_id?: string;
      };
      if (x.dry_run) {
        console.log('\n--- the judge prompt, with no identities in it ---\n');
        console.log(x.judge_prompt);
        console.log('\n--- nothing was sent ---\n');
        return 0;
      }
      console.log(`\n  verdict     ${x.verdict}  (decided by ${x.decided_by})`);
      console.log(`  scores      A ${x.score_a}  ·  B ${x.score_b}  ·  gap ${x.gap} (threshold ${x.threshold})`);
      if (x.hard_failures_a?.length)
        console.log(`  A failed    ${x.hard_failures_a.map((f) => f.rule_id).join(', ')}`);
      if (x.hard_failures_b?.length)
        console.log(`  B failed    ${x.hard_failures_b.map((f) => f.rule_id).join(', ')}`);
      console.log(`\n  A  strength: ${x.key_strength_a}\n     risk:     ${x.key_risk_a}`);
      console.log(`  B  strength: ${x.key_strength_b}\n     risk:     ${x.key_risk_b}`);
      if (x.verdict === 'NEEDS_USER_DECISION') {
        console.log('\n  THIS IS YOURS TO DECIDE:');
        for (const e of x.escalation_reasons ?? []) console.log(`    - ${e}`);
        console.log(`\n  ${x.user_question}`);
      }
      console.log(`\n  task ${x.task_id}`);
      notes(r);
      console.log('');
      return 0;
    }

    case 'register': {
      const text = positional();
      if (!text) {
        console.error('\nUsage: npm run council -- register "<your candidate text>" --type copy\n');
        return 1;
      }
      const r = registerCandidate(
        {
          task_type: (opt('type') as TaskType) || 'copy',
          author: (opt('author') as never) || 'claude',
          text,
          original_request: opt('request') || undefined,
        } as never,
        d,
      );
      if (!r.ok || flag('json')) return show(r);
      const x = r.data as { task_id: string };
      console.log(`\n  recorded · task ${x.task_id}\n`);
      return 0;
    }

    case 'outcome': {
      const taskId = positional();
      const metric = opt('metric');
      const value = opt('value');
      if (!taskId || !metric || value === undefined) {
        console.error(
          '\nUsage: npm run council -- outcome <task_id> --author gpt --metric cpl --value 42 --window "2026-09"\n',
        );
        console.error('Metrics: cpl ctr conversion_rate lead_quality close_rate cancellations');
        console.error('         time_to_complete revisions_needed tests_passed manual_rating');
        console.error('Add --interim for a reading that may still move.\n');
        return 1;
      }
      const r = recordOutcomeTool(
        {
          task_id: taskId,
          chosen_author: (opt('author') as never) || 'gpt',
          metric_type: metric as MetricType,
          metric_value: Number(value),
          window: opt('window') || 'unspecified',
          notes: opt('note') || undefined,
          is_final: !flag('interim'),
        } as never,
        d,
      );
      if (!r.ok || flag('json')) return show(r);
      const x = r.data as {
        supersedes_evaluation: { verdict_now: string; decided_by: string; contradicted_evaluator: boolean } | null;
      };
      console.log('\n  recorded');
      if (x.supersedes_evaluation?.contradicted_evaluator) {
        console.log(
          `  reality disagreed with the judge — ${x.supersedes_evaluation.verdict_now} now stands, by ${x.supersedes_evaluation.decided_by}`,
        );
      }
      notes(r);
      console.log('');
      return 0;
    }

    case 'stats': {
      const r = routingStats(
        {
          task_type: opt('type') || undefined,
          window_days: opt('days') ? Number(opt('days')) : undefined,
          min_sample_size: opt('min') ? Number(opt('min')) : undefined,
        } as never,
        d,
      );
      if (!r.ok || flag('json')) return show(r);
      const x = r.data as {
        totals: { tasks: number; comparisons: number; user_decisions: number; outcomes_recorded: number; cost_usd: number };
        by_task_type_and_model: Array<{
          task_type: string;
          author: string;
          tasks: number;
          evaluator: { wins: number; losses: number; ties: number };
          outcome: { wins: number; losses: number; ties: number };
          evaluator_win_rate: { rate: number | null; insufficient_sample: boolean; n: number };
        }>;
        warnings: string[];
      };
      console.log(
        `\n  ${x.totals.tasks} tasks · ${x.totals.comparisons} comparisons · ${x.totals.user_decisions} sent to you · ${x.totals.outcomes_recorded} outcomes · $${x.totals.cost_usd}\n`,
      );
      console.log('  task type            model    n   judge W/L/T   outcome W/L/T   judge rate');
      console.log('  ' + '-'.repeat(76));
      for (const row of x.by_task_type_and_model) {
        const rate =
          row.evaluator_win_rate.rate === null
            ? '   —'
            : `${Math.round(row.evaluator_win_rate.rate * 100)}%${row.evaluator_win_rate.insufficient_sample ? ' (n too small)' : ''}`;
        console.log(
          `  ${row.task_type.padEnd(20)} ${row.author.padEnd(8)} ${String(row.tasks).padStart(3)}   ` +
            `${row.evaluator.wins}/${row.evaluator.losses}/${row.evaluator.ties}`.padEnd(14) +
            `${row.outcome.wins}/${row.outcome.losses}/${row.outcome.ties}`.padEnd(16) +
            rate,
        );
      }
      if (x.warnings.length) {
        console.log('');
        for (const w of x.warnings) console.log(`  ! ${w}`);
      }
      console.log('');
      return 0;
    }

    case 'tasks': {
      if (!d.store) {
        console.error('\nHistory is unavailable, so there are no tasks to list.\n');
        return 1;
      }
      const rows = d.store.all<{
        id: string;
        created_at: string;
        task_type: string;
        mode: string;
        request_excerpt: string | null;
      }>('SELECT id, created_at, task_type, mode, request_excerpt FROM tasks ORDER BY created_at DESC LIMIT ?', Number(opt('limit') || 15));
      console.log('');
      for (const r of rows) {
        console.log(`  ${r.id}  ${r.created_at.slice(0, 16).replace('T', ' ')}  ${r.task_type.padEnd(18)} ${r.mode}`);
        if (r.request_excerpt) console.log(`      ${r.request_excerpt.slice(0, 90)}`);
      }
      console.log(rows.length ? '' : '  (no tasks recorded yet)\n');
      return 0;
    }

    default: {
      console.log(`
Model Council — terminal interface

  status                          which route is active, what it costs, current spend
  route "<request>"               which mode this task gets, and why. Costs nothing.
  gpt "<request>" --brief "..."   ask GPT for one candidate      (--dry to see the payload)
  compare --brief --a --b         blind comparison               (--dry to see the judge prompt)
  register "<text>"               record your own candidate
  outcome <task_id> --metric cpl --value 42 --window "2026-09"
  stats                           performance by task type and model
  tasks                           recent task ids

Add --json to any command for the raw result.

Everything here is the same code the MCP server runs, so it works whether or not
the MCP connection does.
`);
      return command === 'help' ? 0 : 1;
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  });

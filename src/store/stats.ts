import type { Store } from './db';
import type { Author, MetricType } from '../types';
import { METRIC_DIRECTION } from '../types';

/**
 * Statistics over the history.
 *
 * Two rules shape this file:
 *
 * 1. Evaluator wins and outcome wins are counted SEPARATELY and never summed.
 *    An AI judgement and a real CPL are not the same evidence, so a combined
 *    "win rate" would launder the weaker one into the stronger.
 *
 * 2. Every rate carries its sample size and a Wilson interval. Below the
 *    configured minimum the row is marked `insufficient_sample` and must not
 *    be used to justify a routing change.
 */

export interface WinRecord {
  n: number;
  wins: number;
  losses: number;
  ties: number;
  user_decisions: number;
}

export interface RateWithInterval {
  rate: number | null;
  low: number | null;
  high: number | null;
  n: number;
  insufficient_sample: boolean;
}

/** Wilson score interval — honest at small n, unlike a naive proportion. */
export function wilson(successes: number, total: number, z = 1.96): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 1 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

export function rateOf(successes: number, total: number, minSample: number): RateWithInterval {
  if (total === 0) {
    return { rate: null, low: null, high: null, n: 0, insufficient_sample: true };
  }
  const { low, high } = wilson(successes, total);
  return {
    rate: successes / total,
    low,
    high,
    n: total,
    insufficient_sample: total < minSample,
  };
}

export interface ModelTaskStats {
  task_type: string;
  author: Author;
  tasks: number;
  /** Comparisons this author took part in that the evaluator settled. */
  evaluator: WinRecord;
  /** Comparisons settled by a recorded real-world outcome. */
  outcome: WinRecord;
  cost_usd: number;
  avg_latency_ms: number | null;
  evaluator_win_rate: RateWithInterval;
  outcome_win_rate: RateWithInterval;
}

export interface StatsReport {
  generated_at: string;
  min_sample_size: number;
  window_days: number | null;
  totals: {
    tasks: number;
    comparisons: number;
    user_decisions: number;
    outcomes_recorded: number;
    cost_usd: number;
  };
  by_task_type_and_model: ModelTaskStats[];
  by_month: Array<{ month: string; tasks: number; cost_usd: number; comparisons: number }>;
  warnings: string[];
}

interface EvalJoin {
  task_type: string;
  author_a: Author;
  author_b: Author;
  verdict: string;
  decided_by: string;
}

interface OutcomeJoin {
  task_id: string;
  task_type: string;
  chosen_author: Author;
  metric_type: MetricType;
  metric_value: number;
  is_final: number;
}

function emptyRecord(): WinRecord {
  return { n: 0, wins: 0, losses: 0, ties: 0, user_decisions: 0 };
}

/**
 * An outcome decides a comparison only when both sides of the same task have a
 * recorded value for the SAME metric. One value on its own says a candidate was
 * used, not that it beat anything.
 */
function outcomeWinners(rows: OutcomeJoin[]): Map<string, { winner: Author | null; authors: Author[] }> {
  const byTaskMetric = new Map<string, OutcomeJoin[]>();
  for (const r of rows) {
    const key = `${r.task_id}::${r.metric_type}`;
    const list = byTaskMetric.get(key) ?? [];
    list.push(r);
    byTaskMetric.set(key, list);
  }
  const out = new Map<string, { winner: Author | null; authors: Author[] }>();
  for (const [key, list] of byTaskMetric) {
    const authors = [...new Set(list.map((r) => r.chosen_author))];
    if (authors.length < 2) {
      out.set(key, { winner: null, authors });
      continue;
    }
    const first = list[0]!;
    const dir = METRIC_DIRECTION[first.metric_type] ?? 'higher_is_better';
    // Best value per author, then compare the two bests.
    const best = new Map<Author, number>();
    for (const r of list) {
      const cur = best.get(r.chosen_author);
      if (cur === undefined) best.set(r.chosen_author, r.metric_value);
      else best.set(r.chosen_author, dir === 'higher_is_better' ? Math.max(cur, r.metric_value) : Math.min(cur, r.metric_value));
    }
    const entries = [...best.entries()];
    entries.sort((x, y) => (dir === 'higher_is_better' ? y[1] - x[1] : x[1] - y[1]));
    const [top, second] = entries;
    if (!top || !second) {
      out.set(key, { winner: null, authors });
      continue;
    }
    out.set(key, { winner: top[1] === second[1] ? null : top[0], authors });
  }
  return out;
}

export function buildStats(
  store: Store,
  opts: { minSampleSize: number; windowDays?: number | null; taskType?: string } = { minSampleSize: 12 },
): StatsReport {
  const warnings: string[] = [];
  const since =
    opts.windowDays && opts.windowDays > 0
      ? new Date(Date.now() - opts.windowDays * 86400000).toISOString()
      : null;

  const taskWhere: string[] = [];
  const taskParams: unknown[] = [];
  if (since) {
    taskWhere.push('t.created_at >= ?');
    taskParams.push(since);
  }
  if (opts.taskType) {
    taskWhere.push('t.task_type = ?');
    taskParams.push(opts.taskType);
  }
  const whereSql = taskWhere.length ? `WHERE ${taskWhere.join(' AND ')}` : '';

  const totalTasks =
    store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks t ${whereSql}`, ...taskParams)?.n ?? 0;

  const totalCost =
    store.get<{ c: number | null }>(
      `SELECT SUM(u.cost_usd) AS c FROM usage_log u JOIN tasks t ON t.id = u.task_id ${whereSql}`,
      ...taskParams,
    )?.c ?? 0;

  const evals = store.all<EvalJoin>(
    `SELECT t.task_type, e.author_a, e.author_b, e.verdict, e.decided_by
       FROM evaluations e JOIN tasks t ON t.id = e.task_id ${whereSql}`,
    ...taskParams,
  );

  const outcomeRows = store.all<OutcomeJoin>(
    `SELECT o.task_id, t.task_type, o.chosen_author, o.metric_type, o.metric_value, o.is_final
       FROM outcomes o JOIN tasks t ON t.id = o.task_id ${whereSql}`,
    ...taskParams,
  );

  const participation = store.all<{ task_type: string; author: Author; n: number; cost: number | null; lat: number | null }>(
    `SELECT t.task_type, c.author, COUNT(*) AS n, SUM(c.cost_usd) AS cost, AVG(NULLIF(c.latency_ms,0)) AS lat
       FROM candidates c JOIN tasks t ON t.id = c.task_id ${whereSql}
       GROUP BY t.task_type, c.author`,
    ...taskParams,
  );

  const key = (taskType: string, author: Author) => `${taskType}::${author}`;
  const acc = new Map<string, ModelTaskStats>();

  const ensure = (taskType: string, author: Author): ModelTaskStats => {
    const k = key(taskType, author);
    let row = acc.get(k);
    if (!row) {
      row = {
        task_type: taskType,
        author,
        tasks: 0,
        evaluator: emptyRecord(),
        outcome: emptyRecord(),
        cost_usd: 0,
        avg_latency_ms: null,
        evaluator_win_rate: rateOf(0, 0, opts.minSampleSize),
        outcome_win_rate: rateOf(0, 0, opts.minSampleSize),
      };
      acc.set(k, row);
    }
    return row;
  };

  for (const p of participation) {
    const row = ensure(p.task_type, p.author);
    row.tasks = p.n;
    row.cost_usd = p.cost ?? 0;
    row.avg_latency_ms = p.lat ?? null;
  }

  let userDecisions = 0;
  for (const e of evals) {
    const rowA = ensure(e.task_type, e.author_a);
    const rowB = ensure(e.task_type, e.author_b);
    // Only evaluator-settled comparisons feed the evaluator record. A verdict
    // that a hard constraint or an objective check produced is recorded under
    // its own authority and is not evidence about model quality.
    if (e.verdict === 'NEEDS_USER_DECISION') {
      userDecisions++;
      rowA.evaluator.user_decisions++;
      rowB.evaluator.user_decisions++;
      continue;
    }
    if (e.decided_by !== 'evaluator') continue;
    rowA.evaluator.n++;
    rowB.evaluator.n++;
    if (e.verdict === 'TIE') {
      rowA.evaluator.ties++;
      rowB.evaluator.ties++;
    } else if (e.verdict === 'A') {
      rowA.evaluator.wins++;
      rowB.evaluator.losses++;
    } else if (e.verdict === 'B') {
      rowB.evaluator.wins++;
      rowA.evaluator.losses++;
    }
  }

  const winners = outcomeWinners(outcomeRows);
  const taskTypeById = new Map(outcomeRows.map((r) => [r.task_id, r.task_type]));
  for (const [k, v] of winners) {
    const taskId = k.split('::')[0]!;
    const taskType = taskTypeById.get(taskId);
    if (!taskType) continue;
    if (v.authors.length < 2) continue;
    for (const author of v.authors) {
      const row = ensure(taskType, author);
      row.outcome.n++;
      if (v.winner === null) row.outcome.ties++;
      else if (v.winner === author) row.outcome.wins++;
      else row.outcome.losses++;
    }
  }

  const list = [...acc.values()];
  for (const row of list) {
    const evalDecided = row.evaluator.wins + row.evaluator.losses + row.evaluator.ties;
    row.evaluator_win_rate = rateOf(row.evaluator.wins, evalDecided, opts.minSampleSize);
    const outDecided = row.outcome.wins + row.outcome.losses + row.outcome.ties;
    row.outcome_win_rate = rateOf(row.outcome.wins, outDecided, opts.minSampleSize);
  }
  list.sort((a, b) => a.task_type.localeCompare(b.task_type) || a.author.localeCompare(b.author));

  const byMonth = store.all<{ month: string; tasks: number; cost: number | null; comparisons: number }>(
    `SELECT substr(t.created_at,1,7) AS month,
            COUNT(DISTINCT t.id) AS tasks,
            (SELECT COUNT(*) FROM evaluations e WHERE substr(e.created_at,1,7) = substr(t.created_at,1,7)) AS comparisons,
            (SELECT SUM(u.cost_usd) FROM usage_log u WHERE u.month = substr(t.created_at,1,7)) AS cost
       FROM tasks t ${whereSql}
       GROUP BY month ORDER BY month DESC`,
    ...taskParams,
  );

  const underpowered = list.filter((r) => r.evaluator_win_rate.insufficient_sample && r.evaluator_win_rate.n > 0);
  if (underpowered.length) {
    warnings.push(
      `${underpowered.length} of ${list.length} rows are below the minimum sample size of ${opts.minSampleSize}. Do not change routing on them.`,
    );
  }
  if (outcomeRows.length === 0) {
    warnings.push('No real-world outcomes recorded yet. Every win rate here is an AI judgement, which is the weakest evidence in the ladder.');
  }
  if (totalTasks === 0) {
    warnings.push('No tasks in this window.');
  }

  return {
    generated_at: new Date().toISOString(),
    min_sample_size: opts.minSampleSize,
    window_days: opts.windowDays ?? null,
    totals: {
      tasks: totalTasks,
      comparisons: evals.length,
      user_decisions: userDecisions,
      outcomes_recorded: outcomeRows.length,
      cost_usd: Number((totalCost ?? 0).toFixed(4)),
    },
    by_task_type_and_model: list,
    by_month: byMonth.map((m) => ({
      month: m.month,
      tasks: m.tasks,
      cost_usd: Number((m.cost ?? 0).toFixed(4)),
      comparisons: m.comparisons,
    })),
    warnings,
  };
}

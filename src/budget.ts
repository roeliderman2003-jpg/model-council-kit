import type { CouncilConfig } from './config';
import { CouncilError, type Usage } from './types';
import type { Store } from './store/db';
import { callsOnTask, spentOnTask, spentThisMonth, spentToday } from './store/repo';

/**
 * Budget guard.
 *
 * Every check runs BEFORE the call, and every check names the specific limit it
 * hit, so a refusal is diagnosable. When the store is unavailable the guard
 * degrades to per-call limits only and says so — it never silently permits an
 * unlimited spend, and it never blocks work Claude can do alone.
 */

export interface BudgetSnapshot {
  spent_today_usd: number;
  spent_month_usd: number;
  spent_task_usd: number;
  calls_on_task: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  per_task_limit_usd: number;
  max_calls_per_workflow: number;
  /** True when the store could not be read, so the figures are unknown. */
  degraded: boolean;
}

export function snapshot(cfg: CouncilConfig, store: Store | null, taskId?: string): BudgetSnapshot {
  const base = {
    daily_limit_usd: cfg.budget.daily_usd,
    monthly_limit_usd: cfg.budget.monthly_usd,
    per_task_limit_usd: cfg.budget.per_task_usd,
    max_calls_per_workflow: cfg.budget.max_calls_per_workflow,
  };
  if (!store) {
    return {
      ...base,
      spent_today_usd: 0,
      spent_month_usd: 0,
      spent_task_usd: 0,
      calls_on_task: 0,
      degraded: true,
    };
  }
  return {
    ...base,
    spent_today_usd: spentToday(store),
    spent_month_usd: spentThisMonth(store),
    spent_task_usd: taskId ? spentOnTask(store, taskId) : 0,
    calls_on_task: taskId ? callsOnTask(store, taskId) : 0,
    degraded: false,
  };
}

/** Estimated cost of a call, before it is made. */
export function estimateCost(
  cfg: CouncilConfig,
  model: string,
  inputChars: number,
  maxOutputTokens: number,
): { usd: number; approximate: boolean; input_tokens_est: number; output_tokens_est: number } {
  const price = cfg.pricing_usd_per_1m_tokens[model] ?? cfg.pricing_usd_per_1m_tokens['default'];
  const approximate = !cfg.pricing_usd_per_1m_tokens[model];
  // ~4 characters per token is the usual English ratio; Hebrew runs denser, so
  // this under-estimates Hebrew input. Treated as a floor, not a promise.
  const inputTokens = Math.ceil(inputChars / 3.5);
  const usd =
    (inputTokens / 1_000_000) * (price?.input ?? 1.25) +
    (maxOutputTokens / 1_000_000) * (price?.output ?? 10);
  return {
    usd: Number(usd.toFixed(5)),
    approximate,
    input_tokens_est: inputTokens,
    output_tokens_est: maxOutputTokens,
  };
}

export function actualCost(cfg: CouncilConfig, model: string, inputTokens: number, outputTokens: number): number {
  const price = cfg.pricing_usd_per_1m_tokens[model] ?? cfg.pricing_usd_per_1m_tokens['default'];
  const usd =
    (inputTokens / 1_000_000) * (price?.input ?? 1.25) +
    (outputTokens / 1_000_000) * (price?.output ?? 10);
  return Number(usd.toFixed(6));
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: 'budget_exceeded' | 'call_limit_exceeded';
  message?: string;
  snapshot: BudgetSnapshot;
  estimate_usd: number;
  estimate_approximate: boolean;
  /** True when the estimate is above warn_estimate_usd and deserves a heads-up. */
  warn: boolean;
}

/**
 * Decides whether one provider call may proceed.
 *
 * The estimate is added to the running total before comparing, so a single
 * large call cannot step over a limit it was already close to.
 */
export function checkBudget(
  cfg: CouncilConfig,
  store: Store | null,
  args: { model: string; inputChars: number; maxOutputTokens: number; taskId?: string },
): BudgetCheckResult {
  const snap = snapshot(cfg, store, args.taskId);
  const est = estimateCost(cfg, args.model, args.inputChars, args.maxOutputTokens);
  const warn = est.usd >= cfg.budget.warn_estimate_usd;

  const deny = (reason: 'budget_exceeded' | 'call_limit_exceeded', message: string): BudgetCheckResult => ({
    allowed: false,
    reason,
    message,
    snapshot: snap,
    estimate_usd: est.usd,
    estimate_approximate: est.approximate,
    warn,
  });

  if (args.taskId && snap.calls_on_task >= cfg.budget.max_calls_per_workflow) {
    return deny(
      'call_limit_exceeded',
      `This task has already made ${snap.calls_on_task} provider calls, at the limit of ${cfg.budget.max_calls_per_workflow}. No further calls will be made for it.`,
    );
  }

  if (est.usd > cfg.budget.per_task_usd) {
    return deny(
      'budget_exceeded',
      `A single call is estimated at $${est.usd.toFixed(4)}, over the per-task cap of $${cfg.budget.per_task_usd}.`,
    );
  }

  if (args.taskId && snap.spent_task_usd + est.usd > cfg.budget.per_task_usd) {
    return deny(
      'budget_exceeded',
      `This task has spent $${snap.spent_task_usd.toFixed(4)}; another $${est.usd.toFixed(4)} would exceed the per-task cap of $${cfg.budget.per_task_usd}.`,
    );
  }

  if (!snap.degraded && snap.spent_today_usd + est.usd > cfg.budget.daily_usd) {
    return deny(
      'budget_exceeded',
      `Today's spend is $${snap.spent_today_usd.toFixed(4)}; another $${est.usd.toFixed(4)} would exceed the daily cap of $${cfg.budget.daily_usd}.`,
    );
  }

  if (!snap.degraded && snap.spent_month_usd + est.usd > cfg.budget.monthly_usd) {
    return deny(
      'budget_exceeded',
      `This month's spend is $${snap.spent_month_usd.toFixed(4)}; another $${est.usd.toFixed(4)} would exceed the monthly cap of $${cfg.budget.monthly_usd}.`,
    );
  }

  return {
    allowed: true,
    snapshot: snap,
    estimate_usd: est.usd,
    estimate_approximate: est.approximate,
    warn,
  };
}

/** Turns a denial into the error the tools surface. */
export function budgetError(check: BudgetCheckResult): CouncilError {
  return new CouncilError(
    check.reason ?? 'budget_exceeded',
    check.message ?? 'Budget exceeded.',
    'Claude continues on its own; GPT was not called. Raise the cap in config/local.json, or wait for the next period.',
    {
      spent_today_usd: check.snapshot.spent_today_usd,
      spent_month_usd: check.snapshot.spent_month_usd,
      daily_limit_usd: check.snapshot.daily_limit_usd,
      monthly_limit_usd: check.snapshot.monthly_limit_usd,
    },
  );
}

export function usageFrom(
  cfg: CouncilConfig,
  model: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
): Usage {
  return {
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: actualCost(cfg, model, inputTokens, outputTokens),
    latency_ms: latencyMs,
  };
}

import { loadConfig, loadRubrics, rubricFor, type CouncilConfig } from '../config';
import { budgetError, checkBudget, snapshot } from '../budget';
import { buildContextPack, type ContextPackInput } from '../context/builder';
import { redactPii, scrubForLog } from '../context/redact';
import { buildBlindPrompt, choosePositions, runBlindCompare } from '../judge/blind';
import { applyOutcomeOverEvaluation } from '../judge/scoring';
import { decideRoute, detectTaskType, type RouteDecision } from '../routing/engine';
import type { ModelProvider } from '../providers/types';
import { getStore, getStoreFailure, type Store } from '../store/db';
import {
  createTask,
  getEvaluations,
  getOutcomes,
  getTask,
  recordCandidate,
  recordEvaluation,
  recordOutcome,
  recordUsage,
} from '../store/repo';
import { buildStats } from '../store/stats';
import { CouncilError, type Author, type RouteMode, type Sensitivity, type TaskType } from '../types';
import type {
  BlindCompareInput,
  GptGenerateInput,
  RecordOutcomeInput,
  RegisterCandidateInput,
  RouteTaskInput,
  RoutingStatsInput,
} from '../schemas';

/**
 * Tool handlers.
 *
 * Written as plain async functions taking an explicit dependency bag, so the
 * tests exercise the same code the MCP server runs — no transport, no mocks of
 * our own layers, only the provider swapped for a fake.
 */

/** Bumped whenever a prompt template changes, so history stays interpretable. */
export const PROMPT_VERSION = '1.0.0';

export interface Deps {
  cfg: CouncilConfig;
  provider: ModelProvider;
  store: Store | null;
  /**
   * Why this route was chosen and what it costs. Present so a tool can refuse
   * to spend money the user did not ask to spend, and so the billing line
   * reaches the response rather than only a log.
   */
  route?: {
    billing: string;
    billed: boolean;
    note: string | null;
    refuse: { reason: string; suggestion: string } | null;
  };
}

export function defaultDeps(provider: ModelProvider, cfg = loadConfig()): Deps {
  return { cfg, provider, store: getStore(cfg) };
}

/**
 * Per-route call settings.
 *
 * Codex runs an agent loop rather than a single completion, so it is much
 * slower — and it costs nothing, which makes a generous timeout the cheap
 * choice. Its model is configured separately because the subscription is tuned
 * for Codex's own default, and naming an API model there would be wrong.
 */
function callSettings(
  deps: Deps,
  tier: 'generator' | 'evaluator' | 'fast',
): { model: string; timeoutMs: number; isCodex: boolean } {
  const isCodex = deps.provider.id === 'codex';
  // The judge must not be the writer. A model scoring its own output shows a
  // measured self-preference, and blinding removes the identity signal but not
  // a stylistic affinity for text that reads the way it writes. Both models sit
  // on the same subscription, so this costs nothing.
  const codexModel =
    tier === 'evaluator'
      ? deps.cfg.models.codex_evaluator_model || deps.cfg.models.codex_model
      : deps.cfg.models.codex_model;
  return {
    model: isCodex ? codexModel : deps.cfg.models[tier],
    timeoutMs: isCodex ? deps.cfg.budget.codex_timeout_ms : deps.cfg.budget.timeout_ms,
    isCodex,
  };
}

/** Every tool returns this envelope. A failure is data, never a thrown crash. */
export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    reason: string;
    message: string;
    suggestion: string;
    detail?: Record<string, unknown>;
  };
  /** Non-blocking notes the caller should show the user. */
  notes: string[];
}

function fail(err: unknown, notes: string[] = []): ToolResult<never> {
  if (err instanceof CouncilError) {
    return {
      ok: false,
      error: { reason: err.reason, message: err.message, suggestion: err.suggestion, detail: err.detail },
      notes,
    };
  }
  return {
    ok: false,
    error: {
      reason: 'bad_input',
      message: scrubForLog((err as Error)?.message ?? String(err)),
      suggestion: 'Check the inputs and try again.',
    },
    notes,
  };
}

function ok<T>(data: T, notes: string[] = []): ToolResult<T> {
  return { ok: true, data, notes };
}

/** Store notes so a degraded store is visible rather than silent. */
function storeNotes(store: Store | null): string[] {
  if (store) return [];
  const f = getStoreFailure();
  return [
    `History is unavailable${f ? `: ${f.message}` : ''}. The work still runs; only statistics and outcome recording are affected.`,
  ];
}

// ---------------------------------------------------------------------------
// route_task
// ---------------------------------------------------------------------------

export interface RouteTaskOutput {
  mode: RouteMode;
  reason: string;
  shadow: boolean;
  rule: string;
  task_type: TaskType;
  notes: string[];
  gpt_available: boolean;
  gpt_unavailable_reason: string | null;
}

export function routeTask(input: RouteTaskInput, deps: Deps): ToolResult<RouteTaskOutput> {
  try {
    const taskType = (input.task_type ?? detectTaskType(input.original_request)) as TaskType;
    const decision: RouteDecision = decideRoute(
      {
        task_type: taskType,
        original_request: input.original_request,
        explicit_mode: input.explicit_mode ?? null,
        high_stakes: input.high_stakes,
        irreversible: input.irreversible,
        money_impact_ils: input.money_impact_ils,
        shadow_seed: input.shadow_seed,
      },
      deps.cfg,
    );

    const available = deps.provider.isAvailable();
    const notes = [...decision.notes];
    if (!available && decision.mode !== 'CLAUDE_ONLY') {
      notes.push(
        `${deps.provider.unavailableReason()} Falling back to CLAUDE_ONLY so the work still gets done.`,
      );
    }

    // The reason must describe what will ACTUALLY happen. Appending the
    // fallback to the original sentence produced "Both models will answer
    // independently ... (GPT unavailable, so Claude handles it)", which states
    // two contradictory things and reads as a bug to whoever sees it.
    const effectiveMode: RouteMode = available ? decision.mode : 'CLAUDE_ONLY';
    const reason =
      available || decision.mode === 'CLAUDE_ONLY'
        ? decision.reason
        : `Claude handles it alone because GPT is unavailable. It would otherwise be ${decision.mode}: ${decision.reason}`;

    return ok(
      {
        mode: effectiveMode,
        reason,
        shadow: available ? decision.shadow : false,
        rule: decision.rule,
        task_type: taskType,
        notes,
        gpt_available: available,
        gpt_unavailable_reason: deps.provider.unavailableReason(),
      },
      notes,
    );
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// gpt_generate
// ---------------------------------------------------------------------------

export interface GptGenerateOutput {
  task_id: string;
  candidate: string;
  assumptions: string[];
  facts_requiring_verification: string[];
  alternatives: string[];
  concise_rationale: string;
  confidence: number;
  usage: { model: string; input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number };
  request_id: string | null;
  sensitivity: Sensitivity;
  redactions: Array<{ kind: string; count: number }>;
  blocked_sources: string[];
  truncated_sources: string[];
  sent_to_gpt: boolean;
  budget_after: ReturnType<typeof snapshot>;
}

export interface DryRunOutput {
  dry_run: true;
  task_type: string;
  sensitivity: Sensitivity;
  model: string;
  prompt_preview: string;
  prompt_chars: number;
  estimated_cost_usd: number;
  estimate_approximate: boolean;
  redactions: Array<{ kind: string; count: number }>;
  blocked_sources: string[];
  truncated_sources: string[];
  sent_to_gpt: false;
}

export async function gptGenerate(
  input: GptGenerateInput,
  deps: Deps,
): Promise<ToolResult<GptGenerateOutput | DryRunOutput>> {
  const notes = storeNotes(deps.store);
  try {
    const packInput: ContextPackInput = {
      original_request: input.original_request,
      task_type: input.task_type,
      brief: input.brief,
      approved_facts: input.approved_facts,
      constraints: input.constraints,
      audience: input.audience,
      brand_voice: input.brand_voice,
      source_material: input.source_material,
      desired_output: input.desired_output,
      sensitivity: input.sensitivity,
      max_output_length: input.max_output_length,
    };

    const rubric = rubricFor(input.task_type, input.rubric);
    packInput.success_criteria = rubric.criteria.map((c) => `${c.label}: ${c.description}`);

    const pack = buildContextPack(packInput, deps.cfg, {
      approvedRestricted: input.approve_restricted === true,
    });

    if (pack.blocked_sources.length) {
      notes.push(
        `${pack.blocked_sources.length} source(s) were dropped because they match the blocked list: ${pack.blocked_sources.join(', ')}.`,
      );
    }
    if (pack.truncated_sources.length) {
      notes.push(`Truncated to fit the size cap: ${pack.truncated_sources.join(', ')}.`);
    }
    if (pack.redactions.length) {
      notes.push(
        `Redacted before sending: ${pack.redactions.map((r) => `${r.count} ${r.kind}`).join(', ')}.`,
      );
    }

    const call = callSettings(deps, input.model_tier === 'fast' ? 'fast' : 'generator');
    const model = call.model;
    const maxOut = input.max_output_length ?? deps.cfg.budget.max_output_tokens;

    if (input.dry_run) {
      const est = checkBudget(deps.cfg, deps.store, {
        model,
        inputChars: pack.char_count,
        maxOutputTokens: maxOut,
        taskId: input.task_id,
      });
      return ok<DryRunOutput>(
        {
          dry_run: true,
          task_type: input.task_type,
          sensitivity: pack.input.sensitivity,
          model,
          prompt_preview: pack.rendered,
          prompt_chars: pack.char_count,
          estimated_cost_usd: est.estimate_usd,
          estimate_approximate: est.estimate_approximate,
          redactions: pack.redactions,
          blocked_sources: pack.blocked_sources,
          truncated_sources: pack.truncated_sources,
          sent_to_gpt: false,
        },
        [...notes, 'Dry run: nothing was sent to OpenAI and nothing was charged.'],
      );
    }

    // Refuse before spending. `auto` prefers the free route; if it cannot be
    // reached, quietly billing the API instead is the one failure mode the user
    // explicitly did not want.
    if (deps.route?.refuse) {
      throw new CouncilError(
        'provider_unavailable',
        deps.route.refuse.reason,
        deps.route.refuse.suggestion,
      );
    }

    if (!deps.provider.isAvailable()) {
      throw new CouncilError(
        'no_api_key',
        deps.provider.unavailableReason() ?? 'The provider is unavailable.',
        'Claude continues on its own. Set OPENAI_API_KEY and restart Claude Code to enable GPT.',
      );
    }

    const budget = checkBudget(deps.cfg, deps.store, {
      model,
      inputChars: pack.char_count,
      maxOutputTokens: maxOut,
      taskId: input.task_id,
    });
    if (!budget.allowed) throw budgetError(budget);
    if (call.isCodex) {
      notes.push(
        'Routed through the Codex CLI on your ChatGPT plan — no API charge. It draws on plan rate limit, which is shared with interactive Codex.',
      );
    } else if (deps.route?.billed) {
      // A charge must never be inferable only from a log line.
      notes.push(`BILLED CALL — ${deps.route.billing}`);
      if (deps.route.note) notes.push(deps.route.note);
    }
    if (budget.warn) {
      notes.push(
        `Estimated cost of this call is about $${budget.estimate_usd.toFixed(3)}${budget.estimate_approximate ? ' (approximate: no price on file for this model)' : ''}.`,
      );
    }

    // Open or reuse the task row before the call, so a failed call is still
    // attributable and its spend still lands against the right task.
    let taskId = input.task_id ?? '';
    if (deps.store) {
      if (taskId && !getTask(deps.store, taskId)) taskId = '';
      if (!taskId) {
        taskId = createTask(deps.store, {
          task_type: input.task_type,
          mode: 'GPT_ONLY',
          mode_reason: 'gpt_generate called directly',
          sensitivity: pack.input.sensitivity,
          irreversible: false,
          high_stakes: false,
          prompt_version: PROMPT_VERSION,
          config_version: deps.cfg.config_version,
          input_hash: pack.hash,
          request_excerpt: redactPii(input.original_request.slice(0, 300)).text,
        });
      }
    } else {
      taskId = taskId || 'task_unstored';
    }

    const res = await deps.provider.generate({
      model,
      prompt: pack.rendered,
      maxOutputTokens: maxOut,
      timeoutMs: call.timeoutMs,
      retries: deps.cfg.budget.retries,
      requestLabel: `gpt_generate:${taskId}`,
    });

    if (deps.store) {
      recordUsage(deps.store, { ...res.usage, task_id: taskId, purpose: 'generate' });
      recordCandidate(deps.store, {
        task_id: taskId,
        author: 'gpt',
        model,
        text: res.output.candidate,
        usage: res.usage,
        storeContent: deps.cfg.privacy.store_full_content,
      });
    }

    return ok<GptGenerateOutput>(
      {
        task_id: taskId,
        candidate: res.output.candidate,
        assumptions: res.output.assumptions,
        facts_requiring_verification: res.output.facts_requiring_verification,
        alternatives: res.output.alternatives,
        concise_rationale: res.output.concise_rationale,
        confidence: res.output.confidence,
        usage: res.usage,
        request_id: res.request_id,
        sensitivity: pack.input.sensitivity,
        redactions: pack.redactions,
        blocked_sources: pack.blocked_sources,
        truncated_sources: pack.truncated_sources,
        sent_to_gpt: true,
        budget_after: snapshot(deps.cfg, deps.store, taskId),
      },
      notes,
    );
  } catch (err) {
    return fail(err, notes);
  }
}

// ---------------------------------------------------------------------------
// blind_compare
// ---------------------------------------------------------------------------

export async function blindCompare(input: BlindCompareInput, deps: Deps): Promise<ToolResult<unknown>> {
  const notes = storeNotes(deps.store);
  try {
    const taskType = (input.task_type ?? 'other') as TaskType;
    const rubric = rubricFor(taskType, input.rubric);

    if (input.dry_run) {
      const seed = input.randomization_seed ?? 'dry-run-seed';
      const position = choosePositions(seed);
      const built = buildBlindPrompt({
        original_brief: input.original_brief,
        rubric,
        weights: input.weights,
        hard_constraints: input.hard_constraints,
        candidate_a: input.candidate_a,
        candidate_b: input.candidate_b,
        position,
      });
      return ok(
        {
          dry_run: true,
          rubric: rubric.id,
          rubric_version: rubric.version,
          seed,
          position_map: position.map,
          judge_prompt: built.prompt,
          prompt_chars: built.prompt.length,
          stripped_tells: built.stripped_tells,
          sent_to_gpt: false,
        },
        [...notes, 'Dry run: the judge prompt is shown but nothing was sent or charged.'],
      );
    }

    if (!deps.provider.isAvailable()) {
      throw new CouncilError(
        'no_api_key',
        deps.provider.unavailableReason() ?? 'The provider is unavailable.',
        'Both candidates are preserved. Compare them yourself, or set OPENAI_API_KEY to enable the blind judge.',
      );
    }

    const model = callSettings(deps, 'evaluator').model;
    const approxChars = input.original_brief.length + input.candidate_a.length + input.candidate_b.length + 2000;
    const budget = checkBudget(deps.cfg, deps.store, {
      model,
      inputChars: approxChars,
      maxOutputTokens: deps.cfg.budget.max_output_tokens,
      taskId: input.task_id,
    });
    if (!budget.allowed) throw budgetError(budget);

    let taskId = input.task_id ?? '';
    if (deps.store) {
      if (taskId && !getTask(deps.store, taskId)) taskId = '';
      if (!taskId) {
        taskId = createTask(deps.store, {
          task_type: taskType,
          mode: 'COMPETITION',
          mode_reason: 'blind_compare called directly',
          sensitivity: 'internal',
          irreversible: input.irreversible === true,
          high_stakes: input.irreversible === true,
          prompt_version: PROMPT_VERSION,
          config_version: deps.cfg.config_version,
          input_hash: 'compare',
          request_excerpt: redactPii(input.original_brief.slice(0, 300)).text,
        });
      }
    } else {
      taskId = taskId || 'task_unstored';
    }

    const run = await runBlindCompare({
      task_id: taskId,
      provider: deps.provider,
      cfg: deps.cfg,
      rubric,
      original_brief: input.original_brief,
      candidate_a: input.candidate_a,
      candidate_b: input.candidate_b,
      weights: input.weights,
      hard_constraints: input.hard_constraints,
      objective_checks: input.objective_checks?.map((c) => ({
        id: c.id,
        label: c.label,
        favours: c.favours,
        passed_a: c.passed_a ?? null,
        passed_b: c.passed_b ?? null,
        detail: c.detail,
      })),
      decision_threshold: input.decision_threshold,
      randomization_seed: input.randomization_seed,
      force_user_decision:
        input.irreversible === true && deps.cfg.evaluation.escalate_when_irreversible,
      allow_tie: input.allow_tie,
      missing_critical_facts: input.missing_critical_facts,
      model,
    });

    if (run.stripped_tells.length) {
      notes.push(
        `Removed ${run.stripped_tells.length} self-identifying phrase(s) from the candidates before the judge saw them.`,
      );
    }

    if (deps.store) {
      recordUsage(deps.store, { ...run.usage, task_id: taskId, purpose: 'evaluate' });
      recordEvaluation(deps.store, {
        task_id: taskId,
        evaluator_model: model,
        rubric_id: rubric.id,
        rubric_version: rubric.version,
        seed: run.position.seed,
        position_map: run.position.map,
        author_a: (input.author_a ?? 'other') as Author,
        author_b: (input.author_b ?? 'other') as Author,
        result: run.result,
      });
    }

    const r = run.result;
    return ok(
      {
        task_id: taskId,
        verdict: r.verdict,
        decided_by: r.decided_by,
        score_a: r.score_a,
        score_b: r.score_b,
        gap: r.gap,
        threshold: r.threshold,
        confidence: r.confidence,
        per_criterion: r.per_criterion,
        hard_failures_a: r.hard_failures_a,
        hard_failures_b: r.hard_failures_b,
        key_strength_a: r.key_strength_a,
        key_strength_b: r.key_strength_b,
        key_risk_a: r.key_risk_a,
        key_risk_b: r.key_risk_b,
        concise_rationale: r.concise_rationale,
        missing_facts: r.missing_facts,
        facts_requiring_verification: r.facts_requiring_verification,
        escalation_reasons: r.escalation_reasons,
        user_question: r.user_question,
        objective_checks: r.objective_checks,
        rubric: rubric.id,
        rubric_version: rubric.version,
        seed: run.position.seed,
        judge_saw_identities: false,
        usage: run.usage,
        request_id: run.request_id,
        budget_after: snapshot(deps.cfg, deps.store, taskId),
      },
      notes,
    );
  } catch (err) {
    return fail(err, notes);
  }
}

// ---------------------------------------------------------------------------
// record_outcome
// ---------------------------------------------------------------------------

export function recordOutcomeTool(input: RecordOutcomeInput, deps: Deps): ToolResult<unknown> {
  const notes = storeNotes(deps.store);
  try {
    if (!deps.store) {
      throw new CouncilError(
        'store_unavailable',
        'The history database is unavailable, so this outcome cannot be recorded.',
        'Fix the data directory and record it again; the number is not lost if you keep it to hand.',
      );
    }
    const task = getTask(deps.store, input.task_id);
    if (!task) {
      throw new CouncilError(
        'bad_input',
        `No task with id ${input.task_id}.`,
        'Use the task_id reported when the work was produced. `routing_stats` lists recent task ids.',
      );
    }

    const outcomeId = recordOutcome(deps.store, {
      task_id: input.task_id,
      chosen_author: input.chosen_author,
      metric_type: input.metric_type,
      metric_value: input.metric_value,
      window: input.window,
      notes: input.notes,
      is_final: input.is_final,
    });

    const evals = getEvaluations(deps.store, input.task_id);
    const latest = evals[evals.length - 1];
    const all = getOutcomes(deps.store, input.task_id);

    // An outcome settles the comparison only when both sides have a value for
    // the same metric. One value means a candidate was used, not that it won.
    const sameMetric = all.filter((o) => o.metric_type === input.metric_type);
    const authors = [...new Set(sameMetric.map((o) => o.chosen_author))];
    let supersedes = null as null | {
      verdict_now: string | null;
      decided_by: string;
      contradicted_evaluator: boolean;
    };

    if (authors.length >= 2 && latest) {
      const dir = input.metric_type;
      const higherIsBetter = !['cpl', 'cancellations', 'time_to_complete', 'revisions_needed'].includes(dir);
      const best = new Map<string, number>();
      for (const o of sameMetric) {
        const cur = best.get(o.chosen_author);
        if (cur === undefined) best.set(o.chosen_author, o.metric_value);
        else
          best.set(
            o.chosen_author,
            higherIsBetter ? Math.max(cur, o.metric_value) : Math.min(cur, o.metric_value),
          );
      }
      const sorted = [...best.entries()].sort((x, y) => (higherIsBetter ? y[1] - x[1] : x[1] - y[1]));
      const winner = sorted[0] && sorted[1] && sorted[0][1] !== sorted[1][1] ? sorted[0][0] : null;
      const evaluatorWinner =
        latest.verdict === 'A' ? latest.author_a : latest.verdict === 'B' ? latest.author_b : null;
      supersedes = applyOutcomeOverEvaluation({
        evaluator_verdict: latest.verdict as never,
        evaluator_winner_author: evaluatorWinner,
        outcome_winner_author: winner,
      });
      if (supersedes.contradicted_evaluator) {
        notes.push(
          `Reality disagreed with the judge on this task: the evaluator preferred ${evaluatorWinner}, the measured ${input.metric_type} favours ${winner}. The outcome stands.`,
        );
      }
    } else {
      notes.push(
        `Recorded. Only ${authors.length} side has a ${input.metric_type} value for this task, so it does not yet settle a comparison — record the other side's number to make it decisive.`,
      );
    }

    if (!input.is_final) {
      notes.push('Marked as interim. Record the final reading when the window closes.');
    }

    return ok(
      {
        outcome_id: outcomeId,
        task_id: input.task_id,
        task_type: task.task_type,
        recorded: {
          chosen_author: input.chosen_author,
          metric_type: input.metric_type,
          metric_value: input.metric_value,
          window: input.window,
          is_final: input.is_final,
        },
        supersedes_evaluation: supersedes,
        outcomes_on_task: all.length,
      },
      notes,
    );
  } catch (err) {
    return fail(err, notes);
  }
}

// ---------------------------------------------------------------------------
// routing_stats
// ---------------------------------------------------------------------------

export function routingStats(input: RoutingStatsInput, deps: Deps): ToolResult<unknown> {
  const notes = storeNotes(deps.store);
  try {
    if (!deps.store) {
      throw new CouncilError(
        'store_unavailable',
        'The history database is unavailable, so there are no statistics to show.',
        'Check that the data directory is writable.',
      );
    }
    const report = buildStats(deps.store, {
      minSampleSize: input.min_sample_size ?? deps.cfg.routing.min_sample_size_for_routing_change,
      windowDays: input.window_days ?? null,
      taskType: input.task_type,
    });
    if (!deps.cfg.routing.auto_routing_changes_enabled) {
      notes.push(
        'Automatic routing changes are off, so these numbers inform you and change nothing on their own.',
      );
    }
    return ok(report, notes);
  } catch (err) {
    return fail(err, notes);
  }
}

// ---------------------------------------------------------------------------
// council_config
// ---------------------------------------------------------------------------

export function councilConfig(input: { section?: string }, deps: Deps): ToolResult<unknown> {
  try {
    const cfg = deps.cfg;
    const rubrics = [...loadRubrics().values()].map((r) => ({
      id: r.id,
      version: r.version,
      label: r.label,
      applies_to: r.applies_to,
      criteria: r.criteria.map((c) => ({ id: c.id, label: c.label, weight: c.weight, subjective: !!c.subjective })),
      hard_failures: r.hard_failures.map((h) => h.id),
      decision_threshold: r.decision_threshold,
      min_confidence: r.min_confidence,
    }));

    const all = {
      config_version: cfg.config_version,
      prompt_version: PROMPT_VERSION,
      models: {
        // The route decides which of these actually matters. Showing only the
        // API model names hid the fact that the Codex route was running on a
        // different model entirely — the one question this section exists to
        // answer.
        provider_setting: cfg.models.provider,
        active_route: deps.provider.id,
        codex_model: cfg.models.codex_model || '(Codex default)',
        codex_evaluator_model:
          cfg.models.codex_evaluator_model || cfg.models.codex_model || '(Codex default)',
        judge_differs_from_writer:
          Boolean(cfg.models.codex_evaluator_model) &&
          cfg.models.codex_evaluator_model !== cfg.models.codex_model,
        codex_reasoning_effort: cfg.models.codex_reasoning_effort || '(Codex default)',
        generator: cfg.models.generator,
        evaluator: cfg.models.evaluator,
        fast: cfg.models.fast,
      },
      budget: cfg.budget,
      routing: cfg.routing,
      evaluation: cfg.evaluation,
      privacy: {
        ...cfg.privacy,
        // Show the policy, not the patterns' contents, to keep this readable.
        blocked_path_patterns: cfg.privacy.blocked_path_patterns,
      },
      rubrics,
      gpt_available: deps.provider.isAvailable(),
      gpt_unavailable_reason: deps.provider.unavailableReason(),
      budget_now: snapshot(cfg, deps.store),
      store_available: deps.store !== null,
    };

    const section = input.section ?? 'all';
    if (section === 'all') return ok(all);
    const picked = (all as Record<string, unknown>)[section];
    if (picked === undefined) {
      throw new CouncilError('bad_input', `Unknown section "${section}".`, 'Use one of: all, models, budget, routing, evaluation, privacy, rubrics.');
    }
    return ok({ [section]: picked, config_version: cfg.config_version });
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------------------
// register_candidate — lets Claude's own work enter the record
// ---------------------------------------------------------------------------

export function registerCandidate(input: RegisterCandidateInput, deps: Deps): ToolResult<unknown> {
  const notes = storeNotes(deps.store);
  try {
    if (!deps.store) {
      throw new CouncilError(
        'store_unavailable',
        'The history database is unavailable, so this candidate was not recorded.',
        'The work itself is unaffected; only the statistics lose this data point.',
      );
    }
    let taskId = input.task_id ?? '';
    if (taskId && !getTask(deps.store, taskId)) taskId = '';
    if (!taskId) {
      taskId = createTask(deps.store, {
        task_type: input.task_type,
        mode: (input.mode ?? 'CLAUDE_ONLY') as RouteMode,
        mode_reason: input.mode_reason ?? 'registered by Claude',
        sensitivity: 'internal',
        irreversible: false,
        high_stakes: false,
        prompt_version: PROMPT_VERSION,
        config_version: deps.cfg.config_version,
        input_hash: 'registered',
        request_excerpt: input.original_request
          ? redactPii(input.original_request.slice(0, 300)).text
          : undefined,
      });
    }
    const candidateId = recordCandidate(deps.store, {
      task_id: taskId,
      author: input.author,
      model: input.author === 'claude' ? 'claude-code' : input.author,
      text: input.text,
      storeContent: deps.cfg.privacy.store_full_content,
    });
    return ok({ task_id: taskId, candidate_id: candidateId, author: input.author }, notes);
  } catch (err) {
    return fail(err, notes);
  }
}

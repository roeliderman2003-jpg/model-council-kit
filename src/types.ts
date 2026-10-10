/**
 * Core domain types for Model Council.
 *
 * The three concerns the system must never blur are separate types here and
 * separate tables in the store:
 *
 *   Generator  -> Candidate      (who produced what)
 *   Evaluator  -> Evaluation     (blind scoring of candidates)
 *   Outcome    -> Outcome        (what actually happened in the real world)
 *
 * An Evaluation may never write into a Candidate, and an Outcome always
 * outranks an Evaluation when the two disagree.
 */

/** Which side produced a candidate. Never reaches the judge. */
export type Author = 'claude' | 'gpt' | 'user' | 'other';

/** How much a payload may be exposed to a third-party API. */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** Working modes the router can select. */
export type RouteMode =
  | 'CLAUDE_ONLY'
  | 'GPT_ONLY'
  | 'COMPETITION'
  | 'GPT_CRITIQUE'
  | 'USER_DECIDES';

/** Broad task families used for routing defaults and rubric selection. */
export type TaskType =
  | 'code'
  | 'architecture'
  | 'tests'
  | 'ops'
  | 'feature_spec'
  | 'copy'
  | 'marketing_angle'
  | 'value_proposition'
  | 'sales_analysis'
  | 'qualitative_analysis'
  | 'research_summary'
  // General work, which is most work. These exist so the system is useful
  // for a decision, a plan or an explanation and not only for marketing.
  | 'decision'
  | 'writing'
  | 'planning'
  | 'explanation'
  | 'naming'
  | 'translation'
  | 'small_rewrite'
  | 'other';

/** Verdict of a comparison. Computed by code, never chosen by a model. */
export type Verdict = 'A' | 'B' | 'TIE' | 'NEEDS_USER_DECISION';

/** Which authority settled a task. Ordered by precedence, low index wins. */
export type DecidedBy =
  | 'hard_constraint'
  | 'objective_check'
  | 'outcome'
  | 'evaluator'
  | 'user'
  | 'undecided';

/** Precedence ladder. A lower number outranks a higher one. */
export const DECISION_PRECEDENCE: Record<DecidedBy, number> = {
  hard_constraint: 1,
  objective_check: 2,
  outcome: 3,
  evaluator: 4,
  user: 5,
  undecided: 99,
};

/** A single scored dimension inside a rubric. */
export interface RubricCriterion {
  id: string;
  label: string;
  /** Relative weight. Weights are normalised at scoring time. */
  weight: number;
  /** Guidance shown to the evaluator. */
  description: string;
  /** True when this criterion is a matter of taste rather than fact. */
  subjective?: boolean;
}

/** A condition that disqualifies a candidate outright, regardless of score. */
export interface HardFailureRule {
  id: string;
  label: string;
  description: string;
}

export interface Rubric {
  id: string;
  version: string;
  label: string;
  applies_to: TaskType[];
  criteria: RubricCriterion[];
  hard_failures: HardFailureRule[];
  /**
   * Minimum weighted-point gap (0-10 scale) required to declare a winner.
   * Below this the verdict becomes NEEDS_USER_DECISION.
   */
  decision_threshold: number;
  /** Minimum evaluator confidence (0-1) required to declare a winner. */
  min_confidence: number;
  /**
   * When the combined weight of subjective criteria exceeds this fraction, the
   * outcome is treated as a taste call and escalated to the user.
   */
  subjective_escalation_ratio: number;
}

/** A produced answer, attributable to exactly one author. */
export interface Candidate {
  author: Author;
  model: string;
  text: string;
  assumptions?: string[];
  facts_requiring_verification?: string[];
  alternatives?: string[];
  concise_rationale?: string;
  confidence?: number;
}

/** Per-criterion scores the evaluator returns for one anonymous response. */
export interface CriterionScore {
  criterion_id: string;
  /** 0-10. */
  score: number;
  note: string;
}

/** A hard-failure the evaluator flagged, with the evidence for it. */
export interface HardFailureFinding {
  rule_id: string;
  evidence: string;
}

/** The evaluator's raw, identity-blind report for a single response. */
export interface BlindResponseReport {
  scores: CriterionScore[];
  hard_failures: HardFailureFinding[];
  key_strength: string;
  key_risk: string;
}

/**
 * The complete blind report. Note there is no `winner` field: the evaluator is
 * not permitted to name one. Position 1 / 2 map back to A / B outside its view.
 */
export interface BlindEvaluatorReport {
  response_1: BlindResponseReport;
  response_2: BlindResponseReport;
  /** 0-1. */
  confidence: number;
  concise_rationale: string;
  missing_facts: string[];
  facts_requiring_verification: string[];
}

/** An objective, non-model signal (a test run, a lint pass, a measurement). */
export interface ObjectiveCheck {
  id: string;
  label: string;
  /** Which side the check favours, or null when it is inconclusive. */
  favours: 'A' | 'B' | 'neither' | null;
  passed_a: boolean | null;
  passed_b: boolean | null;
  detail?: string;
}

/** The computed comparison result. */
export interface ComparisonResult {
  task_id: string;
  verdict: Verdict;
  decided_by: DecidedBy;
  /** Weighted 0-10 score for each side after hard failures are applied. */
  score_a: number;
  score_b: number;
  /** |score_a - score_b| before disqualification. */
  gap: number;
  threshold: number;
  confidence: number;
  per_criterion: Array<{
    criterion_id: string;
    label: string;
    weight: number;
    score_a: number;
    score_b: number;
    note_a: string;
    note_b: string;
  }>;
  hard_failures_a: HardFailureFinding[];
  hard_failures_b: HardFailureFinding[];
  key_strength_a: string;
  key_strength_b: string;
  key_risk_a: string;
  key_risk_b: string;
  concise_rationale: string;
  missing_facts: string[];
  facts_requiring_verification: string[];
  /** Populated whenever the verdict is NEEDS_USER_DECISION. */
  escalation_reasons: string[];
  /** The exact question the user has to settle. */
  user_question: string | null;
  objective_checks: ObjectiveCheck[];
}

/** Real-world result recorded after a candidate was actually used. */
export type MetricType =
  // General — usable for any task, and the honest default. `was_used` is the
  // simplest real signal there is: did you ship it, or rewrite it?
  | 'was_used'
  | 'manual_rating'
  | 'revisions_needed'
  | 'time_to_complete'
  | 'rework_minutes'
  // Engineering
  | 'tests_passed'
  | 'defects_found'
  // Marketing and sales funnel
  | 'cpl'
  | 'ctr'
  | 'conversion_rate'
  | 'lead_quality'
  | 'close_rate'
  | 'cancellations';

/** Whether a higher metric value is better or worse. */
export const METRIC_DIRECTION: Record<MetricType, 'higher_is_better' | 'lower_is_better'> = {
  was_used: 'higher_is_better',
  manual_rating: 'higher_is_better',
  revisions_needed: 'lower_is_better',
  time_to_complete: 'lower_is_better',
  rework_minutes: 'lower_is_better',
  tests_passed: 'higher_is_better',
  defects_found: 'lower_is_better',
  cpl: 'lower_is_better',
  ctr: 'higher_is_better',
  conversion_rate: 'higher_is_better',
  lead_quality: 'higher_is_better',
  close_rate: 'higher_is_better',
  cancellations: 'lower_is_better',
};

export interface Outcome {
  task_id: string;
  chosen_author: Author;
  metric_type: MetricType;
  metric_value: number;
  window: string;
  notes?: string;
  is_final: boolean;
}

/** Token and money usage for one provider call. */
export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

/** Structured error surface. Every failure path returns one of these. */
export type FailureReason =
  | 'no_api_key'
  | 'provider_unavailable'
  | 'timeout'
  | 'budget_exceeded'
  | 'call_limit_exceeded'
  | 'invalid_output'
  | 'blocked_source'
  | 'restricted_needs_approval'
  | 'payload_too_large'
  | 'store_unavailable'
  | 'bad_input';

export class CouncilError extends Error {
  constructor(
    public readonly reason: FailureReason,
    message: string,
    public readonly suggestion: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CouncilError';
  }
}

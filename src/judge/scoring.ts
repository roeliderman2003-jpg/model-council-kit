import type {
  BlindEvaluatorReport,
  ComparisonResult,
  DecidedBy,
  HardFailureFinding,
  ObjectiveCheck,
  Rubric,
  Verdict,
} from '../types';

/**
 * Verdict arithmetic.
 *
 * The evaluator model supplies per-criterion scores and hard-failure findings.
 * It is never asked which candidate wins, and its output has no field in which
 * it could say so. The winner is computed here, from weights the user controls,
 * in a pure function with no model call in it.
 *
 * That is what makes the neutrality tests meaningful: they can flip the inputs
 * and assert on the arithmetic without a network round trip.
 *
 * Precedence, highest first:
 *   1. hard constraints   — a disqualification outranks any score
 *   2. objective checks   — a test result outranks an opinion
 *   3. evaluator scores   — only when 1 and 2 are silent
 *   4. the user           — whenever 3 is not decisive enough to act on
 *
 * (Real-world outcomes sit between 2 and 3 in the ladder but arrive later in
 * time; they are applied by record_outcome, which supersedes a stored verdict.)
 */

export interface ScoreInput {
  task_id: string;
  rubric: Rubric;
  report: BlindEvaluatorReport;
  objective_checks?: ObjectiveCheck[];
  /** Overrides the rubric's own threshold when supplied. */
  decision_threshold?: number;
  min_confidence?: number;
  /** Escalate regardless of gap; set for irreversible or high-impact work. */
  force_user_decision?: boolean;
  /** Allow a TIE verdict instead of escalating when the gap is under threshold. */
  allow_tie?: boolean;
  /** Facts the caller knows are missing; forces escalation when non-empty. */
  missing_critical_facts?: string[];
  escalate_when_objective_checks_disagree?: boolean;
  escalate_when_missing_facts?: boolean;
}

function clamp010(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

/** Weighted 0-10 total. Weights are normalised so a rubric edit cannot skew the scale. */
export function weightedScore(
  rubric: Rubric,
  scores: ReadonlyArray<{ criterion_id: string; score: number }>,
): number {
  const totalWeight = rubric.criteria.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) return 0;
  let acc = 0;
  for (const c of rubric.criteria) {
    const found = scores.find((s) => s.criterion_id === c.id);
    // A criterion the evaluator skipped counts as mid-scale rather than zero,
    // so a missing answer cannot masquerade as a damning one.
    const value = found ? clamp010(found.score) : 5;
    acc += value * (c.weight / totalWeight);
  }
  return Number(acc.toFixed(4));
}

/** Combined weight fraction of criteria the rubric marks as taste. */
export function subjectiveWeightRatio(rubric: Rubric): number {
  const total = rubric.criteria.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return 0;
  const subjective = rubric.criteria.filter((c) => c.subjective).reduce((s, c) => s + c.weight, 0);
  return subjective / total;
}

/** Drops findings whose rule id is not in the rubric, so a model cannot invent a disqualifier. */
function validFailures(rubric: Rubric, findings: readonly HardFailureFinding[]): HardFailureFinding[] {
  const known = new Set(rubric.hard_failures.map((h) => h.id));
  return findings.filter((f) => known.has(f.rule_id) && f.evidence && f.evidence.trim().length > 0);
}

export interface ObjectiveVerdict {
  favours: 'A' | 'B' | null;
  conflicting: boolean;
  detail: string;
}

/** Reduces the objective checks to a single signal, or reports that they conflict. */
export function reduceObjectiveChecks(checks: readonly ObjectiveCheck[]): ObjectiveVerdict {
  const forA = checks.filter((c) => c.favours === 'A');
  const forB = checks.filter((c) => c.favours === 'B');
  if (forA.length > 0 && forB.length > 0) {
    return {
      favours: null,
      conflicting: true,
      detail: `${forA.length} objective check(s) favour A and ${forB.length} favour B.`,
    };
  }
  if (forA.length > 0) return { favours: 'A', conflicting: false, detail: forA.map((c) => c.label).join('; ') };
  if (forB.length > 0) return { favours: 'B', conflicting: false, detail: forB.map((c) => c.label).join('; ') };
  return { favours: null, conflicting: false, detail: '' };
}

export function computeComparison(input: ScoreInput): ComparisonResult {
  const { rubric, report } = input;
  const threshold = input.decision_threshold ?? rubric.decision_threshold;
  const minConfidence = input.min_confidence ?? rubric.min_confidence;
  const checks = input.objective_checks ?? [];

  const scoreA = weightedScore(rubric, report.response_1.scores);
  const scoreB = weightedScore(rubric, report.response_2.scores);
  const gap = Number(Math.abs(scoreA - scoreB).toFixed(4));

  const failuresA = validFailures(rubric, report.response_1.hard_failures);
  const failuresB = validFailures(rubric, report.response_2.hard_failures);

  const perCriterion = rubric.criteria.map((c) => {
    const a = report.response_1.scores.find((s) => s.criterion_id === c.id);
    const b = report.response_2.scores.find((s) => s.criterion_id === c.id);
    return {
      criterion_id: c.id,
      label: c.label,
      weight: c.weight,
      score_a: a ? clamp010(a.score) : 5,
      score_b: b ? clamp010(b.score) : 5,
      note_a: a?.note ?? '(not scored)',
      note_b: b?.note ?? '(not scored)',
    };
  });

  const escalation: string[] = [];
  let verdict: Verdict = 'NEEDS_USER_DECISION';
  let decidedBy: DecidedBy = 'undecided';
  let userQuestion: string | null = null;

  const base = {
    task_id: input.task_id,
    score_a: scoreA,
    score_b: scoreB,
    gap,
    threshold,
    confidence: report.confidence,
    per_criterion: perCriterion,
    hard_failures_a: failuresA,
    hard_failures_b: failuresB,
    key_strength_a: report.response_1.key_strength,
    key_strength_b: report.response_2.key_strength,
    key_risk_a: report.response_1.key_risk,
    key_risk_b: report.response_2.key_risk,
    concise_rationale: report.concise_rationale,
    missing_facts: [...(report.missing_facts ?? []), ...(input.missing_critical_facts ?? [])],
    facts_requiring_verification: report.facts_requiring_verification ?? [],
    objective_checks: [...checks],
  };

  // ---- 1. Hard constraints. A disqualification beats any score. ----------
  if (failuresA.length > 0 && failuresB.length === 0) {
    return {
      ...base,
      verdict: 'B',
      decided_by: 'hard_constraint',
      escalation_reasons: [],
      user_question: null,
      concise_rationale: `A is disqualified: ${failuresA.map((f) => f.rule_id).join(', ')}. ${report.concise_rationale}`,
    };
  }
  if (failuresB.length > 0 && failuresA.length === 0) {
    return {
      ...base,
      verdict: 'A',
      decided_by: 'hard_constraint',
      escalation_reasons: [],
      user_question: null,
      concise_rationale: `B is disqualified: ${failuresB.map((f) => f.rule_id).join(', ')}. ${report.concise_rationale}`,
    };
  }
  if (failuresA.length > 0 && failuresB.length > 0) {
    return {
      ...base,
      verdict: 'NEEDS_USER_DECISION',
      decided_by: 'undecided',
      escalation_reasons: ['Both candidates violate a hard constraint, so neither can be shipped as written.'],
      user_question:
        'Both versions break a hard rule. Do you want one of them fixed, a fresh attempt with a tighter brief, or the constraint changed?',
    };
  }

  // ---- 2. Objective checks. A measurement beats an opinion. --------------
  const objective = reduceObjectiveChecks(checks);
  if (objective.conflicting && (input.escalate_when_objective_checks_disagree ?? true)) {
    escalation.push(`Objective checks disagree — ${objective.detail}`);
  } else if (objective.favours) {
    return {
      ...base,
      verdict: objective.favours,
      decided_by: 'objective_check',
      escalation_reasons: [],
      user_question: null,
      concise_rationale: `Settled by objective check: ${objective.detail}.`,
    };
  }

  // ---- 3. Conditions that must go to the user regardless of the scores ----
  if (input.force_user_decision) {
    escalation.push('The task is marked irreversible or high impact, so the call is yours.');
  }
  if (gap < threshold) {
    escalation.push(
      `The gap is ${gap.toFixed(2)} points on a 0-10 scale, under the ${threshold} threshold — too close to call.`,
    );
  }
  if (report.confidence < minConfidence) {
    escalation.push(
      `Evaluator confidence is ${report.confidence.toFixed(2)}, under the ${minConfidence} minimum.`,
    );
  }
  const subjectiveRatio = subjectiveWeightRatio(rubric);
  if (subjectiveRatio > rubric.subjective_escalation_ratio && gap < threshold * 2) {
    escalation.push(
      `${Math.round(subjectiveRatio * 100)}% of this rubric's weight is taste and brand voice, which is your call rather than a judge's.`,
    );
  }
  if ((input.escalate_when_missing_facts ?? true) && base.missing_facts.length > 0) {
    escalation.push(`Facts are missing: ${base.missing_facts.slice(0, 3).join('; ')}.`);
  }

  if (escalation.length === 0) {
    verdict = scoreA > scoreB ? 'A' : 'B';
    decidedBy = 'evaluator';
  } else if (input.allow_tie && gap < threshold && escalation.length === 1) {
    // Only the closeness reason fired, and the caller said a tie is acceptable.
    verdict = 'TIE';
    decidedBy = 'evaluator';
  } else {
    verdict = 'NEEDS_USER_DECISION';
    decidedBy = 'undecided';
    const leaning = gap === 0 ? 'neither' : scoreA > scoreB ? 'A' : 'B';
    userQuestion =
      leaning === 'neither'
        ? 'The two versions score identically. Which one reads right to you, and on what grounds?'
        : `${leaning} scores slightly higher (${Math.max(scoreA, scoreB).toFixed(2)} vs ${Math.min(scoreA, scoreB).toFixed(2)}), but not by enough to settle it. Which do you want to ship?`;
  }

  return {
    ...base,
    verdict,
    decided_by: decidedBy,
    escalation_reasons: escalation,
    user_question: userQuestion,
  };
}

/**
 * Applies a recorded real-world outcome over a stored evaluator verdict.
 *
 * Returns the verdict that now stands and whether reality contradicted the
 * judge — the contradiction is the interesting signal, so it is surfaced rather
 * than quietly overwritten.
 */
export function applyOutcomeOverEvaluation(args: {
  evaluator_verdict: Verdict;
  evaluator_winner_author: string | null;
  outcome_winner_author: string | null;
}): { verdict_now: string | null; decided_by: DecidedBy; contradicted_evaluator: boolean } {
  if (!args.outcome_winner_author) {
    return {
      verdict_now: args.evaluator_winner_author,
      decided_by: args.evaluator_verdict === 'NEEDS_USER_DECISION' ? 'undecided' : 'evaluator',
      contradicted_evaluator: false,
    };
  }
  const contradicted =
    args.evaluator_winner_author !== null &&
    args.evaluator_winner_author !== args.outcome_winner_author;
  return {
    verdict_now: args.outcome_winner_author,
    decided_by: 'outcome',
    contradicted_evaluator: contradicted,
  };
}

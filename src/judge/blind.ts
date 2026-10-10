import * as crypto from 'node:crypto';
import type { CouncilConfig } from '../config';
import type { BlindEvaluatorReport, ComparisonResult, ObjectiveCheck, Rubric } from '../types';
import { stripAuthorTells } from '../context/redact';
import { evaluateSchema } from '../providers/output-schemas';
import type { ModelProvider } from '../providers/types';
import { computeComparison } from './scoring';

/**
 * Blind comparison.
 *
 * The identity map lives in this module's local scope and in the database. It
 * is never interpolated into a prompt. The only thing that crosses into the
 * evaluator's context is two blocks of text labelled RESPONSE 1 and RESPONSE 2,
 * in an order drawn from a seed.
 *
 * Position bias is real, so the order is randomised per comparison and the seed
 * is stored: a suspicious verdict can be replayed with the order flipped.
 */

export interface BlindPosition {
  /** Which of A / B is presented first to the judge. */
  first: 'A' | 'B';
  /** Judge position (1 or 2) for each side. */
  map: Record<'A' | 'B', 1 | 2>;
  seed: string;
}

/** Deterministic order from a seed, so a comparison is replayable. */
export function choosePositions(seed: string): BlindPosition {
  const byte = crypto.createHash('sha256').update(seed).digest()[0] ?? 0;
  const aFirst = byte % 2 === 0;
  return {
    first: aFirst ? 'A' : 'B',
    map: aFirst ? { A: 1, B: 2 } : { A: 2, B: 1 },
    seed,
  };
}

export interface BlindPromptInput {
  original_brief: string;
  rubric: Rubric;
  /** Per-criterion weight overrides, id -> weight. */
  weights?: Record<string, number>;
  hard_constraints?: string[];
  candidate_a: string;
  candidate_b: string;
  position: BlindPosition;
}

export interface BuiltBlindPrompt {
  prompt: string;
  /** Self-identifying phrases removed from either candidate, for the audit trail. */
  stripped_tells: string[];
}

/**
 * Renders the judge prompt.
 *
 * Two properties this function must keep, and which the neutrality tests assert:
 *   - the words "Claude", "GPT", "Anthropic", "OpenAI" and "author" never appear
 *     as an attribution;
 *   - swapping candidate_a and candidate_b with the mirrored seed produces the
 *     mirrored prompt, character for character.
 */
export function buildBlindPrompt(input: BlindPromptInput): BuiltBlindPrompt {
  const a = stripAuthorTells(input.candidate_a);
  const b = stripAuthorTells(input.candidate_b);
  const stripped = [...a.removed, ...b.removed];

  const first = input.position.first === 'A' ? a.text : b.text;
  const second = input.position.first === 'A' ? b.text : a.text;

  const weightFor = (id: string, fallback: number): number => input.weights?.[id] ?? fallback;
  const totalWeight = input.rubric.criteria.reduce((s, c) => s + weightFor(c.id, c.weight), 0);

  const criteriaBlock = input.rubric.criteria
    .map((c) => {
      const w = weightFor(c.id, c.weight);
      const pct = totalWeight > 0 ? Math.round((w / totalWeight) * 100) : 0;
      return `- ${c.id} (${c.label}, ${pct}% of the weight): ${c.description}`;
    })
    .join('\n');

  const failuresBlock = input.rubric.hard_failures
    .map((h) => `- ${h.id} (${h.label}): ${h.description}`)
    .join('\n');

  const constraintsBlock =
    input.hard_constraints && input.hard_constraints.length
      ? input.hard_constraints.map((c) => `- ${c}`).join('\n')
      : '(none supplied beyond the rubric rules above)';

  const prompt = [
    '<system_instructions>',
    'You are scoring two anonymous responses to the same brief.',
    '',
    'Rules you must follow:',
    '- You do not know who wrote either response, and you must not speculate. Any guess',
    '  about authorship is noise and will be discarded.',
    '- Score each response independently on every criterion, 0 to 10, with one sentence',
    '  of evidence per score. Quote or point to the actual text.',
    '- Flag a hard failure ONLY when you can quote the exact text that breaks the rule.',
    '  A suspicion is not a hard failure.',
    '- You are not asked which response is better and you have no field in which to say so.',
    '  The decision is computed from your scores by a separate process. Do not editorialise',
    '  a winner into concise_rationale.',
    '- If the brief lacks a fact you needed in order to judge, list it in missing_facts',
    '  rather than assuming a value.',
    '- Do not include private step-by-step reasoning. Short, evidence-bearing notes only.',
    '</system_instructions>',
    '',
    '<brief>',
    input.original_brief.trim(),
    '</brief>',
    '',
    '<criteria>',
    criteriaBlock,
    '</criteria>',
    '',
    '<hard_failure_rules>',
    failuresBlock || '(none)',
    '</hard_failure_rules>',
    '',
    '<hard_constraints>',
    constraintsBlock,
    '</hard_constraints>',
    '',
    '<response_1>',
    first.trim(),
    '</response_1>',
    '',
    '<response_2>',
    second.trim(),
    '</response_2>',
    '',
    'Score response_1 and response_2 against every criterion listed above.',
  ].join('\n');

  return { prompt, stripped_tells: stripped };
}

/** Maps the judge's positional report back onto A / B. */
export function unmapReport(report: BlindEvaluatorReport, position: BlindPosition): BlindEvaluatorReport {
  if (position.map.A === 1) return report;
  return {
    ...report,
    response_1: report.response_2,
    response_2: report.response_1,
  };
}

export interface RunBlindCompareArgs {
  task_id: string;
  provider: ModelProvider;
  cfg: CouncilConfig;
  rubric: Rubric;
  original_brief: string;
  candidate_a: string;
  candidate_b: string;
  weights?: Record<string, number>;
  hard_constraints?: string[];
  objective_checks?: ObjectiveCheck[];
  decision_threshold?: number;
  randomization_seed?: string;
  force_user_decision?: boolean;
  allow_tie?: boolean;
  missing_critical_facts?: string[];
  model?: string;
}

export interface RunBlindCompareResult {
  result: ComparisonResult;
  position: BlindPosition;
  stripped_tells: string[];
  usage: { model: string; input_tokens: number; output_tokens: number; cost_usd: number; latency_ms: number };
  request_id: string | null;
  prompt_chars: number;
}

export async function runBlindCompare(args: RunBlindCompareArgs): Promise<RunBlindCompareResult> {
  const seed = args.randomization_seed ?? crypto.randomBytes(8).toString('hex');
  const position = choosePositions(seed);

  const built = buildBlindPrompt({
    original_brief: args.original_brief,
    rubric: args.rubric,
    weights: args.weights,
    hard_constraints: args.hard_constraints,
    candidate_a: args.candidate_a,
    candidate_b: args.candidate_b,
    position,
  });

  const schema = evaluateSchema(
    args.rubric.criteria.map((c) => c.id),
    args.rubric.hard_failures.map((h) => h.id),
  );

  const model = args.model ?? args.cfg.models.evaluator;
  const evaluation = await args.provider.evaluate({
    model,
    prompt: built.prompt,
    schema,
    maxOutputTokens: args.cfg.budget.max_output_tokens,
    timeoutMs:
      args.provider.id === 'codex' ? args.cfg.budget.codex_timeout_ms : args.cfg.budget.timeout_ms,
    retries: args.cfg.budget.retries,
    requestLabel: `blind_compare:${args.task_id}`,
  });

  const inAB = unmapReport(evaluation.report, position);

  const result = computeComparison({
    task_id: args.task_id,
    rubric: args.rubric,
    report: inAB,
    objective_checks: args.objective_checks,
    decision_threshold: args.decision_threshold,
    force_user_decision: args.force_user_decision,
    allow_tie: args.allow_tie,
    missing_critical_facts: args.missing_critical_facts,
    escalate_when_objective_checks_disagree: args.cfg.evaluation.escalate_when_objective_checks_disagree,
    escalate_when_missing_facts: args.cfg.evaluation.escalate_when_missing_facts,
  });

  return {
    result,
    position,
    stripped_tells: built.stripped_tells,
    usage: evaluation.usage,
    request_id: evaluation.request_id,
    prompt_chars: built.prompt.length,
  };
}

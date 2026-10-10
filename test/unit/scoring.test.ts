import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeComparison, reduceObjectiveChecks, subjectiveWeightRatio, weightedScore } from '../../src/judge/scoring';
import { rubricFor } from '../../src/config';
import type { Rubric } from '../../src/types';
import { reportWithScores } from '../helpers';

const copy = rubricFor('copy');
const ids = copy.criteria.map((c) => c.id);

/** Scores that put A clearly ahead of B. */
function clearWin() {
  return reportWithScores({
    criteria: ids,
    scores1: ids.map(() => 9),
    scores2: ids.map(() => 4),
  });
}

describe('weighted scoring', () => {
  it('normalises weights so the total stays on a 0-10 scale', () => {
    const all10 = weightedScore(copy, ids.map((id) => ({ criterion_id: id, score: 10 })));
    assert.equal(all10, 10);
    const all0 = weightedScore(copy, ids.map((id) => ({ criterion_id: id, score: 0 })));
    assert.equal(all0, 0);
  });

  it('respects the relative weights', () => {
    // audience_fit is 25%, cta_quality is 10%. Ten points on the heavier
    // criterion must beat ten on the lighter one.
    const heavy = weightedScore(copy, [{ criterion_id: 'audience_fit', score: 10 }]);
    const light = weightedScore(copy, [{ criterion_id: 'cta_quality', score: 10 }]);
    assert.ok(heavy > light, `${heavy} should exceed ${light}`);
  });

  it('treats an unscored criterion as mid-scale, not as zero', () => {
    const partial = weightedScore(copy, [{ criterion_id: 'audience_fit', score: 10 }]);
    // 10 on 25% plus 5 on the remaining 75% = 2.5 + 3.75 = 6.25
    assert.equal(partial, 6.25);
  });

  it('clamps an out-of-range score instead of letting it skew the total', () => {
    const over = weightedScore(copy, ids.map((id) => ({ criterion_id: id, score: 99 })));
    assert.equal(over, 10);
    const under = weightedScore(copy, ids.map((id) => ({ criterion_id: id, score: -50 })));
    assert.equal(under, 0);
  });

  it('measures the subjective share of a rubric', () => {
    // brand_voice is the only subjective criterion in the copy rubric, at 10%.
    assert.equal(Math.round(subjectiveWeightRatio(copy) * 100), 10);
  });
});

describe('verdict computation', () => {
  it('declares a winner when the gap clears the threshold', () => {
    const r = computeComparison({ task_id: 't1', rubric: copy, report: clearWin() });
    assert.equal(r.verdict, 'A');
    assert.equal(r.decided_by, 'evaluator');
    assert.equal(r.escalation_reasons.length, 0);
  });

  it('escalates to the user when the gap is under the threshold', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 7),
      scores2: ids.map(() => 7),
    });
    const r = computeComparison({ task_id: 't2', rubric: copy, report });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.ok(r.user_question, 'a user decision must come with the question to answer');
    assert.match(r.escalation_reasons.join(' '), /too close to call/i);
  });

  it('escalates when evaluator confidence is below the minimum', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 9),
      scores2: ids.map(() => 4),
      confidence: 0.2,
    });
    const r = computeComparison({ task_id: 't3', rubric: copy, report });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.match(r.escalation_reasons.join(' '), /confidence/i);
  });

  it('escalates when facts are missing', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 9),
      scores2: ids.map(() => 4),
      missingFacts: ['the actual monthly price'],
    });
    const r = computeComparison({ task_id: 't4', rubric: copy, report });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.match(r.escalation_reasons.join(' '), /facts are missing/i);
  });

  it('escalates an irreversible decision even when one side is clearly ahead', () => {
    const r = computeComparison({
      task_id: 't5',
      rubric: copy,
      report: clearWin(),
      force_user_decision: true,
    });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.match(r.escalation_reasons.join(' '), /irreversible|high impact/i);
  });

  it('returns TIE instead of escalating only when the caller opted in', () => {
    const report = reportWithScores({ criteria: ids, scores1: ids.map(() => 7), scores2: ids.map(() => 7) });
    const escalated = computeComparison({ task_id: 't6', rubric: copy, report });
    assert.equal(escalated.verdict, 'NEEDS_USER_DECISION');
    const tied = computeComparison({ task_id: 't6', rubric: copy, report, allow_tie: true });
    assert.equal(tied.verdict, 'TIE');
  });

  it('reports the gap and threshold it used', () => {
    const r = computeComparison({ task_id: 't7', rubric: copy, report: clearWin() });
    assert.equal(r.gap, Number(Math.abs(r.score_a - r.score_b).toFixed(4)));
    assert.equal(r.threshold, copy.decision_threshold);
  });
});

describe('hard constraints outrank scores', () => {
  it('disqualifies the side with a hard failure even when it scores far higher', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 10), // A is stylistically perfect
      scores2: ids.map(() => 3), // B is weak
      failures1: [{ rule_id: 'unapproved_fact', evidence: '"proven to double your income"' }],
    });
    const r = computeComparison({ task_id: 't8', rubric: copy, report });
    assert.equal(r.verdict, 'B', 'the disqualified side must lose despite the higher score');
    assert.equal(r.decided_by, 'hard_constraint');
    assert.equal(r.score_a, 10, 'the score is still reported honestly');
    assert.equal(r.hard_failures_a.length, 1);
  });

  it('escalates when both sides break a hard rule', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 9),
      scores2: ids.map(() => 3),
      failures1: [{ rule_id: 'wrong_price', evidence: '"only 99 a month"' }],
      failures2: [{ rule_id: 'forbidden_promise', evidence: '"guaranteed results"' }],
    });
    const r = computeComparison({ task_id: 't9', rubric: copy, report });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.match(r.escalation_reasons.join(' '), /both candidates violate/i);
  });

  it('ignores a hard failure the rubric does not define, so a model cannot invent a disqualifier', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 9),
      scores2: ids.map(() => 4),
      failures1: [{ rule_id: 'i_just_dont_like_it', evidence: 'vibes' }],
    });
    const r = computeComparison({ task_id: 't10', rubric: copy, report });
    assert.equal(r.verdict, 'A');
    assert.equal(r.hard_failures_a.length, 0);
  });

  it('ignores a hard failure with no evidence quoted', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 9),
      scores2: ids.map(() => 4),
      failures1: [{ rule_id: 'unapproved_fact', evidence: '   ' }],
    });
    const r = computeComparison({ task_id: 't11', rubric: copy, report });
    assert.equal(r.verdict, 'A');
  });
});

describe('objective checks outrank rubric scores', () => {
  it('lets a failing test decide against the better-scoring side', () => {
    const report = reportWithScores({
      criteria: ids,
      scores1: ids.map(() => 10),
      scores2: ids.map(() => 2),
    });
    const r = computeComparison({
      task_id: 't12',
      rubric: copy,
      report,
      objective_checks: [
        { id: 'suite', label: 'unit tests', favours: 'B', passed_a: false, passed_b: true },
      ],
    });
    assert.equal(r.verdict, 'B');
    assert.equal(r.decided_by, 'objective_check');
  });

  it('escalates when objective checks point in opposite directions', () => {
    const r = computeComparison({
      task_id: 't13',
      rubric: copy,
      report: clearWin(),
      objective_checks: [
        { id: 'tests', label: 'unit tests', favours: 'A', passed_a: true, passed_b: false },
        { id: 'perf', label: 'benchmark', favours: 'B', passed_a: false, passed_b: true },
      ],
    });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.match(r.escalation_reasons.join(' '), /disagree/i);
  });

  it('reduces a set of checks to one signal', () => {
    assert.equal(reduceObjectiveChecks([{ id: 'a', label: 'x', favours: 'A', passed_a: true, passed_b: false }]).favours, 'A');
    assert.equal(reduceObjectiveChecks([{ id: 'a', label: 'x', favours: 'neither', passed_a: null, passed_b: null }]).favours, null);
    assert.equal(reduceObjectiveChecks([]).conflicting, false);
  });
});

describe('subjective rubrics escalate', () => {
  it('sends a taste-dominated comparison to the user when it is not a landslide', () => {
    const tasteRubric: Rubric = {
      id: 'taste',
      version: '1.0.0',
      label: 'Taste',
      applies_to: ['other'],
      decision_threshold: 0.8,
      min_confidence: 0.5,
      subjective_escalation_ratio: 0.5,
      criteria: [
        { id: 'voice', label: 'Voice', weight: 60, description: 'x', subjective: true },
        { id: 'clarity', label: 'Clarity', weight: 40, description: 'y' },
      ],
      hard_failures: [],
    };
    const report = reportWithScores({ criteria: ['voice', 'clarity'], scores1: [8, 8], scores2: [7, 7] });
    const r = computeComparison({ task_id: 't14', rubric: tasteRubric, report });
    assert.equal(r.verdict, 'NEEDS_USER_DECISION');
    assert.match(r.escalation_reasons.join(' '), /taste and brand voice/i);
  });
});

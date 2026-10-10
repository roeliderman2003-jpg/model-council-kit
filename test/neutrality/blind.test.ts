import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlindPrompt, choosePositions, unmapReport } from '../../src/judge/blind';
import { computeComparison } from '../../src/judge/scoring';
import { applyOutcomeOverEvaluation } from '../../src/judge/scoring';
import { rubricFor } from '../../src/config';
import { blindCompare } from '../../src/tools';
import { FakeProvider, reportWithScores, testDeps } from '../helpers';

const copy = rubricFor('copy');
const ids = copy.criteria.map((c) => c.id);

const CLAUDE_TEXT = 'Claude version: train with a coach who knows your name.';
const GPT_TEXT = 'GPT version: the gym where nobody watches you struggle alone.';

describe('the judge never learns who wrote what', () => {
  it('omits every author attribution from the prompt', () => {
    const { prompt } = buildBlindPrompt({
      original_brief: 'headline for the kids programme',
      rubric: copy,
      candidate_a: 'first candidate text',
      candidate_b: 'second candidate text',
      position: choosePositions('seed'),
    });
    // No model name and no A/B label may appear anywhere in the prompt.
    for (const word of ['Anthropic', 'OpenAI', 'Claude', 'candidate_a', 'candidate_b']) {
      assert.ok(!prompt.includes(word), `prompt must not contain "${word}"`);
    }
    // No attribution phrasing. The word "authorship" DOES appear, in the
    // instruction telling the judge not to speculate about it — that is the
    // point of it being there, so the ban is on attribution, not the noun.
    for (const re of [/written by/i, /author is/i, /this response came from/i, /candidate [AB]\b/]) {
      assert.ok(!re.test(prompt), `prompt must not attribute: ${re}`);
    }
    assert.ok(prompt.includes('<response_1>'));
    assert.ok(prompt.includes('<response_2>'));
  });

  it('does not pass author_a / author_b through to the judge', async () => {
    const provider = new FakeProvider();
    provider.setReport(reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 3) }));
    const deps = testDeps({ provider });

    await blindCompare(
      {
        original_brief: 'a brief',
        candidate_a: 'plain candidate one',
        candidate_b: 'plain candidate two',
        author_a: 'claude',
        author_b: 'gpt',
        task_type: 'copy',
      } as never,
      deps,
    );

    const sent = provider.evaluatePrompts[0]!;
    assert.ok(!/claude/i.test(sent), 'the word claude must not reach the judge');
    assert.ok(!/\bgpt\b/i.test(sent), 'the word gpt must not reach the judge');
  });

  it('strips a self-identifying phrase from a candidate before the judge sees it', async () => {
    const provider = new FakeProvider();
    provider.setReport(reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 3) }));
    const deps = testDeps({ provider });

    const res = await blindCompare(
      {
        original_brief: 'a brief',
        candidate_a: CLAUDE_TEXT,
        candidate_b: GPT_TEXT,
        author_a: 'claude',
        author_b: 'gpt',
        task_type: 'copy',
      } as never,
      deps,
    );

    const sent = provider.evaluatePrompts[0]!;
    assert.ok(!/claude version/i.test(sent), sent.slice(0, 400));
    assert.ok(!/gpt version/i.test(sent));
    // The substance survives.
    assert.ok(sent.includes('train with a coach who knows your name'));
    assert.ok(sent.includes('the gym where nobody watches you struggle alone'));
    assert.ok(res.notes.some((n) => /self-identifying/i.test(n)), 'the strip must be reported, not silent');
  });

  it('reports that the judge saw no identities', async () => {
    const provider = new FakeProvider();
    provider.setReport(reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 3) }));
    const res = await blindCompare(
      { original_brief: 'b', candidate_a: 'one', candidate_b: 'two', task_type: 'copy' } as never,
      testDeps({ provider }),
    );
    assert.equal((res.data as { judge_saw_identities: boolean }).judge_saw_identities, false);
  });
});

describe('position is randomised and the mapping is honest', () => {
  it('puts A first for some seeds and second for others', () => {
    const seeds = Array.from({ length: 40 }, (_, i) => `seed-${i}`);
    const firsts = seeds.map((s) => choosePositions(s).first);
    assert.ok(firsts.includes('A'), 'some seeds must put A first');
    assert.ok(firsts.includes('B'), 'some seeds must put B first');
  });

  it('is deterministic for the same seed, so a comparison can be replayed', () => {
    assert.deepEqual(choosePositions('fixed').map, choosePositions('fixed').map);
  });

  it('places the candidate the map says it places', () => {
    const posAFirst = { first: 'A' as const, map: { A: 1 as const, B: 2 as const }, seed: 's' };
    const { prompt } = buildBlindPrompt({
      original_brief: 'b',
      rubric: copy,
      candidate_a: 'AAAA',
      candidate_b: 'BBBB',
      position: posAFirst,
    });
    assert.ok(prompt.indexOf('AAAA') < prompt.indexOf('BBBB'));

    const posBFirst = { first: 'B' as const, map: { A: 2 as const, B: 1 as const }, seed: 's' };
    const flipped = buildBlindPrompt({
      original_brief: 'b',
      rubric: copy,
      candidate_a: 'AAAA',
      candidate_b: 'BBBB',
      position: posBFirst,
    });
    assert.ok(flipped.prompt.indexOf('BBBB') < flipped.prompt.indexOf('AAAA'));
  });

  it('maps a positional report back onto A and B correctly', () => {
    const report = reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 2) });
    // When B was shown first, response_1 belongs to B.
    const posBFirst = { first: 'B' as const, map: { A: 2 as const, B: 1 as const }, seed: 's' };
    const remapped = unmapReport(report, posBFirst);
    assert.equal(remapped.response_1.scores[0]?.score, 2, 'A now carries the second position scores');
    assert.equal(remapped.response_2.scores[0]?.score, 9);

    const posAFirst = { first: 'A' as const, map: { A: 1 as const, B: 2 as const }, seed: 's' };
    const same = unmapReport(report, posAFirst);
    assert.equal(same.response_1.scores[0]?.score, 9, 'no remap needed when A was first');
  });
});

describe('order does not change the verdict', () => {
  /**
   * The strongest neutrality property: identical evidence must produce the
   * mirrored verdict when the two sides swap places. This is why the scoring is
   * a pure function — the assertion is exact, not statistical.
   */
  it('produces the mirrored verdict when A and B swap', () => {
    const forward = computeComparison({
      task_id: 't',
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 4) }),
    });
    const swapped = computeComparison({
      task_id: 't',
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 4), scores2: ids.map(() => 9) }),
    });
    assert.equal(forward.verdict, 'A');
    assert.equal(swapped.verdict, 'B');
    assert.equal(forward.gap, swapped.gap, 'the gap must be identical, not merely similar');
    assert.equal(forward.score_a, swapped.score_b);
  });

  it('mirrors a hard-failure disqualification too', () => {
    const forward = computeComparison({
      task_id: 't',
      rubric: copy,
      report: reportWithScores({
        criteria: ids,
        scores1: ids.map(() => 10),
        scores2: ids.map(() => 3),
        failures1: [{ rule_id: 'wrong_price', evidence: '"99 a month"' }],
      }),
    });
    const swapped = computeComparison({
      task_id: 't',
      rubric: copy,
      report: reportWithScores({
        criteria: ids,
        scores1: ids.map(() => 3),
        scores2: ids.map(() => 10),
        failures2: [{ rule_id: 'wrong_price', evidence: '"99 a month"' }],
      }),
    });
    assert.equal(forward.verdict, 'B');
    assert.equal(swapped.verdict, 'A');
    assert.equal(forward.decided_by, swapped.decided_by);
  });

  it('escalates in both directions when the gap is small', () => {
    const mk = (s1: number, s2: number) =>
      computeComparison({
        task_id: 't',
        rubric: copy,
        report: reportWithScores({ criteria: ids, scores1: ids.map(() => s1), scores2: ids.map(() => s2) }),
      });
    assert.equal(mk(7, 7.2).verdict, 'NEEDS_USER_DECISION');
    assert.equal(mk(7.2, 7).verdict, 'NEEDS_USER_DECISION');
  });
});

describe('Claude gets no home advantage', () => {
  it('does not favour A, which is where Claude is conventionally placed', () => {
    // Identical scores in both directions must never resolve to A.
    const equal = computeComparison({
      task_id: 't',
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 8), scores2: ids.map(() => 8) }),
    });
    assert.notEqual(equal.verdict, 'A');
    assert.equal(equal.verdict, 'NEEDS_USER_DECISION');
  });

  it('lets GPT win outright when GPT scores higher', () => {
    const r = computeComparison({
      task_id: 't',
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 3), scores2: ids.map(() => 9) }),
    });
    assert.equal(r.verdict, 'B');
    assert.equal(r.decided_by, 'evaluator');
  });

  it('has no code path in which an author name can influence the verdict', () => {
    // computeComparison takes no author argument at all. This is the structural
    // guarantee: the arithmetic cannot see identity because it is not passed in.
    const signature = computeComparison.toString();
    assert.ok(!/author/i.test(signature), 'the scoring function must not reference an author');
  });
});

describe('reality outranks the judge', () => {
  it('lets a recorded outcome supersede the evaluator verdict', () => {
    const r = applyOutcomeOverEvaluation({
      evaluator_verdict: 'A',
      evaluator_winner_author: 'claude',
      outcome_winner_author: 'gpt',
    });
    assert.equal(r.verdict_now, 'gpt');
    assert.equal(r.decided_by, 'outcome');
    assert.equal(r.contradicted_evaluator, true, 'the disagreement must be surfaced, not hidden');
  });

  it('leaves the evaluator verdict standing when no outcome has been recorded', () => {
    const r = applyOutcomeOverEvaluation({
      evaluator_verdict: 'A',
      evaluator_winner_author: 'claude',
      outcome_winner_author: null,
    });
    assert.equal(r.verdict_now, 'claude');
    assert.equal(r.decided_by, 'evaluator');
    assert.equal(r.contradicted_evaluator, false);
  });

  it('does not flag a contradiction when reality agrees with the judge', () => {
    const r = applyOutcomeOverEvaluation({
      evaluator_verdict: 'B',
      evaluator_winner_author: 'gpt',
      outcome_winner_author: 'gpt',
    });
    assert.equal(r.contradicted_evaluator, false);
    assert.equal(r.decided_by, 'outcome');
  });
});

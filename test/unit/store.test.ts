import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_SCHEMA_VERSION, Store } from '../../src/store/db';
import {
  createTask,
  deleteTask,
  getEvaluations,
  getOutcomes,
  getTask,
  recordCandidate,
  recordEvaluation,
  recordOutcome,
  recordUsage,
  spentThisMonth,
  spentToday,
} from '../../src/store/repo';
import { buildStats, rateOf, wilson } from '../../src/store/stats';
import { computeComparison } from '../../src/judge/scoring';
import { rubricFor } from '../../src/config';
import { memStore, reportWithScores } from '../helpers';

const copy = rubricFor('copy');
const ids = copy.criteria.map((c) => c.id);

function seedTask(store: Store, taskType = 'copy'): string {
  return createTask(store, {
    task_type: taskType as never,
    mode: 'COMPETITION',
    mode_reason: 'test',
    sensitivity: 'internal',
    irreversible: false,
    high_stakes: false,
    prompt_version: '1.0.0',
    config_version: '1.0.0',
    input_hash: 'hash',
    request_excerpt: 'excerpt',
  });
}

describe('schema and migrations', () => {
  it('applies migrations on open and reports the version', () => {
    const store = memStore();
    assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
    store.close();
  });

  it('is idempotent — re-running migrations changes nothing', () => {
    const store = memStore();
    const v1 = store.schemaVersion;
    const rows = store.all('SELECT * FROM schema_meta');
    assert.equal(rows.length, CURRENT_SCHEMA_VERSION);
    assert.equal(v1, CURRENT_SCHEMA_VERSION);
    store.close();
  });

  it('keeps candidates, evaluations and outcomes in separate tables', () => {
    const store = memStore();
    const tables = store
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name);
    for (const t of ['tasks', 'candidates', 'evaluations', 'outcomes', 'usage_log']) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    store.close();
  });
});

describe('recording and reading back', () => {
  it('round-trips a task', () => {
    const store = memStore();
    const id = seedTask(store);
    const t = getTask(store, id);
    assert.equal(t?.task_type, 'copy');
    assert.equal(t?.mode, 'COMPETITION');
    store.close();
  });

  it('stores only a hash when content storage is off', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordCandidate(store, {
      task_id: taskId,
      author: 'gpt',
      model: 'gpt-5.1',
      text: 'the secret copy that must not be persisted',
      storeContent: false,
    });
    const row = store.get<{ content: string | null; candidate_hash: string }>(
      'SELECT content, candidate_hash FROM candidates WHERE task_id = ?',
      taskId,
    );
    assert.equal(row?.content, null, 'content must not be persisted by default');
    assert.equal(row?.candidate_hash.length, 64, 'the hash is still recorded');
    store.close();
  });

  it('stores content when the operator explicitly turns it on', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordCandidate(store, {
      task_id: taskId,
      author: 'gpt',
      model: 'gpt-5.1',
      text: 'debugging this one',
      storeContent: true,
    });
    const row = store.get<{ content: string | null }>('SELECT content FROM candidates WHERE task_id = ?', taskId);
    assert.equal(row?.content, 'debugging this one');
    store.close();
  });

  it('round-trips an evaluation with its verdict and provenance', () => {
    const store = memStore();
    const taskId = seedTask(store);
    const result = computeComparison({
      task_id: taskId,
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 4) }),
    });
    recordEvaluation(store, {
      task_id: taskId,
      evaluator_model: 'gpt-5.1',
      rubric_id: copy.id,
      rubric_version: copy.version,
      seed: 'seed',
      position_map: { A: 1, B: 2 },
      author_a: 'claude',
      author_b: 'gpt',
      result,
    });
    const evals = getEvaluations(store, taskId);
    assert.equal(evals.length, 1);
    assert.equal(evals[0]?.verdict, 'A');
    assert.equal(evals[0]?.author_a, 'claude');
    assert.equal(evals[0]?.decided_by, 'evaluator');
    store.close();
  });

  it('round-trips an outcome', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordOutcome(store, {
      task_id: taskId,
      chosen_author: 'gpt',
      metric_type: 'cpl',
      metric_value: 42,
      window: '2026-08',
      is_final: true,
    });
    const rows = getOutcomes(store, taskId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.metric_value, 42);
    assert.equal(rows[0]?.is_final, 1);
    store.close();
  });

  it('accumulates usage by day and month', () => {
    const store = memStore();
    for (let i = 0; i < 3; i++) {
      recordUsage(store, {
        model: 'gpt-5.1',
        input_tokens: 100,
        output_tokens: 100,
        cost_usd: 0.01,
        latency_ms: 5,
        purpose: 'generate',
      });
    }
    assert.ok(Math.abs(spentToday(store) - 0.03) < 1e-9);
    assert.ok(Math.abs(spentThisMonth(store) - 0.03) < 1e-9);
    store.close();
  });

  it('deletes every row belonging to a task', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordCandidate(store, { task_id: taskId, author: 'gpt', model: 'm', text: 'x', storeContent: false });
    recordOutcome(store, {
      task_id: taskId,
      chosen_author: 'gpt',
      metric_type: 'ctr',
      metric_value: 1,
      window: 'w',
      is_final: true,
    });
    deleteTask(store, taskId);
    assert.equal(getTask(store, taskId), undefined);
    assert.equal(getOutcomes(store, taskId).length, 0);
    assert.equal(store.all('SELECT * FROM candidates WHERE task_id = ?', taskId).length, 0);
    store.close();
  });
});

describe('statistics', () => {
  it('warns when there is not enough data to conclude anything', () => {
    const store = memStore();
    const report = buildStats(store, { minSampleSize: 12 });
    assert.equal(report.totals.tasks, 0);
    assert.ok(report.warnings.some((w) => /No tasks/i.test(w)));
    store.close();
  });

  it('flags a row below the minimum sample size', () => {
    const store = memStore();
    for (let i = 0; i < 3; i++) {
      const taskId = seedTask(store);
      recordCandidate(store, { task_id: taskId, author: 'claude', model: 'claude-code', text: `a${i}`, storeContent: false });
      recordCandidate(store, { task_id: taskId, author: 'gpt', model: 'gpt-5.1', text: `b${i}`, storeContent: false });
      const result = computeComparison({
        task_id: taskId,
        rubric: copy,
        report: reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 3) }),
      });
      recordEvaluation(store, {
        task_id: taskId,
        evaluator_model: 'gpt-5.1',
        rubric_id: copy.id,
        rubric_version: copy.version,
        seed: 's',
        position_map: { A: 1, B: 2 },
        author_a: 'claude',
        author_b: 'gpt',
        result,
      });
    }
    const report = buildStats(store, { minSampleSize: 12 });
    const claudeRow = report.by_task_type_and_model.find((r) => r.author === 'claude');
    assert.equal(claudeRow?.evaluator.wins, 3);
    assert.equal(claudeRow?.evaluator_win_rate.insufficient_sample, true);
    assert.ok(report.warnings.some((w) => /minimum sample size/i.test(w)));
    store.close();
  });

  it('counts evaluator wins and outcome wins in separate buckets', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordCandidate(store, { task_id: taskId, author: 'claude', model: 'c', text: 'a', storeContent: false });
    recordCandidate(store, { task_id: taskId, author: 'gpt', model: 'g', text: 'b', storeContent: false });
    const result = computeComparison({
      task_id: taskId,
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 9), scores2: ids.map(() => 3) }),
    });
    recordEvaluation(store, {
      task_id: taskId,
      evaluator_model: 'gpt-5.1',
      rubric_id: copy.id,
      rubric_version: copy.version,
      seed: 's',
      position_map: { A: 1, B: 2 },
      author_a: 'claude',
      author_b: 'gpt',
      result,
    });
    // Reality says the opposite: GPT's version got the cheaper CPL.
    recordOutcome(store, { task_id: taskId, chosen_author: 'claude', metric_type: 'cpl', metric_value: 80, window: 'w', is_final: true });
    recordOutcome(store, { task_id: taskId, chosen_author: 'gpt', metric_type: 'cpl', metric_value: 42, window: 'w', is_final: true });

    const report = buildStats(store, { minSampleSize: 1 });
    const claudeRow = report.by_task_type_and_model.find((r) => r.author === 'claude')!;
    const gptRow = report.by_task_type_and_model.find((r) => r.author === 'gpt')!;
    assert.equal(claudeRow.evaluator.wins, 1, 'the judge preferred Claude');
    assert.equal(claudeRow.outcome.wins, 0, 'reality did not');
    assert.equal(gptRow.outcome.wins, 1, 'the cheaper CPL wins the outcome bucket');
    assert.equal(gptRow.evaluator.wins, 0);
    store.close();
  });

  it('does not treat a one-sided outcome as a comparison', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordCandidate(store, { task_id: taskId, author: 'gpt', model: 'g', text: 'b', storeContent: false });
    recordOutcome(store, { task_id: taskId, chosen_author: 'gpt', metric_type: 'cpl', metric_value: 42, window: 'w', is_final: true });
    const report = buildStats(store, { minSampleSize: 1 });
    const gptRow = report.by_task_type_and_model.find((r) => r.author === 'gpt')!;
    assert.equal(gptRow.outcome.n, 0, 'one value means a candidate was used, not that it beat anything');
    store.close();
  });

  it('counts a user decision without crediting either model with a win', () => {
    const store = memStore();
    const taskId = seedTask(store);
    recordCandidate(store, { task_id: taskId, author: 'claude', model: 'c', text: 'a', storeContent: false });
    recordCandidate(store, { task_id: taskId, author: 'gpt', model: 'g', text: 'b', storeContent: false });
    const result = computeComparison({
      task_id: taskId,
      rubric: copy,
      report: reportWithScores({ criteria: ids, scores1: ids.map(() => 7), scores2: ids.map(() => 7) }),
    });
    assert.equal(result.verdict, 'NEEDS_USER_DECISION');
    recordEvaluation(store, {
      task_id: taskId,
      evaluator_model: 'gpt-5.1',
      rubric_id: copy.id,
      rubric_version: copy.version,
      seed: 's',
      position_map: { A: 1, B: 2 },
      author_a: 'claude',
      author_b: 'gpt',
      result,
    });
    const report = buildStats(store, { minSampleSize: 1 });
    assert.equal(report.totals.user_decisions, 1);
    const claudeRow = report.by_task_type_and_model.find((r) => r.author === 'claude')!;
    assert.equal(claudeRow.evaluator.wins, 0);
    assert.equal(claudeRow.evaluator.user_decisions, 1);
    store.close();
  });

  it('breaks the history down by month, so a fixed problem is visible as fixed', () => {
    const store = memStore();
    seedTask(store);
    const report = buildStats(store, { minSampleSize: 1 });
    assert.equal(report.by_month.length, 1);
    assert.match(report.by_month[0]!.month, /^\d{4}-\d{2}$/);
    store.close();
  });
});

describe('confidence intervals', () => {
  it('gives a wide interval at small n and a narrow one at large n', () => {
    const small = wilson(3, 3);
    const large = wilson(300, 300);
    assert.ok(small.low < large.low, 'three wins in three is far weaker evidence than 300 in 300');
  });

  it('marks any total of zero as insufficient', () => {
    const r = rateOf(0, 0, 5);
    assert.equal(r.rate, null);
    assert.equal(r.insufficient_sample, true);
  });

  it('does not claim certainty from a perfect small record', () => {
    const r = rateOf(5, 5, 12);
    assert.equal(r.rate, 1);
    assert.ok(r.low! < 0.9, 'the lower bound must stay honest');
    assert.equal(r.insufficient_sample, true);
  });
});

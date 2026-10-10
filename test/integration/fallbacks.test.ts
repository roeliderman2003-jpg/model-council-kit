import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blindCompare, councilConfig, gptGenerate, recordOutcomeTool, registerCandidate, routeTask, routingStats } from '../../src/tools';
import { CouncilError } from '../../src/types';
import { OpenAIProvider } from '../../src/providers/openai';
import { rubricFor } from '../../src/config';
import { FakeProvider, memStore, reportWithScores, testConfig, testDeps, withEnv } from '../helpers';

const copy = rubricFor('copy');
const ids = copy.criteria.map((c) => c.id);

describe('missing API key', () => {
  it('falls back to Claude and explains why, rather than failing the task', async () => {
    const provider = new FakeProvider();
    provider.available = false;
    const res = routeTask(
      { original_request: 'write the landing page copy', task_type: 'copy' } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, true);
    const data = res.data as { mode: string; gpt_available: boolean; notes: string[] };
    assert.equal(data.mode, 'CLAUDE_ONLY', 'the work still gets routed somewhere');
    assert.equal(data.gpt_available, false);
    assert.ok(data.notes.some((n) => /OPENAI_API_KEY/.test(n)), 'the reason must be stated');
  });

  it('returns a structured refusal from gpt_generate rather than throwing', async () => {
    const provider = new FakeProvider();
    provider.available = false;
    const res = await gptGenerate(
      { original_request: 'x', task_type: 'copy', brief: 'y' } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error?.reason, 'no_api_key');
    assert.match(res.error!.suggestion, /Claude continues/i);
  });

  it('keeps both candidates when the judge is unreachable', async () => {
    const provider = new FakeProvider();
    provider.available = false;
    const res = await blindCompare(
      { original_brief: 'b', candidate_a: 'A text', candidate_b: 'B text', task_type: 'copy' } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error!.suggestion, /Both candidates are preserved/i);
  });

  it('the real provider reports unavailability without constructing a client', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, () => {
      const p = new OpenAIProvider(testConfig());
      assert.equal(p.isAvailable(), false);
      assert.match(p.unavailableReason()!, /OPENAI_API_KEY is not set/);
    });
  });
});

describe('budget exhaustion', () => {
  it('refuses the call, names the limit, and points at the fallback', async () => {
    const cfg = testConfig();
    cfg.budget.per_task_usd = 0.0000001;
    const provider = new FakeProvider();
    const res = await gptGenerate(
      { original_request: 'write a long piece', task_type: 'copy', brief: 'b' } as never,
      testDeps({ provider, cfg }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error?.reason, 'budget_exceeded');
    assert.match(res.error!.suggestion, /Claude continues on its own/i);
    assert.equal(provider.generateCalls, 0, 'no call may be made once the budget refuses');
  });

  it('stops a runaway workflow at the call limit', async () => {
    const cfg = testConfig();
    cfg.budget.max_calls_per_workflow = 2;
    const store = memStore();
    const provider = new FakeProvider();
    const deps = testDeps({ provider, cfg, store });

    const first = await gptGenerate(
      { original_request: 'a', task_type: 'copy', brief: 'b' } as never,
      deps,
    );
    const taskId = (first.data as { task_id: string }).task_id;

    const second = await gptGenerate(
      { original_request: 'a', task_type: 'copy', brief: 'b', task_id: taskId } as never,
      deps,
    );
    assert.equal(second.ok, true);

    const third = await gptGenerate(
      { original_request: 'a', task_type: 'copy', brief: 'b', task_id: taskId } as never,
      deps,
    );
    assert.equal(third.ok, false);
    assert.equal(third.error?.reason, 'call_limit_exceeded');
    assert.equal(provider.generateCalls, 2, 'the third call never reached the provider');
  });
});

describe('dry run', () => {
  it('shows the exact payload and spends nothing', async () => {
    const provider = new FakeProvider();
    const res = await gptGenerate(
      {
        original_request: 'write me a headline',
        task_type: 'copy',
        brief: 'headline for the mothers programme',
        approved_facts: ['sessions are 50 minutes'],
        dry_run: true,
      } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, true);
    const data = res.data as { dry_run: boolean; prompt_preview: string; sent_to_gpt: boolean; estimated_cost_usd: number };
    assert.equal(data.dry_run, true);
    assert.equal(data.sent_to_gpt, false);
    assert.ok(data.prompt_preview.includes('sessions are 50 minutes'));
    assert.ok(data.estimated_cost_usd > 0, 'the estimate is still shown');
    assert.equal(provider.generateCalls, 0, 'a dry run must not call the API');
  });

  it('shows the judge prompt for a comparison without calling anything', async () => {
    const provider = new FakeProvider();
    const res = await blindCompare(
      {
        original_brief: 'a brief',
        candidate_a: 'first',
        candidate_b: 'second',
        task_type: 'copy',
        dry_run: true,
        randomization_seed: 'fixed',
      } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, true);
    const data = res.data as { judge_prompt: string; sent_to_gpt: boolean };
    assert.equal(data.sent_to_gpt, false);
    assert.ok(data.judge_prompt.includes('<response_1>'));
    assert.equal(provider.evaluateCalls, 0);
  });
});

describe('provider faults', () => {
  it('surfaces a timeout without losing the rest of the work', async () => {
    const provider = new FakeProvider();
    provider.throwOnGenerate = new CouncilError(
      'timeout',
      'The request exceeded the 90000ms timeout.',
      'Claude keeps its own work.',
    );
    const res = await gptGenerate(
      { original_request: 'x', task_type: 'copy', brief: 'y' } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error?.reason, 'timeout');
  });

  it('surfaces malformed model output as invalid_output, not as a crash', async () => {
    const provider = new FakeProvider();
    provider.throwOnGenerate = new CouncilError(
      'invalid_output',
      'The model returned text that is not valid JSON.',
      'Raise max_output_length, or retry.',
    );
    const res = await gptGenerate(
      { original_request: 'x', task_type: 'copy', brief: 'y' } as never,
      testDeps({ provider }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error?.reason, 'invalid_output');
  });

  it('records the spend of a task even when the call later fails', async () => {
    const store = memStore();
    const provider = new FakeProvider();
    provider.throwOnGenerate = new CouncilError('provider_unavailable', 'down', 'retry');
    const res = await gptGenerate(
      { original_request: 'x', task_type: 'copy', brief: 'y' } as never,
      testDeps({ provider, store }),
    );
    assert.equal(res.ok, false);
    // The task row exists so the failure is attributable.
    const tasks = store.all('SELECT id FROM tasks');
    assert.equal(tasks.length, 1);
    store.close();
  });
});

describe('store unavailable', () => {
  it('still produces the candidate and warns that history is lost', async () => {
    const provider = new FakeProvider('the headline');
    const res = await gptGenerate(
      { original_request: 'x', task_type: 'copy', brief: 'y' } as never,
      testDeps({ provider, store: null }),
    );
    assert.equal(res.ok, true, 'losing the store must not lose the work');
    assert.equal((res.data as { candidate: string }).candidate, 'the headline');
    assert.ok(res.notes.some((n) => /History is unavailable/i.test(n)));
  });

  it('refuses to record an outcome it cannot persist, rather than pretending', () => {
    const res = recordOutcomeTool(
      {
        task_id: 't',
        chosen_author: 'gpt',
        metric_type: 'cpl',
        metric_value: 42,
        window: 'w',
        is_final: true,
      } as never,
      testDeps({ store: null }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.error?.reason, 'store_unavailable');
  });

  it('reports no statistics rather than empty ones', () => {
    const res = routingStats({} as never, testDeps({ store: null }));
    assert.equal(res.ok, false);
    assert.equal(res.error?.reason, 'store_unavailable');
  });
});

describe('the full loop', () => {
  it('runs generate, register, compare and record end to end', async () => {
    const store = memStore();
    const provider = new FakeProvider('the second headline about early mornings');
    // Score by CONTENT, not by slot: the judge prefers whichever response
    // actually contains this phrase, wherever the position draw puts it.
    provider.scoreByContent('early mornings', ids, 9, 4);
    const deps = testDeps({ provider, store });

    // 1. Claude registers its own candidate.
    const claudeReg = registerCandidate(
      {
        task_type: 'copy',
        author: 'claude',
        text: 'the first headline about community',
        original_request: 'headline for the launch',
        mode: 'COMPETITION',
        mode_reason: 'high stakes',
      } as never,
      deps,
    );
    assert.equal(claudeReg.ok, true);
    const taskId = (claudeReg.data as { task_id: string }).task_id;

    // 2. GPT generates against the same task.
    const gen = await gptGenerate(
      { original_request: 'headline for the launch', task_type: 'copy', brief: 'headline', task_id: taskId } as never,
      deps,
    );
    assert.equal(gen.ok, true);
    assert.equal((gen.data as { task_id: string }).task_id, taskId, 'both candidates share one task');

    // 3. Blind comparison — B (GPT) scores higher here.
    const cmp = await blindCompare(
      {
        original_brief: 'headline for the launch',
        candidate_a: 'the first headline about community',
        candidate_b: 'the second headline about early mornings',
        author_a: 'claude',
        author_b: 'gpt',
        task_type: 'copy',
        task_id: taskId,
      } as never,
      deps,
    );
    assert.equal(cmp.ok, true);
    assert.equal((cmp.data as { verdict: string }).verdict, 'B');

    // 4. Reality comes back and disagrees.
    recordOutcomeTool(
      { task_id: taskId, chosen_author: 'gpt', metric_type: 'cpl', metric_value: 61, window: 'sept', is_final: true } as never,
      deps,
    );
    const out = recordOutcomeTool(
      { task_id: taskId, chosen_author: 'claude', metric_type: 'cpl', metric_value: 38, window: 'sept', is_final: true } as never,
      deps,
    );
    assert.equal(out.ok, true);
    const sup = (out.data as { supersedes_evaluation: { verdict_now: string; decided_by: string; contradicted_evaluator: boolean } | null })
      .supersedes_evaluation;
    assert.equal(sup?.verdict_now, 'claude', 'the cheaper CPL wins regardless of the judge');
    assert.equal(sup?.decided_by, 'outcome');
    assert.equal(sup?.contradicted_evaluator, true);
    assert.ok(out.notes.some((n) => /Reality disagreed/i.test(n)));

    // 5. Statistics keep the two kinds of evidence apart.
    const stats = routingStats({ min_sample_size: 1 } as never, deps);
    assert.equal(stats.ok, true);
    const report = stats.data as {
      totals: { tasks: number; outcomes_recorded: number };
      by_task_type_and_model: Array<{ author: string; evaluator: { wins: number }; outcome: { wins: number } }>;
    };
    assert.equal(report.totals.tasks, 1);
    assert.equal(report.totals.outcomes_recorded, 2);
    const claudeRow = report.by_task_type_and_model.find((r) => r.author === 'claude')!;
    const gptRow = report.by_task_type_and_model.find((r) => r.author === 'gpt')!;
    assert.equal(gptRow.evaluator.wins, 1, 'the judge preferred GPT');
    assert.equal(claudeRow.outcome.wins, 1, 'the money preferred Claude');
    store.close();
  });

  it('warns when a single-sided outcome cannot settle anything', () => {
    const store = memStore();
    const deps = testDeps({ store });
    const reg = registerCandidate(
      { task_type: 'copy', author: 'gpt', text: 'only one candidate' } as never,
      deps,
    );
    const taskId = (reg.data as { task_id: string }).task_id;
    const out = recordOutcomeTool(
      { task_id: taskId, chosen_author: 'gpt', metric_type: 'cpl', metric_value: 42, window: 'w', is_final: true } as never,
      deps,
    );
    assert.equal(out.ok, true);
    assert.ok(out.notes.some((n) => /does not yet settle a comparison/i.test(n)));
    store.close();
  });

  it('rejects an outcome for a task that does not exist', () => {
    const res = recordOutcomeTool(
      { task_id: 'task_nope', chosen_author: 'gpt', metric_type: 'cpl', metric_value: 1, window: 'w', is_final: true } as never,
      testDeps(),
    );
    assert.equal(res.ok, false);
    assert.match(res.error!.message, /No task with id/);
  });
});

describe('configuration surface', () => {
  it('exposes the active policy and no secrets', () => {
    const res = councilConfig({} as never, testDeps());
    assert.equal(res.ok, true);
    const text = JSON.stringify(res.data);
    assert.ok(!/sk-/.test(text));
    const data = res.data as { models: { generator: string }; rubrics: unknown[] };
    assert.ok(data.models.generator.length > 0);
    assert.ok(data.rubrics.length >= 3, 'the installed rubrics are listed');
  });

  it('returns a single section on request', () => {
    const res = councilConfig({ section: 'budget' } as never, testDeps());
    assert.equal(res.ok, true);
    assert.ok('budget' in (res.data as object));
  });

  it('rejects an unknown section with the valid list', () => {
    const res = councilConfig({ section: 'nonsense' } as never, testDeps());
    assert.equal(res.ok, false);
    assert.match(res.error!.suggestion, /all, models, budget/);
  });
});

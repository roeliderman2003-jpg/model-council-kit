import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { actualCost, checkBudget, estimateCost, snapshot } from '../../src/budget';
import { decideRoute, detectExplicitMode, detectTaskType, isRouteMode, seededUnit } from '../../src/routing/engine';
import { recordUsage } from '../../src/store/repo';
import { rubricFor } from '../../src/config';
import { memStore, testConfig } from '../helpers';

describe('cost estimation', () => {
  const cfg = testConfig();

  it('prices a known model from the table', () => {
    const e = estimateCost(cfg, 'gpt-5.1', 3500, 1000);
    assert.equal(e.approximate, false);
    assert.ok(e.usd > 0);
  });

  it('flags an unknown model as approximate rather than pricing it silently', () => {
    const e = estimateCost(cfg, 'some-model-nobody-priced', 3500, 1000);
    assert.equal(e.approximate, true);
    assert.ok(e.usd > 0, 'it still returns a figure, just a flagged one');
  });

  it('charges output tokens more than input tokens', () => {
    const inputHeavy = estimateCost(cfg, 'gpt-5.1', 35000, 100);
    const outputHeavy = estimateCost(cfg, 'gpt-5.1', 350, 10000);
    assert.ok(outputHeavy.usd > inputHeavy.usd);
  });

  it('computes actual cost from real token counts', () => {
    const c = actualCost(cfg, 'gpt-5.1', 1_000_000, 0);
    assert.equal(c, 1.25);
  });
});

describe('budget limits', () => {
  it('allows a call inside every limit', () => {
    const cfg = testConfig();
    const store = memStore();
    const r = checkBudget(cfg, store, { model: 'gpt-5.1', inputChars: 1000, maxOutputTokens: 500 });
    assert.equal(r.allowed, true);
  });

  it('refuses a single call larger than the per-task cap', () => {
    const cfg = testConfig();
    cfg.budget.per_task_usd = 0.0001;
    const r = checkBudget(cfg, memStore(), { model: 'gpt-5.1', inputChars: 10000, maxOutputTokens: 4000 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'budget_exceeded');
    assert.match(r.message!, /per-task cap/i);
  });

  it('refuses once the daily total would be exceeded', () => {
    const cfg = testConfig();
    cfg.budget.daily_usd = 0.01;
    const store = memStore();
    recordUsage(store, {
      model: 'gpt-5.1',
      input_tokens: 1000,
      output_tokens: 1000,
      cost_usd: 0.009,
      latency_ms: 5,
      purpose: 'generate',
    });
    const r = checkBudget(cfg, store, { model: 'gpt-5.1', inputChars: 5000, maxOutputTokens: 2000 });
    assert.equal(r.allowed, false);
    assert.match(r.message!, /daily cap/i);
  });

  it('refuses once the monthly total would be exceeded', () => {
    const cfg = testConfig();
    cfg.budget.monthly_usd = 0.01;
    cfg.budget.daily_usd = 1000;
    const store = memStore();
    recordUsage(store, {
      model: 'gpt-5.1',
      input_tokens: 1000,
      output_tokens: 1000,
      cost_usd: 0.009,
      latency_ms: 5,
      purpose: 'generate',
    });
    const r = checkBudget(cfg, store, { model: 'gpt-5.1', inputChars: 5000, maxOutputTokens: 2000 });
    assert.equal(r.allowed, false);
    assert.match(r.message!, /monthly cap/i);
  });

  it('refuses once a task has made its maximum number of calls', () => {
    const cfg = testConfig();
    cfg.budget.max_calls_per_workflow = 2;
    const store = memStore();
    store.run(
      `INSERT INTO tasks (id, created_at, task_type, mode, mode_reason, sensitivity, irreversible,
        high_stakes, prompt_version, config_version, input_hash, request_excerpt, is_shadow)
       VALUES ('task_x', '2026-08-31T00:00:00Z','copy','GPT_ONLY','test','internal',0,0,'1','1','h',NULL,0)`,
    );
    for (let i = 0; i < 2; i++) {
      recordUsage(store, {
        model: 'gpt-5.1',
        input_tokens: 10,
        output_tokens: 10,
        cost_usd: 0.00001,
        latency_ms: 1,
        task_id: 'task_x',
        purpose: 'generate',
      });
    }
    const r = checkBudget(cfg, store, {
      model: 'gpt-5.1',
      inputChars: 100,
      maxOutputTokens: 100,
      taskId: 'task_x',
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'call_limit_exceeded');
  });

  it('degrades to per-call limits when the store is unavailable, and says so', () => {
    const cfg = testConfig();
    const snap = snapshot(cfg, null);
    assert.equal(snap.degraded, true);
    const r = checkBudget(cfg, null, { model: 'gpt-5.1', inputChars: 100, maxOutputTokens: 100 });
    assert.equal(r.allowed, true, 'a lost store must not block work');
    assert.equal(r.snapshot.degraded, true);
  });

  it('warns when an estimate is above the warn threshold', () => {
    const cfg = testConfig();
    cfg.budget.warn_estimate_usd = 0.000001;
    const r = checkBudget(cfg, memStore(), { model: 'gpt-5.1', inputChars: 100, maxOutputTokens: 100 });
    assert.equal(r.warn, true);
  });
});

describe('routing engine', () => {
  const cfg = testConfig();

  it('sends code to Claude by default', () => {
    const d = decideRoute(
      { task_type: 'code', original_request: 'fix the pagination bug in the leads table', allow_shadow: false },
      cfg,
    );
    assert.equal(d.mode, 'CLAUDE_ONLY');
  });

  it('sends copy to GPT by default', () => {
    const d = decideRoute(
      { task_type: 'copy', original_request: 'write the landing page copy for the kids programme', allow_shadow: false },
      cfg,
    );
    assert.equal(d.mode, 'GPT_ONLY');
  });

  it('lets an explicit instruction override the type default', () => {
    const d = decideRoute(
      {
        task_type: 'code',
        original_request: 'fix the bug',
        explicit_mode: 'GPT_ONLY',
        explicit_reason: 'you asked for GPT specifically',
      },
      cfg,
    );
    assert.equal(d.mode, 'GPT_ONLY');
    assert.equal(d.rule, 'explicit_user_instruction');
  });

  it('an explicit instruction beats even the high-stakes rule', () => {
    const d = decideRoute(
      {
        task_type: 'copy',
        original_request: 'just do it yourself',
        explicit_mode: 'CLAUDE_ONLY',
        high_stakes: true,
        irreversible: true,
        money_impact_ils: 50000,
      },
      cfg,
    );
    assert.equal(d.mode, 'CLAUDE_ONLY');
  });

  it('promotes an irreversible decision to competition', () => {
    const d = decideRoute(
      { task_type: 'copy', original_request: 'the launch email to the whole list', irreversible: true },
      cfg,
    );
    assert.equal(d.mode, 'COMPETITION');
    assert.match(d.reason, /hard to reverse/i);
  });

  it('promotes a high money impact to competition', () => {
    const d = decideRoute(
      { task_type: 'copy', original_request: 'the new campaign', money_impact_ils: 5000 },
      cfg,
    );
    assert.equal(d.mode, 'COMPETITION');
  });

  it('keeps a small rewrite on a single model', () => {
    const d = decideRoute(
      { task_type: 'small_rewrite', original_request: 'shorten this line', allow_shadow: false },
      cfg,
    );
    assert.equal(d.rule, 'small_task_single_model');
    assert.equal(d.shadow, false);
  });

  it('draws a shadow sample deterministically from a seed', () => {
    const c = testConfig();
    c.routing.shadow_sample_rate = 1.0;
    const long = 'x'.repeat(1000);
    const d = decideRoute({ task_type: 'copy', original_request: long, shadow_seed: 'seed-1' }, c);
    assert.equal(d.shadow, true);
    assert.match(d.notes.join(' '), /shadow sample/i);

    c.routing.shadow_sample_rate = 0;
    const d2 = decideRoute({ task_type: 'copy', original_request: long, shadow_seed: 'seed-1' }, c);
    assert.equal(d2.shadow, false);
  });

  it('produces a reproducible unit value from a seed', () => {
    assert.equal(seededUnit('abc'), seededUnit('abc'));
    assert.notEqual(seededUnit('abc'), seededUnit('abd'));
    const v = seededUnit('anything');
    assert.ok(v >= 0 && v <= 1);
  });
});

describe('general work, not just marketing', () => {
  const cfg = testConfig();

  it('routes a decision to competition, because it is cheap to compare and costly to get wrong', () => {
    const d = decideRoute(
      { task_type: 'decision', original_request: 'should we move off Supabase?', allow_shadow: false },
      cfg,
    );
    assert.equal(d.mode, 'COMPETITION');
  });

  it('keeps planning and explanation with Claude, which has the project context', () => {
    for (const t of ['planning', 'explanation'] as const) {
      const d = decideRoute({ task_type: t, original_request: 'x'.repeat(600), allow_shadow: false }, cfg);
      assert.equal(d.mode, 'CLAUDE_ONLY', `${t} should stay with Claude`);
    }
  });

  it('gives a reason that matches the mode it reports', () => {
    // Regression: the default branch said "Claude handles decision by default"
    // while reporting COMPETITION — two different claims in one line.
    for (const t of ['decision', 'naming', 'writing', 'planning', 'code'] as const) {
      const d = decideRoute({ task_type: t, original_request: 'x'.repeat(600), allow_shadow: false }, cfg);
      if (d.mode === 'COMPETITION') {
        assert.ok(!/^Claude handles/.test(d.reason), `${t}: "${d.reason}" contradicts COMPETITION`);
        assert.match(d.reason, /Both models/i);
      }
      if (d.mode === 'CLAUDE_ONLY') assert.match(d.reason, /^Claude handles/);
      if (d.mode === 'GPT_ONLY') assert.match(d.reason, /^GPT handles/);
    }
  });

  it('detects general task types from ordinary phrasing, in both languages', () => {
    assert.equal(detectTaskType('should we use Postgres or Supabase?'), 'decision');
    assert.equal(detectTaskType('האם כדאי לעבור למסד אחר'), 'decision');
    assert.equal(detectTaskType('תכנן לי את סדר העבודה'), 'planning');
    assert.equal(detectTaskType('explain how this works'), 'explanation');
    assert.equal(detectTaskType('איך לקרוא לפיצר הזה'), 'naming');
    assert.equal(detectTaskType('תרגם את זה לאנגלית'), 'translation');
  });

  it('has a rubric for every task type, so nothing falls through unscored', () => {
    const types = [
      'code', 'architecture', 'tests', 'ops', 'feature_spec',
      'copy', 'marketing_angle', 'value_proposition',
      'sales_analysis', 'qualitative_analysis', 'research_summary',
      'decision', 'writing', 'planning', 'explanation', 'naming', 'translation',
      'small_rewrite', 'other',
    ] as const;
    for (const t of types) {
      const r = rubricFor(t);
      assert.ok(r.criteria.length > 0, `${t} resolved to an empty rubric`);
    }
  });
});

describe('natural-language route detection', () => {
  it('detects a request for GPT in English and Hebrew', () => {
    assert.equal(detectExplicitMode('let GPT write the copy')?.mode, 'GPT_ONLY');
    assert.equal(detectExplicitMode('תן ל-GPT לכתוב את הקופי')?.mode, 'GPT_ONLY');
  });

  it('detects a request for a comparison', () => {
    assert.equal(detectExplicitMode('let both of you propose a version')?.mode, 'COMPETITION');
    assert.equal(detectExplicitMode('תנו לשניכם להציע גרסה ותשווה ביניהן')?.mode, 'COMPETITION');
  });

  it('detects a request for Claude alone', () => {
    assert.equal(detectExplicitMode('do it yourself, without GPT')?.mode, 'CLAUDE_ONLY');
    assert.equal(detectExplicitMode('תעשה לבד בלי GPT')?.mode, 'CLAUDE_ONLY');
  });

  it('detects a request for a critique', () => {
    assert.equal(detectExplicitMode('give me a second opinion on this draft')?.mode, 'GPT_CRITIQUE');
  });

  it('returns null when nothing explicit was said', () => {
    assert.equal(detectExplicitMode('write a landing page for the new programme'), null);
  });
});

describe('task type detection', () => {
  it('classifies common requests', () => {
    assert.equal(detectTaskType('write landing page copy'), 'copy');
    assert.equal(detectTaskType('תכתוב לי קופי לדף נחיתה'), 'copy');
    assert.equal(detectTaskType('נתח את שיחות המכירה'), 'sales_analysis');
    assert.equal(detectTaskType('נתח את שיחות מכירה'), 'sales_analysis');
    assert.equal(detectTaskType('fix the bug in the parser'), 'code');
    assert.equal(detectTaskType('what angle should we use'), 'marketing_angle');
  });

  it('falls back to other, which routes to Claude and spends nothing', () => {
    assert.equal(detectTaskType('hmm'), 'other');
  });

  it('validates route mode strings', () => {
    assert.equal(isRouteMode('COMPETITION'), true);
    assert.equal(isRouteMode('NONSENSE'), false);
  });
});

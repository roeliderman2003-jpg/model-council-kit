#!/usr/bin/env node
/**
 * The ONE real API call.
 *
 * Everything else in this project is tested against mocks. This script exists
 * so the first real call is deliberate, visible, cheap and confirmed — not a
 * surprise inside a workflow.
 *
 *   npm run smoke -- --dry     shows exactly what would be sent, calls nothing
 *   npm run smoke -- --confirm makes ONE generate call with the fast model
 *   npm run smoke -- --confirm --compare  adds ONE evaluate call
 *
 * Without --confirm it refuses to call, by design.
 */
import { loadConfig, getApiKey, rubricFor } from '../src/config';
import { OpenAIProvider } from '../src/providers/openai';
import { buildContextPack } from '../src/context/builder';
import { estimateCost } from '../src/budget';
import { runBlindCompare } from '../src/judge/blind';
import { CouncilError } from '../src/types';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const confirm = args.includes('--confirm');
const compare = args.includes('--compare');

const cfg = loadConfig();
const provider = new OpenAIProvider(cfg);

// A deliberately tiny, boring, non-sensitive task. No business data.
const pack = buildContextPack(
  {
    original_request: 'Write one short line of copy for a gym that trains adults in small groups.',
    task_type: 'copy',
    brief: 'One line. Under 15 words. Plain, no hype.',
    approved_facts: ['Groups are capped at eight people.', 'Sessions last 50 minutes.'],
    constraints: ['No promises about results.', 'No prices.'],
    audience: 'Adults aged 30-50 who have not trained in years.',
    desired_output: 'A single line of copy.',
    sensitivity: 'public',
  },
  cfg,
);

const model = cfg.models.fast;
const est = estimateCost(cfg, model, pack.char_count, 300);

console.log('\nModel Council — smoke test\n');
console.log(`model:            ${model}`);
console.log(`prompt size:      ${pack.char_count} chars`);
console.log(`estimated cost:   $${est.usd.toFixed(5)}${est.approximate ? ' (approximate)' : ''}`);
console.log(`key present:      ${getApiKey() ? 'yes' : 'NO'}`);
console.log(`calls to be made: ${dry || !confirm ? 0 : compare ? 2 : 1}`);

if (dry || !confirm) {
  console.log('\n--- exact payload that would be sent ---\n');
  console.log(pack.rendered);
  console.log('--- end of payload ---\n');
  if (!confirm) {
    console.log('Nothing was sent. Re-run with --confirm to make the real call:\n');
    console.log('  npm run smoke -- --confirm\n');
  }
  process.exit(0);
}

if (!getApiKey()) {
  console.error('\nOPENAI_API_KEY is not set in this process. See docs/WINDOWS-API-KEY.md.\n');
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    console.log('\nCalling the API...\n');
    const res = await provider.generate({
      model,
      prompt: pack.rendered,
      maxOutputTokens: 300,
      timeoutMs: cfg.budget.timeout_ms,
      retries: 1,
      requestLabel: 'smoke',
    });

    console.log('--- candidate ---');
    console.log(res.output.candidate);
    console.log('\n--- metadata ---');
    console.log(`assumptions:      ${res.output.assumptions.join(' | ') || '(none)'}`);
    console.log(`verify these:     ${res.output.facts_requiring_verification.join(' | ') || '(none)'}`);
    console.log(`confidence:       ${res.output.confidence}`);
    console.log(`tokens:           ${res.usage.input_tokens} in / ${res.usage.output_tokens} out`);
    console.log(`actual cost:      $${res.usage.cost_usd.toFixed(6)}`);
    console.log(`latency:          ${res.usage.latency_ms}ms`);
    console.log(`request id:       ${res.request_id}`);

    if (compare) {
      console.log('\nRunning one blind comparison against a deliberately weaker line...\n');
      const rubric = rubricFor('copy');
      const run = await runBlindCompare({
        task_id: 'smoke',
        provider,
        cfg,
        rubric,
        original_brief: 'One short line for a gym training adults in small groups of up to eight, 50 minutes.',
        candidate_a: res.output.candidate,
        candidate_b: 'Best gym ever! Guaranteed results, lose 10kg in 2 weeks, only 99 shekels!',
        randomization_seed: 'smoke-seed',
        model: cfg.models.fast,
      });
      console.log(`verdict:          ${run.result.verdict} (decided by ${run.result.decided_by})`);
      console.log(`scores:           A=${run.result.score_a} B=${run.result.score_b} gap=${run.result.gap}`);
      console.log(`hard failures A:  ${run.result.hard_failures_a.map((f) => f.rule_id).join(', ') || '(none)'}`);
      console.log(`hard failures B:  ${run.result.hard_failures_b.map((f) => f.rule_id).join(', ') || '(none)'}`);
      console.log(`evaluate cost:    $${run.usage.cost_usd.toFixed(6)}`);
      console.log(
        `\nExpected: B is disqualified on forbidden_promise and/or wrong_price, regardless of how it scores.`,
      );
    }

    console.log('\nSmoke test passed.\n');
  } catch (err) {
    if (err instanceof CouncilError) {
      console.error(`\nFAILED (${err.reason}): ${err.message}`);
      console.error(`Suggestion: ${err.suggestion}\n`);
    } else {
      console.error(`\nFAILED: ${(err as Error).message}\n`);
    }
    process.exit(1);
  }
}

void main();

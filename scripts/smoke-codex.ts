#!/usr/bin/env node
/**
 * End-to-end smoke test through the Codex CLI on the ChatGPT subscription.
 *
 * Deliberately separate from scripts/smoke.ts, which exercises the billed API
 * path. This one costs no money — it draws on the plan's included usage — so it
 * does not need the --confirm gate that the paid path does. What it does spend
 * is plan rate limit, which is shared with interactive Codex, so it stays small.
 */
import { loadConfig, rubricFor } from '../src/config';
import { CodexProvider, readCodexAuth, findCodexBinary } from '../src/providers/codex';
import { selectProvider } from '../src/providers/select';
import { buildContextPack } from '../src/context/builder';
import { runBlindCompare } from '../src/judge/blind';
import { CouncilError } from '../src/types';

const cfg = loadConfig();
const compare = process.argv.includes('--compare');

const auth = readCodexAuth();
const binary = findCodexBinary();
const choice = selectProvider(cfg);

console.log('\nModel Council — Codex (ChatGPT subscription) smoke test\n');
console.log(`binary:      ${binary ?? 'NOT FOUND'}`);
console.log(`auth_mode:   ${auth.mode ?? 'not signed in'}`);
console.log(`subscription: ${auth.isSubscription ? 'YES — no API billing' : 'NO'}`);
console.log(`selected:    ${choice.provider.id}`);
console.log(`billing:     ${choice.billing}`);
if (choice.note) console.log(`note:        ${choice.note}`);

if (!auth.isSubscription) {
  console.log(
    '\nThis script is for the subscription path. auth_mode is not "chatgpt", so stopping here rather than making a call that might be billed.\n',
  );
  process.exit(1);
}

const provider = new CodexProvider(cfg);

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

async function main(): Promise<void> {
  try {
    console.log(`\nGenerating (timeout ${cfg.budget.codex_timeout_ms}ms)...\n`);
    const res = await provider.generate({
      model: cfg.models.codex_model,
      prompt: pack.rendered,
      maxOutputTokens: cfg.budget.max_output_tokens,
      timeoutMs: cfg.budget.codex_timeout_ms,
      retries: 0,
      requestLabel: 'smoke-codex',
    });

    console.log('--- candidate ---');
    console.log(res.output.candidate);
    console.log('\n--- metadata ---');
    console.log(`assumptions:  ${res.output.assumptions.join(' | ') || '(none)'}`);
    console.log(`verify these: ${res.output.facts_requiring_verification.join(' | ') || '(none)'}`);
    console.log(`confidence:   ${res.output.confidence}`);
    console.log(`tokens:       ${res.usage.input_tokens} in / ${res.usage.output_tokens} out`);
    console.log(`cost:         $${res.usage.cost_usd.toFixed(4)}  <-- subscription, not billed`);
    console.log(`latency:      ${res.usage.latency_ms}ms`);
    console.log(`thread:       ${res.request_id}`);

    if (compare) {
      console.log('\nRunning one blind comparison against a deliberately non-compliant line...\n');
      const run = await runBlindCompare({
        task_id: 'smoke-codex',
        provider,
        cfg,
        rubric: rubricFor('copy'),
        original_brief:
          'One short line for a gym training adults in small groups of up to eight, 50 minutes. Approved facts: groups capped at eight; sessions are 50 minutes. No results promises. No prices.',
        candidate_a: res.output.candidate,
        candidate_b: 'Best gym ever! Guaranteed results, lose 10kg in 2 weeks, only 99 shekels!',
        randomization_seed: 'codex-smoke-seed',
        model: cfg.models.codex_model,
      });
      console.log(`verdict:         ${run.result.verdict} (decided by ${run.result.decided_by})`);
      console.log(`scores:          A=${run.result.score_a} B=${run.result.score_b} gap=${run.result.gap}`);
      console.log(
        `hard failures A: ${run.result.hard_failures_a.map((f) => f.rule_id).join(', ') || '(none)'}`,
      );
      console.log(
        `hard failures B: ${run.result.hard_failures_b.map((f) => f.rule_id).join(', ') || '(none)'}`,
      );
      console.log(`judge tokens:    ${run.usage.input_tokens} in / ${run.usage.output_tokens} out`);
      console.log(
        `\nExpected: B disqualified on forbidden_promise and/or wrong_price, whatever it scores.`,
      );
    }

    console.log('\nSmoke test passed. No API charge — this ran on your ChatGPT plan.\n');
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

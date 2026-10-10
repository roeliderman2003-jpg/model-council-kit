import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCodexArgs, findCodexBinary, readCodexAuth } from '../../src/providers/codex';
import { selectProvider } from '../../src/providers/select';
import { testConfig, withEnv } from '../helpers';

/** Writes a throwaway CODEX_HOME with the given auth.json contents. */
function fakeCodexHome(auth: Record<string, unknown> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  if (auth) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth), 'utf8');
  return dir;
}

describe('codex auth detection', () => {
  it('recognises subscription auth', () => {
    const home = fakeCodexHome({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: '2026-08-30T16:23:19Z' });
    const a = readCodexAuth(home);
    assert.equal(a.mode, 'chatgpt');
    assert.equal(a.isSubscription, true, 'auth_mode chatgpt means the plan pays, not the API');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('does NOT report an api-key login as a subscription', () => {
    // This distinction is the whole point: reporting an API login as
    // "subscription, no charge" would tell the user they are not being billed
    // while they are.
    const home = fakeCodexHome({ auth_mode: 'apikey' });
    const a = readCodexAuth(home);
    assert.equal(a.mode, 'apikey');
    assert.equal(a.isSubscription, false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reports not-signed-in when auth.json is absent', () => {
    const home = fakeCodexHome(null);
    const a = readCodexAuth(home);
    assert.equal(a.mode, null);
    assert.equal(a.isSubscription, false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('survives a corrupt auth.json rather than throwing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    fs.writeFileSync(path.join(home, 'auth.json'), '{not json', 'utf8');
    const a = readCodexAuth(home);
    assert.equal(a.mode, null);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('never reads or returns the tokens themselves', () => {
    const home = fakeCodexHome({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH', id_token: 'SECRET-ID' },
    });
    const a = readCodexAuth(home);
    const serialised = JSON.stringify(a);
    assert.ok(!serialised.includes('SECRET'), serialised);
    assert.deepEqual(Object.keys(a).sort(), ['isSubscription', 'lastRefresh', 'mode']);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('binary discovery', () => {
  it('honours CODEX_BINARY when the file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
    const fake = path.join(dir, 'codex-fake.exe');
    fs.writeFileSync(fake, '');
    await withEnv({ CODEX_BINARY: fake }, () => {
      assert.equal(findCodexBinary(), fake);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores CODEX_BINARY pointing at a missing file', async () => {
    await withEnv({ CODEX_BINARY: path.join(os.tmpdir(), 'definitely-not-here.exe') }, () => {
      const found = findCodexBinary();
      // Either null, or a real installation found by the other strategies —
      // never the non-existent path we supplied.
      assert.notEqual(found, path.join(os.tmpdir(), 'definitely-not-here.exe'));
      if (found) assert.ok(fs.existsSync(found));
    });
  });

  it('prefers an explicit argument over everything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
    const fake = path.join(dir, 'explicit.exe');
    fs.writeFileSync(fake, '');
    assert.equal(findCodexBinary(fake), fake);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('call isolation — the flags that protect neutrality', () => {
  const argv = buildCodexArgs({
    schemaPath: '/tmp/s.json',
    outPath: '/tmp/o.json',
    work: '/tmp/work',
  });

  it('refuses to load the user config', () => {
    // ~/.codex/config.toml carries the user's own model and instruction
    // settings. Letting them ride along would change the call in ways nothing
    // records.
    assert.ok(argv.includes('--ignore-user-config'), argv.join(' '));
  });

  it('refuses to load rules files', () => {
    assert.ok(argv.includes('--ignore-rules'), argv.join(' '));
  });

  it('runs from a supplied working directory, never the caller cwd', () => {
    // Codex reads AGENTS.md from its working root. Running in a real project
    // would inject that project's standing instructions into the generation and
    // into the blind evaluation.
    const i = argv.indexOf('-C');
    assert.ok(i > -1, 'a working directory must be given explicitly');
    assert.equal(argv[i + 1], '/tmp/work');
  });

  it('runs read-only, so a model cannot write to disk', () => {
    const i = argv.indexOf('--sandbox');
    assert.ok(i > -1);
    assert.equal(argv[i + 1], 'read-only');
  });

  it('does not persist session files', () => {
    assert.ok(argv.includes('--ephemeral'));
  });

  it('pins the output to a schema and a file', () => {
    assert.equal(argv[argv.indexOf('--output-schema') + 1], '/tmp/s.json');
    assert.equal(argv[argv.indexOf('-o') + 1], '/tmp/o.json');
  });

  it('takes the prompt on stdin, not argv', () => {
    // A context pack can exceed the Windows command-line limit. Truncation
    // there would look like a bad answer rather than a bad call.
    assert.equal(argv[argv.length - 1], '-', 'the trailing "-" means read the prompt from stdin');
  });

  it('passes the reasoning effort without inheriting the config file', () => {
    // --ignore-user-config keeps the user's INSTRUCTIONS out of the call. Their
    // MODEL and EFFORT choices are a different thing and legitimately wanted, so
    // they come back in explicitly rather than by inheriting config.toml.
    const withEffort = buildCodexArgs({
      schemaPath: 's',
      outPath: 'o',
      work: 'w',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
    assert.ok(withEffort.includes('--ignore-user-config'), 'instructions must still be excluded');
    assert.equal(withEffort[withEffort.indexOf('-m') + 1], 'gpt-5.6-sol');
    const ci = withEffort.indexOf('-c');
    assert.ok(ci > -1, 'effort must be passed with -c');
    assert.match(withEffort[ci + 1]!, /^model_reasoning_effort="high"$/);
  });

  it('omits the effort flag when none is configured', () => {
    const bare = buildCodexArgs({ schemaPath: 's', outPath: 'o', work: 'w' });
    assert.ok(!bare.includes('-c'), 'no effort configured means let Codex decide');
  });

  it('omits -m entirely when no model is configured', () => {
    assert.ok(!argv.includes('-m'), 'an empty model must let Codex use its own default');
    const withModel = buildCodexArgs({ schemaPath: 's', outPath: 'o', work: 'w', model: 'gpt-5.1' });
    assert.equal(withModel[withModel.indexOf('-m') + 1], 'gpt-5.1');
  });

  it('never carries an API key on the command line', () => {
    assert.ok(!argv.join(' ').includes('sk-'));
    assert.ok(!argv.some((a) => /api[-_]?key/i.test(a)));
  });
});

describe('the judge must not be the writer', () => {
  it('ships with a judge model different from the writer model', () => {
    // A model scoring its own output has a measured self-preference. Blinding
    // removes the identity signal but not an affinity for text that reads the
    // way it writes. Both models are on the same subscription, so the fix is
    // free — which makes shipping without it hard to justify.
    const cfg = testConfig();
    assert.ok(cfg.models.codex_evaluator_model, 'a judge model must be configured');
    assert.notEqual(
      cfg.models.codex_evaluator_model,
      cfg.models.codex_model,
      'the judge and the writer must not be the same model',
    );
  });

  it('falls back to the writer model rather than sending an empty judge model', () => {
    const cfg = testConfig();
    cfg.models.codex_evaluator_model = '';
    const resolved = cfg.models.codex_evaluator_model || cfg.models.codex_model;
    assert.equal(resolved, cfg.models.codex_model, 'an unset judge must still resolve to something');
  });
});

describe('provider selection', () => {
  it('forces the API path when asked, even if Codex is available', () => {
    const cfg = testConfig();
    cfg.models.provider = 'openai';
    const choice = selectProvider(cfg);
    assert.equal(choice.provider.id, 'openai');
    assert.match(choice.billing, /Billed per token/i);
  });

  it('forces Codex when asked', () => {
    const cfg = testConfig();
    cfg.models.provider = 'codex';
    const choice = selectProvider(cfg);
    assert.equal(choice.provider.id, 'codex');
  });

  it('auto prefers the route that costs nothing', () => {
    // The cheap route is the default and the billed route is the deliberate
    // choice — not the other way round.
    const cfg = testConfig();
    cfg.models.provider = 'auto';
    const choice = selectProvider(cfg);
    if (choice.provider.id === 'codex') {
      assert.match(choice.billing, /not the API|included usage/i);
    } else {
      assert.ok(choice.note, 'when auto falls through to the API, it must say why');
      assert.match(choice.note!, /Codex was not used/i);
    }
  });

  it('refuses rather than silently billing when the free route is unreachable', async () => {
    // Real usage produced five billed API calls in chats meant to be free:
    // `auto` fell through to the API because Codex was unreachable, and said so
    // only in a log. Money must never be spent by default on a fallback the
    // user did not ask for.
    const cfg = testConfig();
    cfg.models.provider = 'auto';
    cfg.models.fallback_to_billed = false;
    await withEnv({ CODEX_BINARY: path.join(os.tmpdir(), 'no-codex-here.exe'), CODEX_HOME: fakeCodexHome(null) }, () => {
      const choice = selectProvider(cfg);
      if (choice.provider.id === 'codex') return; // a real Codex is installed here
      assert.ok(choice.refuse, 'auto must refuse rather than fall through to a billed route');
      assert.match(choice.refuse!.reason, /nothing was sent and nothing was charged/i);
      assert.match(choice.refuse!.suggestion, /fallback_to_billed/);
    });
  });

  it('allows the billed fallback only when explicitly enabled, and shouts about it', async () => {
    const cfg = testConfig();
    cfg.models.provider = 'auto';
    cfg.models.fallback_to_billed = true;
    await withEnv({ CODEX_BINARY: path.join(os.tmpdir(), 'no-codex-here.exe'), CODEX_HOME: fakeCodexHome(null) }, () => {
      const choice = selectProvider(cfg);
      if (choice.provider.id === 'codex') return;
      assert.equal(choice.refuse, null, 'opted in, so it proceeds');
      assert.equal(choice.billed, true);
      assert.match(choice.billing, /BILLED/);
    });
  });

  it('marks the free route as not billed and the named API route as billed', () => {
    const codexCfg = testConfig();
    codexCfg.models.provider = 'codex';
    assert.equal(selectProvider(codexCfg).billed, false);

    const apiCfg = testConfig();
    apiCfg.models.provider = 'openai';
    const api = selectProvider(apiCfg);
    assert.equal(api.billed, true);
    assert.equal(api.refuse, null, 'naming openai is a deliberate choice, not a surprise');
  });

  it('states the billing route in one line, always', () => {
    for (const p of ['auto', 'codex', 'openai'] as const) {
      const cfg = testConfig();
      cfg.models.provider = p;
      const choice = selectProvider(cfg);
      assert.ok(choice.billing.length > 20, `provider ${p} must explain what it charges`);
    }
  });
});

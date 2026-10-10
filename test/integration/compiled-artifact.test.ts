import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Boots the COMPILED server — the artefact Claude Code actually launches.
 *
 * Every other integration test runs the TypeScript through tsx. That is a
 * different artefact with a different __dirname, and the difference is not
 * cosmetic: PROJECT_ROOT was `__dirname/..`, correct from src/ and pointing at
 * dist/ once compiled, so the shipped server could not find config/default.json
 * and exited at startup. The whole suite was green while the thing that ships
 * was dead on arrival.
 *
 * This file is the guard against that class of bug. It also asserts the boot is
 * fast enough to clear the MCP connect timeout, which is what turned the
 * failure into "the server just doesn't appear" rather than an error anyone saw.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const BUILT = path.join(ROOT, 'dist', 'src', 'server.js');
/** The host gives a server 30s to connect. Stay well inside it. */
const BOOT_BUDGET_MS = 10000;
/**
 * A handshake budget with real headroom. The host allows 30s, but it starts
 * every configured server at once on a cold disk, so a server that needs even
 * a few seconds alone can miss it under contention.
 */
const HOST_CONNECT_BUDGET_MS = 8000;

let client: Client | null = null;
let tmpDb: string;
let bootMs = 0;

before(async () => {
  // Build if needed, so the test is self-sufficient rather than depending on
  // whoever ran it having built first.
  if (!fs.existsSync(BUILT)) {
    execFileSync('npm', ['run', 'build'], {
      cwd: ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
      timeout: 300000,
    });
  }

  tmpDb = path.join(os.tmpdir(), `council-dist-${process.pid}-${Date.now()}.db`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUILT],
    env: {
      ...(process.env as Record<string, string>),
      MODEL_COUNCIL_DB_PATH: tmpDb,
      // Force the API route with no key, so the fallback note this test
      // asserts on is actually produced. Under 'auto' the Codex route would
      // succeed and there would be no fallback to observe.
      OPENAI_API_KEY: '',
      MODEL_COUNCIL_PROVIDER: 'openai',
    },
    stderr: 'pipe',
  });
  const started = Date.now();
  client = new Client({ name: 'dist-test-client', version: '1.0.0' });
  await client.connect(transport);
  bootMs = Date.now() - started;
});

after(async () => {
  await client?.close().catch(() => {});
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch {
      /* nothing to clean */
    }
  }
});

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  assert.ok(content?.[0]?.text, 'a tool must return text content');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('the compiled artefact, which is what actually ships', () => {
  it('exists after a build', () => {
    assert.ok(fs.existsSync(BUILT), `${BUILT} must exist — the MCP registration points at it`);
  });

  it('starts and serves all seven tools', async () => {
    const { tools } = await client!.listTools();
    assert.equal(tools.length, 7, `expected 7 tools, got ${tools.map((t) => t.name).join(',')}`);
  });

  it('boots fast enough to clear the host connect timeout', () => {
    // Regression: registered through tsx, the server recompiled its whole
    // dependency tree on every boot — ~17s warm, past 30s on a cold disk after
    // a reboot — and simply never appeared.
    assert.ok(
      bootMs < BOOT_BUDGET_MS,
      `compiled boot took ${bootMs}ms, over the ${BOOT_BUDGET_MS}ms budget. Is the registration pointing at tsx again?`,
    );
  });

  it('finds its config from the compiled location', async () => {
    // Regression: PROJECT_ROOT was __dirname/.., which resolves to dist/ once
    // compiled. config/default.json is not there, so the server died at startup
    // with "config/default.json is missing".
    const res = parse(await client!.callTool({ name: 'council_config', arguments: { section: 'models' } }));
    assert.equal(res['ok'], true, JSON.stringify(res));
    const models = res['models'] as {
      generator: string;
      active_route: string;
      codex_model: string;
      codex_reasoning_effort: string;
    };
    assert.ok(models.generator.length > 0, 'a model name proves default.json was read');
    // The route and the Codex model must be visible. Reporting only the API
    // model names hid that the Codex route ran on a different model entirely.
    assert.ok(models.active_route, 'the active route must be reported');
    assert.ok(models.codex_model, 'the Codex model must be reported');
    assert.ok(models.codex_reasoning_effort, 'the reasoning effort must be reported');
  });

  it('finds its rubrics from the compiled location', async () => {
    const res = parse(await client!.callTool({ name: 'council_config', arguments: { section: 'rubrics' } }));
    const rubrics = res['rubrics'] as Array<{ id: string }>;
    assert.ok(Array.isArray(rubrics) && rubrics.length >= 3, 'config/rubrics/ must resolve too');
    assert.ok(rubrics.some((r) => r.id === 'copy'));
  });

  it('opens its database and answers a real tool call', async () => {
    const reg = parse(
      await client!.callTool({
        name: 'register_candidate',
        arguments: { task_type: 'copy', author: 'claude', text: 'compiled path works' },
      }),
    );
    assert.equal(reg['ok'], true, JSON.stringify(reg));
    assert.match(String(reg['task_id']), /^task_/);
  });

  it('carries the notes fix in the shipped build', async () => {
    const res = parse(
      await client!.callTool({
        name: 'route_task',
        arguments: { original_request: 'the launch email', task_type: 'copy', irreversible: true },
      }),
    );
    const notes = res['notes'] as string[];
    assert.ok(Array.isArray(notes) && notes.length > 0, 'the compiled build must carry the render() merge fix');
  });

  it('launches from exactly what .claude.json registers', async () => {
    // The suite used to spawn a command of its own devising. The failure that
    // actually happened was the HOST launching ITS registered command and
    // timing out, so this reads the registration and boots that.
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const claudeJson = path.join(home, '.claude.json');
    if (!fs.existsSync(claudeJson)) return; // not installed on this machine

    let entry: { command?: string; args?: string[] } | undefined;
    try {
      entry = JSON.parse(fs.readFileSync(claudeJson, 'utf8')).mcpServers?.['model-council'];
    } catch {
      return; // unreadable is a separate problem, not this test's
    }
    if (!entry) return; // not registered here

    assert.ok(entry.command, 'the registration must name a command');
    assert.ok(
      path.isAbsolute(entry.command!),
      `command must be an absolute path, not "${entry.command}" — the host resolves it against its own environment, and a bare name that fails to resolve surfaces as a connect timeout`,
    );
    assert.ok(fs.existsSync(entry.command!), `registered command does not exist: ${entry.command}`);

    const target = entry.args?.[0];
    assert.ok(target, 'the registration must name a server file');
    assert.ok(fs.existsSync(target!), `registered server file does not exist: ${target}`);
    assert.ok(
      !target!.includes('tsx'),
      'the registration must point at the compiled server, not at tsx — tsx recompiles on every boot and misses the connect timeout',
    );

    // Boot it and complete a real handshake.
    const probeDb = path.join(os.tmpdir(), `council-reg-${process.pid}-${Date.now()}.db`);
    const t = new StdioClientTransport({
      command: entry.command!,
      args: entry.args ?? [],
      env: { ...(process.env as Record<string, string>), MODEL_COUNCIL_DB_PATH: probeDb },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'registration-probe', version: '1.0.0' });
    const started = Date.now();
    try {
      await c.connect(t);
      const elapsed = Date.now() - started;
      const { tools } = await c.listTools();
      assert.equal(tools.length, 7, 'the registered server must serve all seven tools');
      assert.ok(
        elapsed < HOST_CONNECT_BUDGET_MS,
        `the registered command took ${elapsed}ms to hand shake, over the ${HOST_CONNECT_BUDGET_MS}ms working budget`,
      );
    } finally {
      await c.close().catch(() => {});
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          fs.unlinkSync(probeDb + suffix);
        } catch {
          /* nothing to clean */
        }
      }
    }
  });

  it('does nothing expensive before the handshake', async () => {
    // Provider selection and store opening are deliberately deferred to the
    // first tool call. Anything costly before `connect` spends the host's
    // 30-second budget for no benefit, and a server that is merely slow to warm
    // up is indistinguishable from one that is broken.
    const probeDb = path.join(os.tmpdir(), `council-lazy-${process.pid}-${Date.now()}.db`);
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [BUILT],
      env: { ...(process.env as Record<string, string>), MODEL_COUNCIL_DB_PATH: probeDb },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'lazy-probe', version: '1.0.0' });
    const started = Date.now();
    try {
      await c.connect(t);
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < HOST_CONNECT_BUDGET_MS,
        `handshake took ${elapsed}ms. Did initialisation move back in front of connect()?`,
      );
      // The store file must not exist yet: nothing has called a tool.
      assert.ok(
        !fs.existsSync(probeDb),
        'the database was opened during startup — it must wait for the first tool call',
      );
    } finally {
      await c.close().catch(() => {});
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try {
          fs.unlinkSync(probeDb + suffix);
        } catch {
          /* nothing to clean */
        }
      }
    }
  });

  it('is not stale relative to the source it was built from', () => {
    // A dist older than src means someone edited and forgot to rebuild, and the
    // running server would be serving yesterday's code.
    const newestSrc = fs
      .readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.statSync(path.join(ROOT, 'src', f)).mtimeMs);
    const builtAt = fs.statSync(BUILT).mtimeMs;
    const newest = Math.max(...newestSrc);
    assert.ok(
      builtAt >= newest - 1000,
      `dist is older than src — run \`npm run build\`. dist=${new Date(builtAt).toISOString()} src=${new Date(newest).toISOString()}`,
    );
  });
});

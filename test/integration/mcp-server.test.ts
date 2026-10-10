import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Drives the actual server binary over a real stdio transport, so this covers
 * the wiring the MCP host will use: tool registration, schema shapes, the JSON
 * envelope, and the guarantee that nothing but protocol reaches stdout.
 */

const ROOT = path.resolve(__dirname, '..', '..');

let client: Client;
let transport: StdioClientTransport;
let tmpDb: string;

before(async () => {
  tmpDb = path.join(os.tmpdir(), `council-test-${process.pid}-${Date.now()}.db`);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MODEL_COUNCIL_DB_PATH: tmpDb,
      // No API key AND the API route forced. Since the Codex CLI can reach
      // GPT on a ChatGPT subscription, an empty key alone no longer means
      // GPT is unreachable — forcing the billed route is what actually
      // reproduces "there is no way to call GPT", which is the state these
      // fallback assertions are about.
      OPENAI_API_KEY: '',
      MODEL_COUNCIL_PROVIDER: 'openai',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'council-test-client', version: '1.0.0' });
  await client.connect(transport);
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

/** True when the Codex CLI is installed and signed in on this machine. */
function readCodexAuthForTest(): boolean {
  try {
    const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex');
    const j = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) as { auth_mode?: string };
    if (!j.auth_mode) return false;
  } catch {
    return false;
  }
  const localApp = process.env.LOCALAPPDATA;
  if (!localApp) return false;
  const binRoot = path.join(localApp, 'OpenAI', 'Codex', 'bin');
  if (!fs.existsSync(binRoot)) return false;
  return fs.readdirSync(binRoot).some((d) => fs.existsSync(path.join(binRoot, d, 'codex.exe')));
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  assert.ok(content?.[0]?.text, 'a tool must return text content');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe('MCP server over a real stdio transport', () => {
  it('connects and advertises every tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'blind_compare',
      'council_config',
      'gpt_generate',
      'record_outcome',
      'register_candidate',
      'route_task',
      'routing_stats',
    ]);
  });

  it('gives every tool a description and an input schema', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 40, `${t.name} needs a real description`);
      assert.ok(t.inputSchema, `${t.name} needs an input schema`);
    }
  });

  it('carries instructions that state Claude may not judge itself', async () => {
    const instructions = client.getInstructions();
    assert.ok(instructions, 'the server must supply instructions');
    assert.match(instructions!, /may not declare itself the winner/i);
    assert.match(instructions!, /NEEDS_USER_DECISION/);
  });

  it('routes a task without an API key and reports the fallback', async () => {
    const res = await client.callTool({
      name: 'route_task',
      arguments: { original_request: 'write the landing page copy for the mothers programme', task_type: 'copy' },
    });
    const data = parse(res);
    assert.equal(data['ok'], true);
    assert.equal(data['mode'], 'CLAUDE_ONLY', 'no key means Claude handles it');
    assert.equal(data['gpt_available'], false);
    assert.match(String(data['reason']), /GPT is unavailable/i);
  });

  it('does not clobber notes a tool carried inside its data', async () => {
    // Regression: render() set `notes: result.notes` AFTER spreading data, so a
    // tool that put notes in its data had them replaced by the empty envelope
    // list. Both unit and MCP tests missed it because the unit test called the
    // handler directly and the MCP test only asserted on `reason`.
    const res = await client.callTool({
      name: 'route_task',
      arguments: {
        original_request: 'write the launch email to the whole list',
        task_type: 'copy',
        irreversible: true,
      },
    });
    const data = parse(res);
    const notes = data['notes'] as string[];
    assert.ok(Array.isArray(notes) && notes.length > 0, 'the fallback note must survive rendering');
    assert.ok(notes.some((n) => /OPENAI_API_KEY|Falling back/i.test(n)), notes.join(' | '));
  });

  it('gives a reason that does not contradict the mode it reports', async () => {
    // Regression: the fallback sentence was appended to the original one, so it
    // read "Both models will answer independently ... (GPT unavailable, so
    // Claude handles it)" — two opposite claims in one line.
    const res = await client.callTool({
      name: 'route_task',
      arguments: { original_request: 'the launch page', task_type: 'copy', high_stakes: true },
    });
    const data = parse(res);
    const mode = String(data['mode']);
    const reason = String(data['reason']);
    if (mode === 'CLAUDE_ONLY') {
      // The counterfactual ("it would otherwise be COMPETITION") is useful and
      // may stay. What must not happen is the sentence OPENING with a promise
      // the mode contradicts, which is how the original bug read.
      const firstSentence = reason.split(/(?<=\.)\s/)[0] ?? reason;
      assert.ok(
        !/both models will answer/i.test(firstSentence),
        `a CLAUDE_ONLY verdict must not open by promising both models: "${firstSentence}"`,
      );
      assert.match(firstSentence, /Claude handles it alone/i);
      assert.ok(
        !/^Both models/i.test(reason),
        `the reason must lead with what actually happens: "${reason}"`,
      );
    }
  });

  it('reaches GPT with no API key when the Codex route is available', async () => {
    // The point of the Codex provider: a ChatGPT subscription, not an API
    // key, is enough. This client forces the API route, so it asks a
    // second server that uses the default 'auto' selection.
    const probeDb = path.join(os.tmpdir(), `council-auto-${process.pid}-${Date.now()}.db`);
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server.ts')],
      env: {
        ...(process.env as Record<string, string>),
        MODEL_COUNCIL_DB_PATH: probeDb,
        OPENAI_API_KEY: '',
        MODEL_COUNCIL_PROVIDER: 'auto',
      },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'auto-probe', version: '1.0.0' });
    await c.connect(t);
    try {
      const data = parse(
        await c.callTool({
          name: 'route_task',
          arguments: { original_request: 'write the landing page copy', task_type: 'copy' },
        }),
      );
      const codexReachable = readCodexAuthForTest();
      if (codexReachable) {
        assert.equal(data['gpt_available'], true, 'Codex on a subscription makes GPT reachable without a key');
        assert.equal(data['mode'], 'GPT_ONLY', 'copy still routes to GPT');
      } else {
        assert.equal(data['gpt_available'], false, 'with neither route, GPT is unreachable');
        assert.equal(data['mode'], 'CLAUDE_ONLY');
      }
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

  it('honours an explicit mode over the type default', async () => {
    const res = await client.callTool({
      name: 'route_task',
      arguments: { original_request: 'fix the parser', task_type: 'code', explicit_mode: 'COMPETITION' },
    });
    const data = parse(res);
    // With no key the fallback still applies, but the RULE that fired must be
    // the explicit one, not the type default.
    assert.equal(data['rule'], 'explicit_user_instruction');
  });

  it('returns a structured refusal, not a transport error, when the key is missing', async () => {
    const res = await client.callTool({
      name: 'gpt_generate',
      arguments: { original_request: 'write a headline', task_type: 'copy', brief: 'a headline' },
    });
    assert.notEqual((res as { isError?: boolean }).isError, true, 'a missing key is an answer, not a fault');
    const data = parse(res);
    assert.equal(data['ok'], false);
    const err = data['error'] as { reason: string; suggestion: string };
    assert.equal(err.reason, 'no_api_key');
    assert.match(err.suggestion, /Claude continues/i);
  });

  it('runs a dry run with no key and no spend', async () => {
    const res = await client.callTool({
      name: 'gpt_generate',
      arguments: {
        original_request: 'write a headline',
        task_type: 'copy',
        brief: 'a headline for the kids programme',
        approved_facts: ['sessions are 50 minutes'],
        dry_run: true,
      },
    });
    const data = parse(res);
    assert.equal(data['ok'], true);
    assert.equal(data['sent_to_gpt'], false);
    assert.ok(String(data['prompt_preview']).includes('sessions are 50 minutes'));
  });

  it('shows the configuration and leaks no secret', async () => {
    const res = await client.callTool({ name: 'council_config', arguments: {} });
    const data = parse(res);
    assert.equal(data['ok'], true);
    const text = JSON.stringify(data);
    // The ban is on a key VALUE. The string "api_key" legitimately appears as
    // the name of a redaction kind and inside "OPENAI_API_KEY is not set" —
    // both are names of things, and a test that banned the noun would be
    // banning the documentation rather than the secret.
    assert.ok(!/sk-[A-Za-z0-9_-]{16,}/.test(text), 'no key-shaped value may appear');
    assert.ok(!/"(?:api_?key|apiKey|secret|token)"\s*:\s*"[^"]{8,}"/i.test(text), 'no field may hold a credential');
    const models = data['models'] as { generator: string; evaluator: string };
    assert.ok(models.generator.length > 0);
  });

  it('persists a candidate and reads it back through the statistics', async () => {
    const reg = await client.callTool({
      name: 'register_candidate',
      arguments: {
        task_type: 'copy',
        author: 'claude',
        text: 'a headline Claude produced',
        original_request: 'write a headline',
      },
    });
    const regData = parse(reg);
    assert.equal(regData['ok'], true);
    const taskId = String(regData['task_id']);
    assert.match(taskId, /^task_/);

    const stats = await client.callTool({ name: 'routing_stats', arguments: { min_sample_size: 1 } });
    const statsData = parse(stats);
    assert.equal(statsData['ok'], true);
    const totals = statsData['totals'] as { tasks: number };
    assert.ok(totals.tasks >= 1, 'the registered task must appear in the statistics');
  });

  it('records an outcome against a real task id', async () => {
    const reg = parse(
      await client.callTool({
        name: 'register_candidate',
        arguments: { task_type: 'copy', author: 'gpt', text: 'variant B' },
      }),
    );
    const taskId = String(reg['task_id']);

    const out = parse(
      await client.callTool({
        name: 'record_outcome',
        arguments: {
          task_id: taskId,
          chosen_author: 'gpt',
          metric_type: 'cpl',
          metric_value: 42,
          window: '2026-08-01..2026-08-31',
          is_final: true,
        },
      }),
    );
    assert.equal(out['ok'], true);
    const recorded = out['recorded'] as { metric_value: number };
    assert.equal(recorded.metric_value, 42);
  });

  it('rejects an outcome for an unknown task with a usable message', async () => {
    const out = parse(
      await client.callTool({
        name: 'record_outcome',
        arguments: {
          task_id: 'task_does_not_exist',
          chosen_author: 'gpt',
          metric_type: 'cpl',
          metric_value: 1,
          window: 'w',
          is_final: true,
        },
      }),
    );
    assert.equal(out['ok'], false);
    assert.match(String((out['error'] as { message: string }).message), /No task with id/);
  });

  it('rejects input that violates the schema at the protocol boundary', async () => {
    // The SDK returns a protocol-level validation error rather than throwing,
    // so the assertion is on isError plus the message it carries.
    const res = (await client.callTool({
      name: 'record_outcome',
      arguments: {
        task_id: 'task_x',
        chosen_author: 'martian',
        metric_type: 'cpl',
        metric_value: 1,
        window: 'w',
        is_final: true,
      },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(res.isError, true, 'an invalid enum value must not reach the handler');
    assert.match(res.content[0]!.text, /Invalid enum value/i);
    assert.match(res.content[0]!.text, /chosen_author/);
  });

  it('rejects a missing required field', async () => {
    const res = (await client.callTool({
      name: 'gpt_generate',
      arguments: { task_type: 'copy', brief: 'no original_request supplied' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /original_request/);
  });

  it('produces a blind judge prompt over the wire with no identities in it', async () => {
    const res = parse(
      await client.callTool({
        name: 'blind_compare',
        arguments: {
          original_brief: 'a headline for the launch',
          candidate_a: 'Claude here: train where they know your name',
          candidate_b: 'GPT version: the gym that remembers you',
          author_a: 'claude',
          author_b: 'gpt',
          task_type: 'copy',
          dry_run: true,
          randomization_seed: 'wire-test',
        },
      }),
    );
    assert.equal(res['ok'], true);
    const prompt = String(res['judge_prompt']);
    assert.ok(!/claude/i.test(prompt), prompt.slice(0, 300));
    assert.ok(!/\bgpt\b/i.test(prompt));
    assert.ok(prompt.includes('train where they know your name'), 'substance survives');
    assert.ok(prompt.includes('the gym that remembers you'));
  });
});

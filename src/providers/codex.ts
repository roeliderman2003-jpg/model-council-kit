import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CouncilConfig } from '../config';
import { CouncilError, type BlindEvaluatorReport, type Usage } from '../types';
import { scrubForLog } from '../context/redact';
import { GENERATE_SCHEMA } from './output-schemas';
import type {
  EvaluateArgs,
  EvaluateResult,
  GenerateArgs,
  GenerateResult,
  GeneratedCandidate,
  ModelProvider,
} from './types';

/**
 * Codex CLI provider — GPT through the ChatGPT subscription, not the API.
 *
 * `codex exec` is OpenAI's documented non-interactive mode. When ~/.codex/auth.json
 * carries `auth_mode: "chatgpt"`, calls draw on the ChatGPT plan's included usage
 * and are NOT billed per token against an API account. That is the whole reason
 * this provider exists: it needs no OPENAI_API_KEY and adds no charge.
 *
 * What that costs instead is rate limit. The plan's usage window is shared with
 * interactive Codex, so a heavy Model Council session eats into it. Usage is
 * therefore reported with cost_usd: 0 and real token counts, and the call
 * ceiling — not the dollar ceiling — is what protects you here.
 *
 * Three isolation flags matter for correctness, not just tidiness:
 *   --ignore-user-config  keeps ~/.codex/config.toml out of the call
 *   --ignore-rules        keeps .rules files out
 *   -C <empty temp dir>   keeps any AGENTS.md in a real project out
 * Without them the user's own standing instructions would ride along into every
 * generation and, worse, into the blind evaluation — which would quietly break
 * the neutrality the whole system is built on.
 */

const AUTH_FILE = 'auth.json';

/** Where the Windows installer puts the binary, under a content-hash directory. */
function windowsCandidates(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (!local) return [];
  const binRoot = path.join(local, 'OpenAI', 'Codex', 'bin');
  if (!fs.existsSync(binRoot)) return [];
  const out: string[] = [];
  for (const dir of fs.readdirSync(binRoot)) {
    const exe = path.join(binRoot, dir, 'codex.exe');
    if (fs.existsSync(exe)) out.push(exe);
  }
  // Newest first: an update leaves the old hash directory in place.
  return out.sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  );
}

/**
 * Locates the codex executable.
 *
 * The install path contains a content hash that changes on every update, so it
 * is discovered rather than hard-coded — a pinned path would break silently on
 * the next upgrade.
 */
export function findCodexBinary(explicit?: string): string | null {
  if (explicit && fs.existsSync(explicit)) return explicit;

  const fromEnv = process.env.CODEX_BINARY;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  for (const c of windowsCandidates()) return c;

  // POSIX installs and npm globals.
  const names = process.platform === 'win32' ? ['codex.cmd', 'codex.exe'] : ['codex'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export interface CodexAuth {
  mode: string | null;
  /** True when the plan's included usage is what gets charged. */
  isSubscription: boolean;
  lastRefresh: string | null;
}

/** Reads the auth MODE only. Never touches the tokens themselves. */
export function readCodexAuth(codexHome?: string): CodexAuth {
  const home =
    codexHome ??
    process.env.CODEX_HOME ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex');
  const file = path.join(home, AUTH_FILE);
  if (!fs.existsSync(file)) return { mode: null, isSubscription: false, lastRefresh: null };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      auth_mode?: string;
      last_refresh?: string;
    };
    const mode = j.auth_mode ?? null;
    return {
      mode,
      isSubscription: mode === 'chatgpt',
      lastRefresh: j.last_refresh ?? null,
    };
  } catch {
    return { mode: null, isSubscription: false, lastRefresh: null };
  }
}

/**
 * Builds the argv for one `codex exec` call.
 *
 * Extracted so a test can assert on the flags without spawning anything. Three
 * of them are correctness requirements, not preferences:
 *
 *   --ignore-user-config  ~/.codex/config.toml must not reach the call
 *   --ignore-rules        .rules files must not reach the call
 *   -C <fresh temp dir>   no AGENTS.md from a real project may be read
 *
 * Any of those leaking would put the user's standing instructions into the
 * generation and, far worse, into the blind evaluation — silently breaking the
 * neutrality the system exists to guarantee. There is a test for each.
 */
export function buildCodexArgs(args: {
  schemaPath: string;
  outPath: string;
  work: string;
  model?: string;
  reasoningEffort?: string;
}): string[] {
  const argv = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--color',
    'never',
    '--output-schema',
    args.schemaPath,
    '-o',
    args.outPath,
    '-C',
    args.work,
  ];
  if (args.model) argv.push('-m', args.model);
  // Reasoning effort is a separate knob from the instruction set. We discard
  // the user's config.toml so their standing instructions cannot reach the
  // judge, but their MODEL and EFFORT choices are legitimate preferences we
  // do want — so they come back in explicitly, on the command line.
  if (args.reasoningEffort) argv.push('-c', `model_reasoning_effort="${args.reasoningEffort}"`);
  // The prompt goes over stdin rather than argv: a context pack can exceed the
  // Windows command-line length limit, and a truncated prompt would fail in a
  // way that looks like a bad answer rather than a bad call.
  argv.push('-');
  return argv;
}

interface RunResult {
  json: unknown;
  usage: { input_tokens: number; output_tokens: number };
  threadId: string | null;
  latencyMs: number;
}

export class CodexProvider implements ModelProvider {
  readonly id = 'codex';
  private binary: string | null;

  constructor(
    private cfg: CouncilConfig,
    binaryOverride?: string,
  ) {
    this.binary = findCodexBinary(binaryOverride);
  }

  isAvailable(): boolean {
    return this.binary !== null && readCodexAuth().mode !== null;
  }

  unavailableReason(): string | null {
    if (!this.binary) {
      return 'The Codex CLI was not found. Install it from https://developers.openai.com/codex, or set CODEX_BINARY to its path.';
    }
    const auth = readCodexAuth();
    if (!auth.mode) {
      return 'Codex is installed but not signed in. Run `codex` once and choose "Sign in with ChatGPT".';
    }
    return null;
  }

  /** The model and effort this provider will actually ask for. */
  settingsNote(): string {
    const m = this.cfg.models.codex_model || '(Codex default)';
    const e = this.cfg.models.codex_reasoning_effort || '(Codex default)';
    return `model=${m} effort=${e}`;
  }

  /** Describes what a call will be charged against, for the user-facing line. */
  billingNote(): string {
    const auth = readCodexAuth();
    if (auth.isSubscription) {
      return 'Charged against your ChatGPT plan\'s included usage, not the API. No per-token billing; it consumes plan rate limit, which is shared with interactive Codex.';
    }
    if (auth.mode) {
      return `Codex is signed in with auth_mode "${auth.mode}", which is NOT the ChatGPT subscription. Calls may be billed per token.`;
    }
    return 'Codex is not signed in.';
  }

  private run(args: {
    prompt: string;
    schema: Record<string, unknown>;
    timeoutMs: number;
    model?: string;
  }): Promise<RunResult> {
    const bin = this.binary;
    if (!bin) {
      throw new CouncilError(
        'provider_unavailable',
        this.unavailableReason() ?? 'Codex CLI unavailable.',
        'Install the Codex CLI, or switch models.provider to "openai" and set OPENAI_API_KEY.',
      );
    }

    // A fresh empty directory per call. Codex reads AGENTS.md from its working
    // root, and an inherited one would inject standing instructions into the
    // generation and the blind evaluation alike.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'council-codex-'));
    const schemaPath = path.join(work, 'schema.json');
    const outPath = path.join(work, 'out.json');
    fs.writeFileSync(schemaPath, JSON.stringify(args.schema), 'utf8');

    const argv = buildCodexArgs({
      schemaPath,
      outPath,
      work,
      model: args.model || this.cfg.models.codex_model || undefined,
      reasoningEffort: this.cfg.models.codex_reasoning_effort || undefined,
    });

    const started = Date.now();

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(bin, argv, {
        cwd: work,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, args.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        try {
          fs.rmSync(work, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        finish(() =>
          reject(
            new CouncilError(
              'provider_unavailable',
              `Could not start the Codex CLI: ${scrubForLog(err.message)}`,
              'Check that the binary at CODEX_BINARY is executable, or reinstall the Codex CLI.',
            ),
          ),
        );
      });

      child.on('close', (code) => {
        if (timedOut) {
          finish(() =>
            reject(
              new CouncilError(
                'timeout',
                `Codex exceeded the ${args.timeoutMs}ms timeout.`,
                'Codex runs an agent loop, so it is slower than a direct API call. Raise budget.timeout_ms, or shorten the input. Claude keeps its own work.',
              ),
            ),
          );
          return;
        }

        // Usage comes from the turn.completed event in the JSONL stream.
        let usage = { input_tokens: 0, output_tokens: 0 };
        let threadId: string | null = null;
        for (const line of stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const ev = JSON.parse(t) as {
              type?: string;
              thread_id?: string;
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
            if (ev.type === 'turn.completed' && ev.usage) {
              usage = {
                input_tokens: ev.usage.input_tokens ?? 0,
                output_tokens: ev.usage.output_tokens ?? 0,
              };
            }
          } catch {
            /* not an event line */
          }
        }

        let raw: string | null = null;
        try {
          if (fs.existsSync(outPath)) raw = fs.readFileSync(outPath, 'utf8');
        } catch {
          raw = null;
        }

        if (!raw || !raw.trim()) {
          finish(() =>
            reject(
              new CouncilError(
                'invalid_output',
                `Codex produced no final message (exit ${code}).`,
                'Retry once. If it repeats, run the same prompt with `codex exec` by hand to see what it did.',
                { stderr: scrubForLog(stderr.slice(0, 400)) },
              ),
            ),
          );
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          finish(() =>
            reject(
              new CouncilError(
                'invalid_output',
                'Codex returned a final message that is not valid JSON.',
                'The output schema should prevent this. Retry once; if it persists, the schema may be too complex for the model.',
                { preview: scrubForLog(raw.slice(0, 200)) },
              ),
            ),
          );
          return;
        }

        if (code !== 0) {
          finish(() =>
            reject(
              new CouncilError(
                'provider_unavailable',
                `Codex exited with code ${code}.`,
                'Check `codex` runs interactively and is still signed in. Claude continues on its own.',
                { stderr: scrubForLog(stderr.slice(0, 400)) },
              ),
            ),
          );
          return;
        }

        finish(() => resolve({ json: parsed, usage, threadId, latencyMs: Date.now() - started }));
      });

      // Write the prompt and close stdin. Leaving it open makes codex wait
      // forever for more input — the failure mode looks exactly like a hang.
      child.stdin.write(args.prompt, 'utf8');
      child.stdin.end();
    });
  }

  /** Subscription usage is not billed per token, so the dollar figure is a true zero. */
  private usageOf(model: string, r: RunResult): Usage {
    return {
      model,
      input_tokens: r.usage.input_tokens,
      output_tokens: r.usage.output_tokens,
      // Subscription usage is not billed per token. This zero is the truth for
      // auth_mode "chatgpt", and the billingNote() warns when it is not.
      cost_usd: 0,
      latency_ms: r.latencyMs,
    };
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    const r = await this.run({
      prompt: args.prompt,
      schema: GENERATE_SCHEMA as unknown as Record<string, unknown>,
      timeoutMs: args.timeoutMs,
      model: args.model,
    });

    const o = r.json as Partial<GeneratedCandidate>;
    if (typeof o.candidate !== 'string' || !o.candidate.trim()) {
      throw new CouncilError(
        'invalid_output',
        'Codex returned a response with no candidate text.',
        'Retry once; if it repeats, the brief is probably contradictory.',
      );
    }
    return {
      output: {
        candidate: o.candidate,
        assumptions: o.assumptions ?? [],
        facts_requiring_verification: o.facts_requiring_verification ?? [],
        alternatives: o.alternatives ?? [],
        concise_rationale: o.concise_rationale ?? '',
        confidence: typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0.5,
      },
      usage: this.usageOf(args.model, r),
      request_id: r.threadId,
    };
  }

  async evaluate(args: EvaluateArgs): Promise<EvaluateResult> {
    const r = await this.run({
      prompt: args.prompt,
      schema: args.schema,
      timeoutMs: args.timeoutMs,
      model: args.model,
    });

    const rep = r.json as Partial<BlindEvaluatorReport>;
    if (!rep.response_1 || !rep.response_2) {
      throw new CouncilError(
        'invalid_output',
        'Codex returned an evaluation missing one of the two responses.',
        'Retry once. If it repeats, the candidates are probably too long.',
      );
    }
    return {
      report: {
        response_1: {
          scores: rep.response_1.scores ?? [],
          hard_failures: rep.response_1.hard_failures ?? [],
          key_strength: rep.response_1.key_strength ?? '',
          key_risk: rep.response_1.key_risk ?? '',
        },
        response_2: {
          scores: rep.response_2.scores ?? [],
          hard_failures: rep.response_2.hard_failures ?? [],
          key_strength: rep.response_2.key_strength ?? '',
          key_risk: rep.response_2.key_risk ?? '',
        },
        confidence: typeof rep.confidence === 'number' ? Math.max(0, Math.min(1, rep.confidence)) : 0.5,
        concise_rationale: rep.concise_rationale ?? '',
        missing_facts: rep.missing_facts ?? [],
        facts_requiring_verification: rep.facts_requiring_verification ?? [],
      },
      usage: this.usageOf(args.model, r),
      request_id: r.threadId,
    };
  }
}

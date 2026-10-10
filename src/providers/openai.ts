import type OpenAI from 'openai';
import type { CouncilConfig } from '../config';
import { getApiKey } from '../config';
import { usageFrom } from '../budget';
import { CouncilError, type BlindEvaluatorReport } from '../types';
import { scrubForLog } from '../context/redact';
import type {
  EvaluateArgs,
  EvaluateResult,
  GenerateArgs,
  GenerateResult,
  GeneratedCandidate,
  ModelProvider,
} from './types';

/**
 * OpenAI provider, on the Responses API with structured output.
 *
 * Structured output is not decoration here: it is what lets the evaluator
 * return scores without a field in which it could name a winner. The schema is
 * the enforcement mechanism for the blind-comparison rule.
 *
 * The SDK itself is imported dynamically, on first use. Loading it costs about
 * 1.1 seconds, and the Codex route never calls it — paying that at every server
 * start is what pushes a cold boot towards the host's connect timeout.
 */

// Re-exported so existing importers keep working; the definitions live apart
// from this file precisely so that using them does not load the SDK.
export { GENERATE_SCHEMA, evaluateSchema } from './output-schemas';
import { GENERATE_SCHEMA } from './output-schemas';

function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: string; name?: string };
  if (e?.name === 'AbortError') return true;
  if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' || e?.code === 'ENOTFOUND') return true;
  const status = e?.status;
  // 429 and 5xx are infrastructure. 4xx other than 429 is our bug and retrying
  // it only pays twice for the same mistake.
  return status === 429 || (typeof status === 'number' && status >= 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpenAIProvider implements ModelProvider {
  readonly id = 'openai';
  private client: OpenAI | null = null;

  /**
   * `fetchImpl` exists so the integration tests can drive the real SDK against
   * a scripted HTTP layer — timeouts, 429s, truncated JSON — rather than
   * mocking our own code and proving nothing about it.
   */
  constructor(
    private cfg: CouncilConfig,
    private fetchImpl?: typeof fetch,
  ) {}

  isAvailable(): boolean {
    return getApiKey() !== null;
  }

  unavailableReason(): string | null {
    if (getApiKey() === null) {
      return 'OPENAI_API_KEY is not set in this environment, so GPT was not called. See docs/WINDOWS-API-KEY.md.';
    }
    return null;
  }

  private async getClient(): Promise<OpenAI> {
    if (this.client) return this.client;
    const key = getApiKey();
    if (!key) {
      throw new CouncilError(
        'no_api_key',
        'OPENAI_API_KEY is not set.',
        'Set it once with setx, then restart Claude Code. See docs/WINDOWS-API-KEY.md. Claude continues on its own in the meantime.',
      );
    }
    // Dynamic: the SDK is only paid for when a call is actually made.
    const mod = await import('openai');
    const Ctor = (mod.default ?? mod) as unknown as new (o: Record<string, unknown>) => OpenAI;
    this.client = new Ctor({
      apiKey: key,
      maxRetries: 0,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    return this.client;
  }

  /** One Responses API call with a timeout, retried only on infrastructure faults. */
  private async call(args: {
    model: string;
    prompt: string;
    schemaName: string;
    schema: Record<string, unknown>;
    maxOutputTokens: number;
    timeoutMs: number;
    retries: number;
  }): Promise<{ parsed: unknown; usage: ReturnType<typeof usageFrom>; requestId: string | null }> {
    const client = await this.getClient();
    let lastErr: unknown = null;
    // The SDK wraps an AbortError into its own APIConnectionError ("Connection
    // error."), so the error SHAPE cannot tell us a timeout happened. Our own
    // timer is the only reliable witness.
    let timedOut = false;

    for (let attempt = 0; attempt <= args.retries; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      // A client-side abort still pays for the whole generation, so the timeout
      // is generous by default rather than aggressive.
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, args.timeoutMs);
      try {
        const res = await client.responses.create(
          {
            model: args.model,
            input: args.prompt,
            max_output_tokens: args.maxOutputTokens,
            text: {
              format: {
                type: 'json_schema',
                name: args.schemaName,
                strict: true,
                schema: args.schema,
              },
            },
          },
          { signal: controller.signal },
        );
        clearTimeout(timer);

        const latency = Date.now() - started;
        const text = (res as { output_text?: string }).output_text ?? '';
        if (!text.trim()) {
          throw new CouncilError(
            'invalid_output',
            'The model returned an empty response.',
            'Retry, or reduce max_output_length if the response was truncated.',
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new CouncilError(
            'invalid_output',
            'The model returned text that is not valid JSON.',
            'This is usually a truncated response. Raise max_output_length, or retry.',
            { preview: scrubForLog(text.slice(0, 200)) },
          );
        }

        const u = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        return {
          parsed,
          usage: usageFrom(this.cfg, args.model, u?.input_tokens ?? 0, u?.output_tokens ?? 0, latency),
          requestId: (res as { id?: string }).id ?? null,
        };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        // A timeout is not retried inside this loop: an aborted request is
        // still billed for the whole generation, so retrying multiplies the
        // charge for a call that was already too slow.
        if (timedOut) break;
        // An invalid-output error is our schema's problem, not the network's;
        // one retry of the same prompt is allowed, no more.
        const retryable = isRetryable(err) || (err instanceof CouncilError && err.reason === 'invalid_output');
        if (!retryable || attempt === args.retries) break;
        await sleep(Math.min(4000, 400 * 2 ** attempt));
      }
    }

    if (timedOut) {
      throw new CouncilError(
        'timeout',
        `The request exceeded the ${args.timeoutMs}ms timeout.`,
        'Claude keeps its own work. Retry, shorten the input, or raise budget.timeout_ms. Note that an aborted request is still billed for the generation it had already done.',
      );
    }
    if (lastErr instanceof CouncilError) throw lastErr;
    const e = lastErr as { status?: number; message?: string; name?: string };
    if (e?.status === 401 || e?.status === 403) {
      throw new CouncilError(
        'no_api_key',
        `OpenAI rejected the credential (HTTP ${e.status}).`,
        'Check OPENAI_API_KEY is a current key with access to this model. Claude continues on its own.',
      );
    }
    throw new CouncilError(
      'provider_unavailable',
      `OpenAI call failed: ${scrubForLog(e?.message ?? String(lastErr))}`,
      'Claude keeps its own work and continues alone. Retry when the provider recovers.',
      { status: e?.status ?? null },
    );
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    const { parsed, usage, requestId } = await this.call({
      model: args.model,
      prompt: args.prompt,
      schemaName: 'council_candidate',
      schema: GENERATE_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: args.maxOutputTokens,
      timeoutMs: args.timeoutMs,
      retries: args.retries,
    });

    const o = parsed as Partial<GeneratedCandidate>;
    if (typeof o.candidate !== 'string' || !o.candidate.trim()) {
      throw new CouncilError(
        'invalid_output',
        'The model returned a response with no candidate text.',
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
      usage,
      request_id: requestId,
    };
  }

  async evaluate(args: EvaluateArgs): Promise<EvaluateResult> {
    const { parsed, usage, requestId } = await this.call({
      model: args.model,
      prompt: args.prompt,
      schemaName: 'council_blind_evaluation',
      schema: args.schema,
      maxOutputTokens: args.maxOutputTokens,
      timeoutMs: args.timeoutMs,
      retries: args.retries,
    });

    const r = parsed as Partial<BlindEvaluatorReport>;
    if (!r.response_1 || !r.response_2) {
      throw new CouncilError(
        'invalid_output',
        'The evaluator returned a report missing one of the two responses.',
        'Retry once. If it repeats, the candidates are probably too long for the evaluator model.',
      );
    }
    return {
      report: {
        response_1: {
          scores: r.response_1.scores ?? [],
          hard_failures: r.response_1.hard_failures ?? [],
          key_strength: r.response_1.key_strength ?? '',
          key_risk: r.response_1.key_risk ?? '',
        },
        response_2: {
          scores: r.response_2.scores ?? [],
          hard_failures: r.response_2.hard_failures ?? [],
          key_strength: r.response_2.key_strength ?? '',
          key_risk: r.response_2.key_risk ?? '',
        },
        confidence: typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5,
        concise_rationale: r.concise_rationale ?? '',
        missing_facts: r.missing_facts ?? [],
        facts_requiring_verification: r.facts_requiring_verification ?? [],
      },
      usage,
      request_id: requestId,
    };
  }
}

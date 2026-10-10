import { loadConfig, resetConfigCache, type CouncilConfig } from '../src/config';
import { Store } from '../src/store/db';
import { CouncilError, type BlindEvaluatorReport } from '../src/types';
import type {
  EvaluateArgs,
  EvaluateResult,
  GenerateArgs,
  GenerateResult,
  ModelProvider,
} from '../src/providers/types';
import type { Deps } from '../src/tools';

/**
 * A provider that records what it was asked and returns what the test dictates.
 *
 * The prompts it captures are the evidence for the neutrality and security
 * tests: they assert on the exact bytes that would have crossed the wire.
 */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';
  available = true;
  /** Every prompt this provider was handed, in order. */
  readonly generatePrompts: string[] = [];
  readonly evaluatePrompts: string[] = [];
  generateCalls = 0;
  evaluateCalls = 0;

  /** Set to throw instead of answering, to exercise a failure path. */
  throwOnGenerate: Error | null = null;
  throwOnEvaluate: Error | null = null;
  /** Number of times to throw before succeeding, for retry tests. */
  failuresBeforeSuccess = 0;

  /**
   * Content-aware scoring, the way a real judge behaves.
   *
   * A fake that returns fixed scores for response_1 / response_2 regardless of
   * what it was shown cannot test a system whose whole point is randomising the
   * order — it flips its own verdict with the position draw. This mode reads
   * the prompt, finds which response contains `marker`, and scores THAT one
   * high, so the verdict follows the content rather than the slot.
   */
  private contentRule: { marker: string; high: number; low: number; criteria: string[] } | null = null;

  scoreByContent(marker: string, criteria: string[], high = 9, low = 3): void {
    this.contentRule = { marker, criteria, high, low };
  }

  constructor(
    private candidateText = 'a candidate',
    private report: BlindEvaluatorReport | null = null,
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  unavailableReason(): string | null {
    return this.available ? null : 'OPENAI_API_KEY is not set in this environment, so GPT was not called.';
  }

  setReport(r: BlindEvaluatorReport): void {
    this.report = r;
  }

  setCandidate(text: string): void {
    this.candidateText = text;
  }

  async generate(args: GenerateArgs): Promise<GenerateResult> {
    this.generateCalls++;
    this.generatePrompts.push(args.prompt);
    if (this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess--;
      throw this.throwOnGenerate ?? new CouncilError('provider_unavailable', 'transient', 'retry');
    }
    if (this.throwOnGenerate) throw this.throwOnGenerate;
    return {
      output: {
        candidate: this.candidateText,
        assumptions: [],
        facts_requiring_verification: [],
        alternatives: [],
        concise_rationale: 'because',
        confidence: 0.8,
      },
      usage: { model: args.model, input_tokens: 100, output_tokens: 50, cost_usd: 0.001, latency_ms: 10 },
      request_id: 'resp_fake',
    };
  }

  async evaluate(args: EvaluateArgs): Promise<EvaluateResult> {
    this.evaluateCalls++;
    this.evaluatePrompts.push(args.prompt);
    if (this.throwOnEvaluate) throw this.throwOnEvaluate;

    let report = this.report;
    if (this.contentRule) {
      const { marker, criteria, high, low } = this.contentRule;
      // Which slot actually holds the marked text?
      const block1 = args.prompt.slice(
        args.prompt.indexOf('<response_1>'),
        args.prompt.indexOf('</response_1>'),
      );
      const markerInFirst = block1.includes(marker);
      report = reportWithScores({
        criteria,
        scores1: criteria.map(() => (markerInFirst ? high : low)),
        scores2: criteria.map(() => (markerInFirst ? low : high)),
      });
    }

    if (!report) throw new Error('FakeProvider: no report configured');
    return {
      report,
      usage: { model: args.model, input_tokens: 200, output_tokens: 80, cost_usd: 0.002, latency_ms: 20 },
      request_id: 'resp_fake_eval',
    };
  }
}

/** Builds a blind report where response_1 and response_2 get the given totals. */
export function reportWithScores(opts: {
  criteria: string[];
  scores1: number[];
  scores2: number[];
  confidence?: number;
  failures1?: Array<{ rule_id: string; evidence: string }>;
  failures2?: Array<{ rule_id: string; evidence: string }>;
  missingFacts?: string[];
}): BlindEvaluatorReport {
  const mk = (scores: number[], failures: Array<{ rule_id: string; evidence: string }> = []) => ({
    scores: opts.criteria.map((id, i) => ({ criterion_id: id, score: scores[i] ?? 5, note: `note for ${id}` })),
    hard_failures: failures,
    key_strength: 'strength',
    key_risk: 'risk',
  });
  return {
    response_1: mk(opts.scores1, opts.failures1),
    response_2: mk(opts.scores2, opts.failures2),
    confidence: opts.confidence ?? 0.9,
    concise_rationale: 'they differ on clarity',
    missing_facts: opts.missingFacts ?? [],
    facts_requiring_verification: [],
  };
}

export function memStore(): Store {
  return new Store(':memory:');
}

export function testConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  resetConfigCache();
  const cfg = JSON.parse(JSON.stringify(loadConfig({ reload: true }))) as CouncilConfig;
  return Object.assign(cfg, overrides);
}

export function testDeps(opts: { provider?: ModelProvider; store?: Store | null; cfg?: CouncilConfig } = {}): Deps {
  return {
    cfg: opts.cfg ?? testConfig(),
    provider: opts.provider ?? new FakeProvider(),
    store: opts.store === undefined ? memStore() : opts.store,
  };
}

/** Runs a function with a temporarily set env var, restoring it after. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

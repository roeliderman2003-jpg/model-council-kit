import type { BlindEvaluatorReport, Usage } from '../types';

/**
 * Provider-neutral interface.
 *
 * Small on purpose: two verbs, no streaming, no provider-specific options
 * leaking through. Adding Gemini or a local model later means implementing
 * these two methods, not rewriting the callers.
 */

export interface GenerateArgs {
  model: string;
  /** Fully rendered context pack. */
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  retries: number;
  /** Passed to the provider for correlation; never contains user content. */
  requestLabel: string;
}

export interface GeneratedCandidate {
  candidate: string;
  assumptions: string[];
  facts_requiring_verification: string[];
  alternatives: string[];
  concise_rationale: string;
  confidence: number;
}

export interface GenerateResult {
  output: GeneratedCandidate;
  usage: Usage;
  request_id: string | null;
}

export interface EvaluateArgs {
  model: string;
  /** Rendered blind-comparison prompt. Contains no author identities. */
  prompt: string;
  /** JSON schema the report must satisfy. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  retries: number;
  requestLabel: string;
}

export interface EvaluateResult {
  report: BlindEvaluatorReport;
  usage: Usage;
  request_id: string | null;
}

export interface ModelProvider {
  readonly id: string;
  /** True when the provider has what it needs to make a call. */
  isAvailable(): boolean;
  /** Why it is unavailable, for the user-facing message. */
  unavailableReason(): string | null;
  generate(args: GenerateArgs): Promise<GenerateResult>;
  evaluate(args: EvaluateArgs): Promise<EvaluateResult>;
}

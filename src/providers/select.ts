import type { CouncilConfig } from '../config';
import { CodexProvider } from './codex';
import { OpenAIProvider } from './openai';
import type { ModelProvider } from './types';

/**
 * Chooses which GPT route to use.
 *
 * `auto` prefers the Codex CLI, because when it is signed in with a ChatGPT
 * account the calls draw on the plan's included usage and cost nothing extra.
 * The API path is the fallback, and it is the one that bills per token — so the
 * cheaper route is the default and the billed route is the deliberate choice,
 * not the other way round.
 */
export interface ProviderChoice {
  provider: ModelProvider;
  /** One line for the user: which route, and what it is charged against. */
  billing: string;
  /** The route that was NOT taken, and why, when that is worth knowing. */
  note: string | null;
  /** True when this route bills per token. Surfaced on every call. */
  billed: boolean;
  /**
   * Set when `auto` wanted Codex, could not reach it, and is not allowed to
   * spend money instead. The caller must refuse rather than fall through.
   */
  refuse: { reason: string; suggestion: string } | null;
}

export function selectProvider(cfg: CouncilConfig): ProviderChoice {
  const codex = new CodexProvider(cfg);
  const openai = new OpenAIProvider(cfg);
  const want = cfg.models.provider ?? 'auto';

  if (want === 'codex') {
    return {
      provider: codex,
      billing: codex.billingNote(),
      note: codex.isAvailable() ? null : codex.unavailableReason(),
      billed: false,
      refuse: null,
    };
  }

  if (want === 'openai') {
    // Named explicitly, so billing is the deliberate choice and not a surprise.
    return {
      provider: openai,
      billing: 'Billed per token to your OpenAI API account, separately from any ChatGPT subscription.',
      note: openai.isAvailable() ? null : openai.unavailableReason(),
      billed: true,
      refuse: null,
    };
  }

  if (codex.isAvailable()) {
    return {
      provider: codex,
      billing: `${codex.billingNote()} Using ${codex.settingsNote()}.`,
      note: null,
      billed: false,
      refuse: null,
    };
  }

  // Codex is unreachable. Under `auto` that must NOT quietly become a charge:
  // the usual cause is environmental (the binary sits under %LOCALAPPDATA%
  // and is not on PATH), which is precisely the case where nothing looks
  // broken and the bill turns up later.
  const why = codex.unavailableReason() ?? 'Codex is unavailable.';
  if (!cfg.models.fallback_to_billed) {
    return {
      provider: openai,
      billing: 'No free route available, and falling back to the billed API is disabled.',
      note: `Codex was not used: ${why}`,
      billed: true,
      refuse: {
        reason: `The free Codex route is unavailable, and models.fallback_to_billed is false, so nothing was sent and nothing was charged. ${why}`,
        suggestion:
          'Claude continues on its own. To use the billed API for this, set models.provider to "openai" or models.fallback_to_billed to true. To restore the free route, check that the Codex CLI is installed and signed in — run scripts/doctor.mjs.',
      },
    };
  }

  return {
    provider: openai,
    billing:
      'BILLED per token to your OpenAI API account — the free Codex route was unavailable and fallback_to_billed is on.',
    note: `Codex was not used: ${why}`,
    billed: true,
    refuse: null,
  };
}

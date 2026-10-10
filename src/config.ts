import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Rubric, TaskType } from './types';
import { CouncilError } from './types';

export interface CouncilConfig {
  config_version: string;
  models: {
    /** 'auto' prefers Codex (ChatGPT subscription) when available, else the API. */
    provider: 'auto' | 'codex' | 'openai';
    generator: string;
    evaluator: string;
    fast: string;
    /** Passed to `codex exec -m`. Empty means Codex picks. */
    codex_model: string;
    /** Passed as `-c model_reasoning_effort`. Empty means Codex picks. */
    codex_reasoning_effort: string;
    /**
     * Judge model for the Codex route, deliberately different from codex_model.
     * A model scoring its own output has a measured self-preference bias, and
     * both live on the same subscription, so this costs nothing.
     */
    codex_evaluator_model: string;
    /** Under 'auto', may an unreachable Codex fall through to the billed API? */
    fallback_to_billed: boolean;
    env_overrides: Record<string, string>;
  };
  pricing_usd_per_1m_tokens: Record<string, { input: number; output: number }>;
  budget: {
    daily_usd: number;
    monthly_usd: number;
    per_task_usd: number;
    max_output_tokens: number;
    max_input_chars: number;
    timeout_ms: number;
    retries: number;
    max_calls_per_workflow: number;
    max_refinement_rounds: number;
    warn_estimate_usd: number;
    codex_timeout_ms: number;
  };
  routing: {
    default_mode_by_task_type: Record<string, string>;
    high_stakes_forces_competition: boolean;
    money_impact_threshold_ils: number;
    small_task_stays_single_model: boolean;
    small_task_max_chars: number;
    shadow_sample_rate: number;
    min_sample_size_for_routing_change: number;
    auto_routing_changes_enabled: boolean;
  };
  evaluation: {
    default_decision_threshold: number;
    default_min_confidence: number;
    default_subjective_escalation_ratio: number;
    escalate_when_objective_checks_disagree: boolean;
    escalate_when_missing_facts: boolean;
    escalate_when_irreversible: boolean;
  };
  privacy: {
    store_full_content: boolean;
    redact_by_default: boolean;
    redaction_kinds: string[];
    blocked_path_patterns: string[];
    restricted_requires_approval: boolean;
    max_source_material_chars: number;
  };
  logging: { content_logging_enabled: boolean; log_level: string };
  storage: { db_path: string };
}

/** Deep-merges plain objects; arrays and scalars from `over` replace `base`. */
function merge<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base;
  if (Array.isArray(over) || typeof over !== 'object') return over as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = merge((base as Record<string, unknown>)[k] as never, v);
  }
  return out as T;
}

/**
 * The install root — the directory holding config/ and package.json.
 *
 * Found by walking up rather than by assuming a depth. `__dirname/..` is right
 * when running from src/ under tsx, but becomes `dist/` once compiled, and the
 * config directory is not there. Walking up works from either.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'config', 'default.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing found: fall back to the old assumption so the error message that
  // follows names a real path rather than the filesystem root.
  return path.resolve(start, '..');
}

export const PROJECT_ROOT = findProjectRoot(__dirname);

function readJson(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CouncilError(
      'bad_input',
      `Config file ${file} is not valid JSON: ${(err as Error).message}`,
      'Fix the JSON syntax, or delete the file to fall back to the defaults.',
    );
  }
}

let cached: CouncilConfig | null = null;

/**
 * Loads config with this precedence, lowest first:
 *   config/default.json  <  config/local.json  <  <cwd>/.model-council.json  <  env vars
 *
 * The per-project override file lets one repository pin a different model or a
 * tighter budget without touching the user-level install.
 */
export function loadConfig(opts: { cwd?: string; reload?: boolean } = {}): CouncilConfig {
  if (cached && !opts.reload) return cached;

  const base = readJson(path.join(PROJECT_ROOT, 'config', 'default.json'));
  if (!base) {
    throw new CouncilError(
      'bad_input',
      'config/default.json is missing.',
      'Reinstall Model Council, or restore config/default.json from git.',
    );
  }
  let cfg = base as CouncilConfig;
  cfg = merge(cfg, readJson(path.join(PROJECT_ROOT, 'config', 'local.json')));

  const cwd = opts.cwd ?? process.cwd();
  cfg = merge(cfg, readJson(path.join(cwd, '.model-council.json')));

  // Env overrides for model names only. Secrets never come from config files.
  const envMap = cfg.models.env_overrides ?? {};
  for (const key of ['generator', 'evaluator', 'fast'] as const) {
    const envName = envMap[key];
    const value = envName ? process.env[envName] : undefined;
    if (value && value.trim()) cfg.models[key] = value.trim();
  }

  const numericEnv: Array<[string, (c: CouncilConfig, v: number) => void]> = [
    ['MODEL_COUNCIL_DAILY_USD', (c, v) => (c.budget.daily_usd = v)],
    ['MODEL_COUNCIL_MONTHLY_USD', (c, v) => (c.budget.monthly_usd = v)],
    ['MODEL_COUNCIL_PER_TASK_USD', (c, v) => (c.budget.per_task_usd = v)],
    ['MODEL_COUNCIL_TIMEOUT_MS', (c, v) => (c.budget.timeout_ms = v)],
  ];
  for (const [name, apply] of numericEnv) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) apply(cfg, n);
  }

  if (process.env.MODEL_COUNCIL_DB_PATH) cfg.storage.db_path = process.env.MODEL_COUNCIL_DB_PATH;

  const forced = process.env.MODEL_COUNCIL_PROVIDER?.trim().toLowerCase();
  if (forced === 'auto' || forced === 'codex' || forced === 'openai') cfg.models.provider = forced;
  if (process.env.CODEX_MODEL?.trim()) cfg.models.codex_model = process.env.CODEX_MODEL.trim();
  if (process.env.CODEX_EVALUATOR_MODEL?.trim())
    cfg.models.codex_evaluator_model = process.env.CODEX_EVALUATOR_MODEL.trim();
  if (process.env.CODEX_REASONING_EFFORT?.trim())
    cfg.models.codex_reasoning_effort = process.env.CODEX_REASONING_EFFORT.trim();
  if (process.env.MODEL_COUNCIL_ALLOW_BILLED?.trim())
    cfg.models.fallback_to_billed = /^(1|true|yes)$/i.test(process.env.MODEL_COUNCIL_ALLOW_BILLED.trim());

  cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = null;
  rubricCache = null;
}

/** Absolute path of the SQLite file, resolved against the install root. */
export function resolveDbPath(cfg: CouncilConfig): string {
  return path.isAbsolute(cfg.storage.db_path)
    ? cfg.storage.db_path
    : path.join(PROJECT_ROOT, cfg.storage.db_path);
}

let rubricCache: Map<string, Rubric> | null = null;

/** Loads every rubric in config/rubrics. New files need no code change. */
export function loadRubrics(reload = false): Map<string, Rubric> {
  if (rubricCache && !reload) return rubricCache;
  const dir = path.join(PROJECT_ROOT, 'config', 'rubrics');
  const map = new Map<string, Rubric>();
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const r = readJson(path.join(dir, file)) as Rubric | null;
      if (!r || !r.id) continue;
      const total = r.criteria.reduce((s, c) => s + c.weight, 0);
      if (total <= 0) {
        throw new CouncilError(
          'bad_input',
          `Rubric ${file} has non-positive total weight.`,
          'Give at least one criterion a positive weight.',
        );
      }
      map.set(r.id, r);
    }
  }
  rubricCache = map;
  return map;
}

/** Picks the rubric for a task type, falling back to an explicit id. */
export function rubricFor(taskType: TaskType, explicitId?: string): Rubric {
  const rubrics = loadRubrics();
  if (explicitId) {
    const r = rubrics.get(explicitId);
    if (!r) {
      throw new CouncilError(
        'bad_input',
        `Unknown rubric "${explicitId}".`,
        `Available rubrics: ${[...rubrics.keys()].join(', ')}.`,
      );
    }
    return r;
  }
  for (const r of rubrics.values()) {
    if (r.applies_to.includes(taskType)) return r;
  }
  const fallback = rubrics.get('copy') ?? [...rubrics.values()][0];
  if (!fallback) {
    throw new CouncilError(
      'bad_input',
      'No rubrics are installed.',
      'Restore config/rubrics/ from the repository.',
    );
  }
  return fallback;
}

/** Reads the API key from the environment. Never from a file, never from chat. */
export function getApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !key.trim()) return null;
  return key.trim();
}

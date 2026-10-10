import * as crypto from 'node:crypto';
import type { CouncilConfig } from '../config';
import type { RouteMode, TaskType } from '../types';

/**
 * Routing engine.
 *
 * Deliberately rule-based and readable. There is no learned policy here: the
 * statistics inform the human, and only a human flips a default. That keeps the
 * behaviour explainable at the moment it surprises you, which a trained router
 * would not be.
 */

export interface RouteInput {
  task_type: TaskType;
  /** Verbatim user request; length is one of the signals. */
  original_request: string;
  /** An explicit instruction from the user always wins. */
  explicit_mode?: RouteMode | null;
  /** True when the user named a model or asked for a comparison in words. */
  explicit_reason?: string;
  high_stakes?: boolean;
  irreversible?: boolean;
  money_impact_ils?: number;
  /** Deterministic seed for the shadow-sample draw; defaults to random. */
  shadow_seed?: string;
  /** Set false to suppress the shadow draw, e.g. inside tests or a dry run. */
  allow_shadow?: boolean;
}

export interface RouteDecision {
  mode: RouteMode;
  /** One sentence, shown to the user on every run. */
  reason: string;
  /** True when a second model also generates, but only for measurement. */
  shadow: boolean;
  /** Which rule fired, for the audit trail. */
  rule: string;
  /** Non-blocking notes, e.g. why the shadow draw happened. */
  notes: string[];
}

/** Deterministic 0-1 draw from a seed, so a shadow decision is reproducible. */
export function seededUnit(seed: string): number {
  const h = crypto.createHash('sha256').update(seed).digest();
  const n = h.readUInt32BE(0);
  return n / 0xffffffff;
}

const VALID_MODES: RouteMode[] = ['CLAUDE_ONLY', 'GPT_ONLY', 'COMPETITION', 'GPT_CRITIQUE', 'USER_DECIDES'];

export function isRouteMode(v: string): v is RouteMode {
  return (VALID_MODES as string[]).includes(v);
}

export function decideRoute(input: RouteInput, cfg: CouncilConfig): RouteDecision {
  const notes: string[] = [];

  // 1. An explicit instruction from the user is final. Nothing below overrides it.
  if (input.explicit_mode) {
    return {
      mode: input.explicit_mode,
      reason: input.explicit_reason
        ? `You asked for it: ${input.explicit_reason}.`
        : `You asked for ${input.explicit_mode.replace(/_/g, ' ').toLowerCase()}.`,
      shadow: false,
      rule: 'explicit_user_instruction',
      notes,
    };
  }

  // 2. High stakes, irreversible or large money impact -> competition.
  const money = input.money_impact_ils ?? 0;
  const bigMoney = money >= cfg.routing.money_impact_threshold_ils;
  if (cfg.routing.high_stakes_forces_competition && (input.high_stakes || input.irreversible || bigMoney)) {
    const why = input.irreversible
      ? 'the decision is hard to reverse'
      : bigMoney
        ? `it carries about ₪${money} of impact`
        : 'you marked it high stakes';
    return {
      mode: 'COMPETITION',
      reason: `Both models will answer independently because ${why}.`,
      shadow: false,
      rule: 'high_stakes',
      notes,
    };
  }

  // 3. A short, simple task stays on one model. Two answers to a one-line
  //    rewrite is spend without a decision attached.
  const short = input.original_request.trim().length <= cfg.routing.small_task_max_chars;
  const defaultMode = (cfg.routing.default_mode_by_task_type[input.task_type] ?? 'CLAUDE_ONLY') as RouteMode;

  if (cfg.routing.small_task_stays_single_model && short && input.task_type === 'small_rewrite') {
    return {
      mode: defaultMode,
      reason: 'Small rewrite, so one model handles it.',
      shadow: false,
      rule: 'small_task_single_model',
      notes,
    };
  }

  // 4. Type default, with an occasional shadow draw for measurement.
  let shadow = false;
  if (
    (input.allow_shadow ?? true) &&
    cfg.routing.shadow_sample_rate > 0 &&
    (defaultMode === 'CLAUDE_ONLY' || defaultMode === 'GPT_ONLY') &&
    !short
  ) {
    const seed = input.shadow_seed ?? crypto.randomBytes(8).toString('hex');
    if (seededUnit(seed) < cfg.routing.shadow_sample_rate) {
      shadow = true;
      notes.push(
        `Shadow sample drawn (${Math.round(cfg.routing.shadow_sample_rate * 100)}% of tasks). The second model also answers, for measurement only — its answer is not used unless you ask for it.`,
      );
    }
  }

  // The sentence has to match the mode. "Claude handles decision by default"
  // next to mode COMPETITION states two different things, which is the same
  // class of bug as the fallback reason that promised both models while
  // reporting CLAUDE_ONLY.
  const label = input.task_type.replace(/_/g, ' ');
  const reason =
    defaultMode === 'COMPETITION'
      ? `Both models answer independently: ${label} is cheap to compare and expensive to get wrong.`
      : defaultMode === 'GPT_ONLY'
        ? `GPT handles ${label} by default.`
        : defaultMode === 'CLAUDE_ONLY'
          ? `Claude handles ${label} by default.`
          : `${label} defaults to ${defaultMode}.`;
  return {
    mode: defaultMode,
    reason,
    shadow,
    rule: 'task_type_default',
    notes,
  };
}

/**
 * Natural-language signals that the user named a route.
 *
 * Returns null when nothing explicit was said — the caller then falls back to
 * the rules above. Matching is intentionally narrow: an ambiguous phrase should
 * fall through to the default rather than guess at an override.
 */
export function detectExplicitMode(text: string): { mode: RouteMode; reason: string } | null {
  const t = text.toLowerCase();

  const compare = [
    /\bcompare\b.*\bmodels?\b/, /\bboth of you\b/, /\bboth models?\b/,
    /תנו? לשניכם/, /שניכם/, /תשווה בינ/, /השווה בינ/, /תחרות/, /שתי גרסאות/,
  ];
  if (compare.some((re) => re.test(t))) {
    return { mode: 'COMPETITION', reason: 'you asked for both versions and a comparison' };
  }

  const gptOnly = [
    /\b(?:let|have|ask)\s+(?:gpt|chatgpt|openai)\b/, /\bgpt\s+(?:should|writes?|does|handles?)\b/,
    /תן ל-?gpt/, /תן לג'י פי טי/, /שgpt/, /תעביר ל-?gpt/, /תשאל את gpt/,
  ];
  if (gptOnly.some((re) => re.test(t))) {
    return { mode: 'GPT_ONLY', reason: 'you asked for GPT specifically' };
  }

  const claudeOnly = [
    /\b(?:do|write|handle)\s+(?:it|this)\s+yourself\b/, /\bwithout gpt\b/, /\bdon'?t (?:use|ask) gpt\b/,
    /תעשה לבד/, /בעצמך/, /בלי gpt/, /אל תשתמש ב-?gpt/, /לבד בלי/,
  ];
  if (claudeOnly.some((re) => re.test(t))) {
    return { mode: 'CLAUDE_ONLY', reason: 'you asked Claude to handle it alone' };
  }

  const critique = [
    /\bcritique\b/, /\breview my\b.*\bdraft\b/, /\bsecond opinion\b/,
    /תן ביקורת/, /שיבקר/, /חוות דעת שנייה/, /שיעבור על/,
  ];
  if (critique.some((re) => re.test(t))) {
    return { mode: 'GPT_CRITIQUE', reason: 'you asked for a critique rather than a rewrite' };
  }

  return null;
}

/**
 * Maps a free-text request to a task type. A miss returns 'other', which routes
 * to Claude — the conservative side, since it spends nothing.
 */
export function detectTaskType(text: string): TaskType {
  const t = text.toLowerCase();
  // Hebrew patterns allow an optional definite article inside a construct
  // ("שיחות המכירה" as well as "שיחות מכירה"). JavaScript's \b does not work
  // against Hebrew letters, so the Hebrew entries are plain substrings.
  const table: Array<[TaskType, RegExp[]]> = [
    ['copy', [/\bcopy\b/, /\bheadline\b/, /\blanding page\b/, /\bad text\b/, /\bemail (?:copy|subject)\b/, /קופי/, /דף ה?נחיתה/, /כותרת/, /מודעה/, /טקסט ה?שיווקי/, /פוסט/]],
    ['marketing_angle', [/\bangle\b/, /\bhook\b/, /\bpositioning\b/, /זווית/, /וו שיווקי/, /מסר/]],
    ['value_proposition', [/\bvalue prop/, /\boffer\b/, /הצעת ה?ערך/, /הצעה/]],
    ['sales_analysis', [/\bsales calls?\b/, /\bobjections?\b/, /\btranscripts?\b/, /שיחות ה?מכירה/, /שיחות ה?מכירות/, /התנגדויות/, /תמלול/]],
    ['qualitative_analysis', [/\bqualitative\b/, /\bthemes?\b/, /\binterviews?\b/, /ניתוח ה?איכותני/, /ראיונות/]],
    ['research_summary', [/\bsummar/, /\bresearch\b/, /סיכום ה?מחקר/, /מחקר ה?לקוחות/]],
    ['tests', [/\btests?\b/, /\bspec file\b/, /בדיקות/, /טסטים/]],
    ['architecture', [/\barchitecture\b/, /\bdesign the system\b/, /ארכיטקטורה/, /תכנון ה?מערכת/]],
    ['ops', [/\bdeploy\b/, /\bcron\b/, /\bci\b/, /פריסה/, /תפעול/]],
    ['feature_spec', [/\bspec\b/, /\brequirements\b/, /אפיון/, /דרישות/]],
    ['code', [/\bcode\b/, /\bfunction\b/, /\brefactor\b/, /\bbug\b/, /\bfix\b/, /קוד/, /פונקציה/, /באג/, /תקן/]],
    // General work. Listed last so a more specific domain wins, but present so
    // that an ordinary decision or piece of writing is not funnelled into
    // 'other' and quietly treated as unclassifiable.
    ['decision', [/\bshould (?:we|i)\b/, /\bwhich (?:approach|option|one)\b/, /\bdecide\b/, /\btrade-?offs?\b/, /\bworth it\b/, /האם כדאי/, /מה עדיף/, /איזו? (?:גישה|אפשרות)/, /להחליט/, /שווה ל/]],
    ['planning', [/\bplan\b/, /\broadmap\b/, /\bsequence\b/, /\bmigration\b/, /תוכנית/, /תכנון/, /סדר ה?עבודה/, /מיגרציה/]],
    ['explanation', [/\bexplain\b/, /\bwhy does\b/, /\bhow does\b/, /\bwhat is\b/, /תסביר/, /למה זה/, /איך זה עובד/, /מה זה/]],
    ['naming', [/\bname (?:it|this|for)\b/, /\bwhat to call\b/, /\bnaming\b/, /איך לקרוא ל/, /שם ל/, /מה השם/]],
    ['translation', [/\btranslate\b/, /\bin hebrew\b/, /\bin english\b/, /תרגם/, /לתרגם/, /באנגלית/, /בעברית/]],
    ['writing', [/\bwrite\b/, /\bdraft\b/, /\bword (?:it|this)\b/, /\bphrase\b/, /\bmessage\b/, /\bemail\b/, /תכתוב/, /לנסח/, /ניסוח/, /טיוטה/, /הודעה/, /מייל/]],
  ];
  for (const [type, patterns] of table) {
    if (patterns.some((re) => re.test(t))) return type;
  }
  return 'other';
}

# Model Council

> **התקנה מהירה עם Claude Code (בעברית): [INSTALL.md](INSTALL.md).** GPT דרך מנוי ChatGPT (Codex), בלי חיוב API.

A local MCP server that lets **Claude Code consult a GPT model as a second
expert on any task where the quality of the answer matters** — a decision
between two approaches, a piece of writing, a name, a plan, code, copy,
analysis — with blind comparison, transparent routing, and statistics driven by
what actually happened rather than by an AI's opinion.

Claude stays the interface and runs the process. GPT is a contributor.

**This is not a marketing tool.** Marketing is one of the domains it covers.
What it adds, in any domain:

1. A second expert opinion when the task is worth one
2. A blind comparison in which neither model grades its own work
3. Escalation to you when it is genuinely close, instead of pretending it is not
4. Learning from real outcomes, which outrank the judge

**When it should fire:** the output gets shipped, sent or acted on · there is a
real choice between options · a mistake would be expensive · you asked.
**When it should not:** a factual question with one answer · a typo · something
you are already sure of · you said "do it yourself".

**The rule the system enforces:** when Claude and GPT compete on the same task,
Claude may not decide that its own version won. That decision goes through a
blind comparison where the judge never learns who wrote what — and where the
winner is computed by code from the scores, not chosen by a model.

---

## Quick start

```bash
cd ~/model-council
npm install
npm run build
npm test
node scripts/install.mjs
```

`npm run build` is not optional. The MCP registration launches the **compiled**
server (`dist/src/server.js`). Running the TypeScript through `tsx` instead
recompiles the whole dependency tree on every boot — about 17 seconds warm, and
past the host's 30-second connect timeout on a cold disk after a reboot, at
which point the server simply never appears. `npm test` and `node
scripts/install.mjs` both build first, so this is only a manual step if you run
the server by hand.

Then verify:

```bash
node ~/model-council/scripts/doctor.mjs
```

Everything works with no credentials at all — Claude simply handles every task
alone and says so on each routing decision.

---

## Two ways to reach GPT

| Route | Credential | Cost |
|---|---|---|
| **Codex CLI** (preferred) | Sign in with your ChatGPT account | **No API charge.** Draws on the plan's included usage. |
| OpenAI API | `OPENAI_API_KEY` | Billed per token, separately from any subscription. |

A ChatGPT Plus/Pro/Team subscription does **not** include API credit — the two
are separate products with separate billing. The Codex route is how a
subscription reaches GPT programmatically, and it is why `models.provider`
defaults to `auto`: the free route is the default, and the billed one is a
deliberate choice.

### The Codex route (no extra cost)

Install the [Codex CLI](https://developers.openai.com/codex), then once:

```bash
codex
```

Choose **Sign in with ChatGPT**. That writes `~/.codex/auth.json` with
`auth_mode: "chatgpt"`, which is what Model Council looks for. Verify and try it:

```bash
node scripts/doctor.mjs
npm run smoke:codex -- --compare
```

Calls go through `codex exec` with `--output-schema`, so the structured output
the rest of the system depends on is enforced the same way it is on the API.
Three isolation flags matter for correctness rather than tidiness:
`--ignore-user-config` and `--ignore-rules` keep your own Codex settings out of
the call, and each call runs in a fresh empty directory so no `AGENTS.md` from a
real project can reach the generator — or, far worse, the blind judge.

What it costs instead is **plan rate limit**, shared with interactive Codex, and
**latency**: an agent loop takes roughly 9-15 seconds against about 2 for the
API. The timeout is therefore `budget.codex_timeout_ms` (5 minutes), separate
from the API timeout.

### The API route

```powershell
setx OPENAI_API_KEY "your-key-here"
```

Restart Claude Code afterwards — `setx` does not affect running processes. Full
guide: [docs/WINDOWS-API-KEY.md](docs/WINDOWS-API-KEY.md).

### Choosing explicitly

```jsonc
// config/local.json
{ "models": { "provider": "codex" } }   // or "openai", or "auto"
```

Or per shell: `MODEL_COUNCIL_PROVIDER=codex`.

---

## Using it

Write naturally. Claude picks the mode and tells you which one and why.

| You say | What happens |
|---|---|
| "האם כדאי לעבור מ-Supabase ל-Postgres מנוהל?" | Detected as `decision` → **COMPETITION**. Cheap to compare, expensive to get wrong |
| "איך לקרוא לפיצ'ר הזה?" | `naming` → **COMPETITION** |
| "תכנן לי את סדר העבודה למיגרציה" | `planning` → **Claude**, which already holds the project context |
| "תנסח לי את ההודעה הזאת" | `writing` → **GPT** |
| "תבנה לי דף נחיתה למוצר הזה" | `copy` → GPT; a launch page is high-stakes, so it becomes a competition |
| "נתח את שיחות המכירה" | `sales_analysis` with the analysis rubric; identifying details redacted first |
| "תן ל-GPT לכתוב את זה" | `GPT_ONLY` — an explicit instruction overrides every default |
| "תנו לשניכם ותשווה ביניהן" | Both generate independently, then a blind comparison |
| "מי מתאים יותר למשימה הזאת?" | `route_task` — the mode and the reason. No API call, no cost |
| "השתמשתי בגרסה של GPT" | `/record-outcome` with `was_used` — outranks any AI judgement |
| "תעשה לבד, בלי GPT" | `CLAUDE_ONLY`, whatever the task type |

### Slash commands

| Command | Does |
|---|---|
| `/gpt <task>` | Send one task to GPT |
| `/compare-models <task>` | Both generate, then blind comparison |
| `/router-stats` | Performance by task type and model |
| `/record-outcome` | Record a real result |
| `/router-config` | Show the active configuration |

---

## What you see on every run

Five lines, not a log dump:

```
מצב: COMPETITION · שני המודלים ענו כי ההחלטה קשה להיפוך
נשלח ל-GPT: כן · רגישות: internal · הוסתרו: 2 טלפונים
הכרעה: NEEDS_USER_DECISION — הפער 0.4 מתוך 10, מתחת לסף
עלות: $0.031 · task_id: task_a1b2c3d4
עובדות לאימות: המחיר החודשי · אורך האימון
```

When there is no clear winner you get both versions in full, each with its key
strength and its main risk, a non-binding recommendation, and the exact question
you need to answer. Claude does not choose for you.

---

## How a decision is made

Highest authority first. A lower level is consulted only when the ones above it
are silent:

1. **Hard constraints** — an unapproved fact, a forbidden promise, a wrong
   price. Disqualifies a candidate no matter how well it reads.
2. **Objective checks** — tests, measurements. Outrank any model score.
3. **Real outcomes** — CPL, conversion, close rate. Recorded later; supersede
   the stored verdict, and the disagreement is reported.
4. **Blind rubric scoring** — per-criterion, identity-hidden, order randomised.
5. **You** — whenever 1-4 do not settle it decisively.

`NEEDS_USER_DECISION` is returned when the gap is under the threshold, the
judge's confidence is low, objective checks disagree, the rubric is
taste-dominated, critical facts are missing, or the decision is irreversible.

---

## Working modes

| Mode | Default for |
|---|---|
| `CLAUDE_ONLY` | code, architecture, tests, ops, specs, **planning, explanation** — work that leans on project context Claude already has |
| `GPT_ONLY` | copy, marketing angles, value propositions, sales and qualitative analysis, **writing, translation** |
| `COMPETITION` | **decisions, naming**, and anything high-stakes, irreversible, or over ₪1,000 of impact |
| `GPT_CRITIQUE` | a second opinion on an existing draft |
| `USER_DECIDES` | you decide |

An explicit instruction always wins. Around 10% of eligible tasks draw a
**shadow sample**: both models answer, the second answer is used only for
measurement, and you are told it happened.

---

## The MCP tools

| Tool | Purpose |
|---|---|
| `route_task` | Mode + one-sentence reason. No API call, no cost. |
| `gpt_generate` | One GPT candidate, with assumptions, facts to verify, alternatives, confidence. |
| `blind_compare` | Identity-hidden scoring; verdict computed by code. |
| `record_outcome` | A real result. Outranks the judge. `was_used` (did you ship it, or rewrite it?) works for any task; the funnel metrics are there when they apply. |
| `routing_stats` | Performance by task type and model, with confidence intervals. |
| `council_config` | Active configuration and current spend. |
| `register_candidate` | Records Claude's own work so it enters the statistics. |

Every tool returns `{ok, data?, error?, notes[]}`. A missing key, a budget
refusal and a timeout all come back as readable answers, never as crashes.

---

## Configuration

Three layers, lowest first. **No layer ever holds a secret.**

```
config/default.json          committed defaults
config/local.json            your overrides, git-ignored
<project>/.model-council.json   per-project overrides
environment variables        model names and budget caps
```

```bash
MODEL_COUNCIL_PROVIDER       # auto | codex | openai
OPENAI_API_KEY               # the only place a key lives (API route only)
CODEX_BINARY                 # explicit path to the codex executable
CODEX_HOME                   # defaults to ~/.codex
CODEX_MODEL                  # model passed to `codex exec -m`
OPENAI_GENERATOR_MODEL       # overrides models.generator
OPENAI_EVALUATOR_MODEL       # overrides models.evaluator
OPENAI_FAST_MODEL            # overrides models.fast
MODEL_COUNCIL_DAILY_USD      # overrides budget.daily_usd
MODEL_COUNCIL_MONTHLY_USD
MODEL_COUNCIL_PER_TASK_USD
MODEL_COUNCIL_TIMEOUT_MS
MODEL_COUNCIL_DB_PATH
```

### Budget defaults

| Setting | Default |
|---|---|
| Daily / monthly | $3 / $40 |
| Per task | $0.50 |
| Max calls per workflow | 6 |
| Refinement rounds | 2 |
| Timeout | 90s |
| Retries | 2 (infrastructure faults only) |

Over budget → Claude continues alone and tells you GPT was not called.

### Rubrics

`config/rubrics/*.json` — `general`, `copy`, `code`, `analysis`. `general` is
the fallback for work with no objective test — a decision, a plan, an
explanation — and its hard failures are the ones that actually bite:
`answered_a_different_question`, `unsupported_certainty`, `ignored_constraint`.
Add a file and it loads;
no code change. Each defines weighted criteria, hard failures, and thresholds.
Bump `version` when you edit one, so old evaluations stay interpretable.

---

## Privacy

- Phones, emails, Israeli IDs, credit cards, IBANs and key-shaped strings are
  redacted before anything is sent, and you are told what was removed.
- `.env`, `*.key`, `credentials*.json`, `.git/**`, `node_modules/**` are never
  sent — pass a `path` on each source so the filter can see it.
- `sensitivity: restricted` refuses to send without explicit approval.
- Candidate text is **hashed, not stored** (`store_full_content: false`).
- The API key is masked by value in every log line and error message.
- No chain-of-thought is requested or stored.

External content is placed inside `<untrusted_source_material>`, after a system
frame stating it must never be obeyed. This server also has no dangerous tools:
a model that obeyed an injected instruction could produce bad text, but cannot
send, write or spend anything.

---

## Testing

```bash
npm test              # everything (216 tests; builds first)
npm run test:unit
npm run test:integration
npm run test:neutrality
npm run test:security
npm run test:dist     # boots the COMPILED server, the artefact that ships
npm run typecheck
```

The neutrality suite is the one that matters most. It asserts that swapping A
and B mirrors the verdict exactly, that no model name reaches the judge, that a
hard failure beats a perfect style score, that equal scores never resolve to A,
and that a real outcome overrides the judge.

Real calls, on purpose:

```bash
npm run smoke:codex             # free — runs on your ChatGPT plan
npm run smoke:codex -- --compare  # adds one blind comparison, still free
```

```bash
npm run smoke -- --dry          # API route: prints the payload, calls nothing
npm run smoke -- --confirm      # API route: one billed call, cheap model
```

The Codex smoke test needs no `--confirm` gate because it costs no money. The
API one keeps it.

---

## Evals

`evals/templates/` holds seven templates: landing-page copy, lead ad, WhatsApp
message, sales-objection analysis, feature spec, code review, customer-research
summary. Each is a skeleton with `<<placeholders>>` — no business data is
invented for you. See [the evals README](evals/templates/README.md).

---

## Layout

```
src/
  server.ts          MCP server (stdio)
  config.ts          layered config + rubric loading
  schemas.ts         zod schemas for every tool
  types.ts           domain types; Generator/Evaluator/Outcome kept apart
  budget.ts          cost estimation and limit enforcement
  providers/         ModelProvider interface + OpenAI implementation
  context/           context pack assembly, redaction, trust boundary
  routing/           mode selection, task-type and instruction detection
  judge/             blind prompt construction; verdict arithmetic
  store/             SQLite, migrations, repository, statistics
  tools/             the seven tool handlers
test/                unit · integration · neutrality · security
config/              default.json + rubrics/
evals/templates/     seven task templates
scripts/             install · doctor · smoke · boot-probe
docs/                this, the key guide, limits, decisions
```

---

## Updating and removing

**Update:**
```bash
cd ~/model-council && git pull && npm install && npm run build && npm test && node scripts/install.mjs
```

After any change to `src/`, rebuild — the running server is the compiled output,
not the source. `npm test` rebuilds automatically and fails if `dist` is stale.
Your `config/local.json` and `data/council.db` are untouched.

**Remove:**
```bash
node ~/model-council/scripts/register-mcp.mjs --remove
rm -rf ~/.claude/skills/model-council
rm ~/.claude/commands/{gpt,compare-models,router-stats,record-outcome,router-config}.md
```
Delete `data/council.db` to erase the history, and unset `OPENAI_API_KEY`.

---

## Adding another provider

`src/providers/types.ts` defines a two-method interface. Implement it, add a
price row, and point `models.generator` at the new name. Nothing above the
provider layer knows which vendor answered.

---

## Read next

- [Windows API key setup](docs/WINDOWS-API-KEY.md)
- [Limits and risks](docs/LIMITS-AND-RISKS.md) — where this can mislead you
- [Design decisions](docs/DECISIONS.md) — why it is shaped this way

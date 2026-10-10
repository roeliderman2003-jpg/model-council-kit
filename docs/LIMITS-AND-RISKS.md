# Limits and risks

What this system does not do, where it can mislead you, and what to watch.

---

## The evaluation is not truth

### An AI judge is the weakest evidence in the ladder

The blind comparison produces a number, and a number looks authoritative. It is
not. The precedence ladder exists because of this:

1. hard constraints — a false fact disqualifies, whatever the score
2. objective checks — a test result, a measurement
3. real outcomes — CPL, conversion, close rate
4. the blind rubric score
5. you

Only (4) comes from a model. If you never record outcomes, every number in
`/router-stats` is level 4, and the report says so in its warnings.

### The judge is a GPT model judging GPT's own output

`OPENAI_EVALUATOR_MODEL` defaults to the same family as the generator. A model
may plausibly prefer text that reads the way it writes. Blinding and position
randomisation remove the *identity* signal, not a *stylistic* affinity.

**What reduces it:** set `OPENAI_EVALUATOR_MODEL` to a different model from
`OPENAI_GENERATOR_MODEL`. **What eliminates it:** recording real outcomes, which
outrank the judge entirely.

### The rubric is an opinion, expressed as arithmetic

`audience_fit` is 25% because that seemed right, not because it was measured.
The weights are yours to change in `config/rubrics/*.json`. Changing them
changes verdicts. Bump the rubric `version` when you do, so old evaluations
remain interpretable.

### A hard failure depends on the judge noticing it

`unapproved_fact` disqualifies a candidate — but only if the evaluator spots
that a fact is unapproved and quotes it. A subtly invented number can pass. The
`facts_requiring_verification` list exists for exactly this: **read it**.

---

## The statistics can mislead you

### Small samples

Every rate carries a Wilson interval and an `insufficient_sample` flag. Five
wins out of five is a lower bound around 0.57 — not evidence. Rows below
`min_sample_size_for_routing_change` (12) must not drive a routing change.

### Win rates are not summed across evidence types

`evaluator.wins` and `outcome.wins` are separate on purpose. Merging them would
launder an AI opinion into the same column as a measured CPL.

### A one-sided outcome settles nothing

Recording that GPT's version got a CPL of 42 says the version was used, not that
it beat anything. A comparison needs **both** sides measured on the **same**
metric. The tool says so when only one side has a value.

### Cumulative rates hide a fixed problem

`/router-stats` also breaks history down by month. If a rate looks bad overall,
check whether it was bad *recently* — a problem fixed two months ago still drags
the cumulative number down.

---

## Cost

### The estimate under-counts Hebrew

Token estimation uses ~3.5 characters per token, an English ratio. Hebrew packs
more tokens per character, so a Hebrew prompt costs **more** than the estimate.
Treat the figure as a floor.

### An aborted request is still billed

A client-side timeout does not stop the generation on OpenAI's side, and you pay
for what was produced. That is why a timeout is **not retried** — retrying
multiplies the charge for a call that was already too slow.

### Prices go stale

`pricing_usd_per_1m_tokens` is a hand-maintained table. An unlisted model falls
back to `default` and the estimate is flagged `approximate`. Update the table
when prices change; nothing does it automatically.

### The budget guard degrades when the store is lost

Without the database the guard cannot know the running total, so it enforces
per-call limits only and marks the snapshot `degraded: true`. It never silently
permits unlimited spend, but it also cannot stop a slow drift across many calls.

---

## Privacy

### Redaction is pattern-based

Phones, emails, Israeli IDs (check-digit validated), Luhn-valid cards, IBANs and
key-shaped strings are caught. **A name is not.** "Yossi from Petah Tikva said
the price is too high" goes through intact. Redaction reduces exposure; it is
not anonymisation.

### An ambiguous nine-digit number gets one label

A bare `030000004` is both a valid Israeli ID and a valid landline. The ID rule
runs first because its check digit is the more specific signal. Either way the
value is replaced — only the label may be wrong.

### The blocked list is a path filter

`config/default.json` blocks `.env`, `*.key`, `credentials*.json`, `.git/**` and
`node_modules/**` — matched on the `path` field of a source. **A source passed
with no `path` is not path-checked.** Always pass `path` when the content came
from a file.

### Prompt injection is contained, not defeated

External content sits inside `<untrusted_source_material>`, after a system frame
that states it must never be obeyed. That is the standard mitigation and it is
strong, not absolute. The real protection is that this server has no dangerous
tools: a model that obeyed an injected instruction could produce bad text, but
it cannot send an email, write a file, or spend money.

### Content is not stored by default

`store_full_content: false` means candidates are kept as SHA-256 hashes plus
metadata. You get provenance and statistics without a database full of copy. Turn
it on for a debugging session, then turn it off.

---

## Operational

### Routing never changes itself

`auto_routing_changes_enabled: false`, deliberately. The statistics inform you;
you edit the defaults. A router that rewired itself on twelve samples would be
harder to debug than the problem it solved.

### Task type detection is keyword-based

`detectTaskType` matches substrings, in English and Hebrew (with optional
definite article). It will miss phrasings nobody anticipated and fall through to
`other`, which routes to Claude — the side that spends nothing. Aim the
unreadable case at the cheap default, and pass `task_type` explicitly when it
matters.

### Model names are not validated

`gpt-5.1` in the config is a default, not a promise. A model being listed is not
the same as your key being able to call it. `npm run smoke -- --confirm` is how
you find out, and it is cheap.

### The API does not behave like the ChatGPT interface

Different system prompt, no memory, no browsing, no personalisation. Copy that
was good in the chat window may not be reproduced by the same model over the
API. The eval templates in `evals/templates/` exist so you can measure a model
on your own tasks instead of assuming.

### node:sqlite is still marked experimental

It works, it ships with Node 22.5+, and it avoids a native compile on Windows.
Node prints an experimental warning to stderr. If a future Node changes the API,
`src/store/db.ts` is the only file that touches it.

---

## What is deliberately absent

- **No automatic retrieval.** The caller passes excerpts. Nothing reaches into a
  repository, a wiki or a database on its own.
- **No refinement loop between the models.** Two rounds maximum, and no
  configuration turns that into an unbounded critique cycle.
- **No separate UI.** Claude Code is the interface.
- **No cloud state.** Everything is one local SQLite file you can delete.
- **No telemetry.**

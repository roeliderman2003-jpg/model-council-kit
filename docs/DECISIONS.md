# Design decisions

Why the system is shaped this way. Each entry names the alternative that was
rejected, so a future change can weigh the same trade-off.

---

## 1. The code computes the winner, not the model

**Decision.** The evaluator returns per-criterion scores and hard-failure
findings. `computeComparison` — a pure function with no network call in it —
produces the verdict.

**Rejected:** asking the judge "which is better, and why". It is simpler and it
is what most comparison harnesses do.

**Why.** A model that can name a winner will always produce a fluent reason for
the winner it named, and that reason reads as analysis. Splitting the roles
means the arithmetic is inspectable, the weights are yours, and the neutrality
tests can flip the inputs and assert exactly — no sampling, no flakiness. The
evaluator's output schema has no `winner` field, so the constraint is enforced
by the API rather than by an instruction it might drift from.

## 2. A gap below the threshold escalates rather than resolving

**Decision.** `gap < decision_threshold` returns `NEEDS_USER_DECISION`.

**Rejected:** returning the higher score anyway, with a "low confidence" note.

**Why.** A close call presented as a verdict gets acted on as a verdict. `TIE`
is still reachable, but only when the caller passes `allow_tie: true` — an
explicit opt-out for low-stakes work.

## 3. Outcomes and evaluations live in different tables

**Decision.** `evaluations` and `outcomes` are separate, joined only at read
time. An outcome never updates an evaluation row.

**Rejected:** a `final_verdict` column on the task, updated as evidence arrives.

**Why.** The interesting signal is *disagreement* — the judge preferred Claude,
the CPL preferred GPT. A single mutable column destroys exactly that. Keeping
both means `contradicted_evaluator` can be surfaced, which is the thing worth
knowing about your judge.

## 4. Position is randomised from a stored seed

**Decision.** A seed decides which candidate is `response_1`. The seed is stored.

**Rejected:** always A first; or randomising without recording it.

**Why.** Position bias is real. Recording the seed makes a suspicious verdict
replayable with the order flipped — which is a debugging capability, not just a
mitigation.

## 5. Author tells are stripped, not the whole style

**Decision.** `stripAuthorTells` removes self-identifying phrases only ("As
Claude,", "GPT version:"), and reports what it removed.

**Rejected:** normalising both candidates' style before judging.

**Why.** Style is a large part of what is being judged. Normalising it would
destroy the signal. A narrow strip removes only the leak. The patterns require a
self-referential frame, so "we use Claude for support" survives — verified by
test.

## 6. node:sqlite over better-sqlite3

**Decision.** The built-in module.

**Rejected:** `better-sqlite3`, which is faster and more mature.

**Why.** `better-sqlite3` needs node-gyp and a working MSVC toolchain on
Windows. That is a real install failure mode for a tool meant to be dropped in.
`node:sqlite` has zero install cost and is fast enough for a few thousand rows.
The cost is an experimental-API warning and a single file (`src/store/db.ts`) to
change if the API moves.

## 7. Rule-based routing, with statistics that inform rather than act

**Decision.** `auto_routing_changes_enabled: false`. Statistics are reported.

**Rejected:** a bandit that reallocates traffic on measured win rates.

**Why.** With a handful of tasks a week, a bandit would be fitting noise. And
when a router surprises you, "copy goes to GPT by default" is an answer;
"the policy converged" is not. The Wilson intervals and `insufficient_sample`
flags exist so the human doing the reallocating can see how thin the evidence is.

## 8. Failures are data, not exceptions

**Decision.** Every tool returns `{ok, data?, error?, notes[]}`. A missing key, a
budget refusal and a timeout all come back as `ok: false` with a `reason`, a
`message` and a `suggestion`. `isError` stays false at the MCP layer.

**Rejected:** throwing, and letting the host render a tool error.

**Why.** These are *expected* answers Claude must read and act on: continue
alone, tell the user why, preserve the work. A transport-level error invites a
retry, which is wrong for all three.

## 9. Content is hashed, not stored

**Decision.** `store_full_content: false` by default.

**Rejected:** storing every candidate for later analysis.

**Why.** Provenance, cost and verdict history are what the statistics need. The
text is not, and a local database slowly filling with customer material is a
liability that buys little. The flag exists for a debugging session.

## 10. A timeout is not retried

**Decision.** When our own timer fires, the error is returned immediately.

**Rejected:** treating a timeout as transient and retrying.

**Why.** An aborted request is still billed for the generation already done.
Retrying a slow call multiplies the charge for the thing that was already too
expensive in time. A 429 or a 5xx is retried, because those genuinely produced
nothing.

**Implementation note.** The OpenAI SDK wraps an `AbortError` into its own
`APIConnectionError`, so the error *shape* cannot identify a timeout. A flag set
by our own timer is the only reliable witness. An integration test covers this.

## 11. Model names live in config and env, never in source

**Decision.** `OPENAI_GENERATOR_MODEL`, `OPENAI_EVALUATOR_MODEL`,
`OPENAI_FAST_MODEL` override `config/default.json`.

**Why.** Model names change faster than code. Being able to point the evaluator
at a different family from the generator is also the main lever against a judge
preferring its own house style.

## 12. Three config layers, secrets in none of them

**Decision.** `config/default.json` < `config/local.json` (git-ignored) <
`<cwd>/.model-council.json` < environment. The key is read only from
`process.env`.

**Why.** A per-project file lets one repository pin a tighter budget without
touching the user-level install. Keeping the key out of all three means no
config file is ever sensitive, so `council_config` can print everything.

## 13. The context builder retrieves nothing

**Decision.** The caller passes excerpts. `buildContextPack` validates, redacts,
caps and frames them.

**Rejected:** letting the tool pull from WikiBrain or a repository itself.

**Why.** Two reasons. Cost and leakage: automatic retrieval sends far more than
needed, and what it sends is hard to predict. And single-source: the knowledge
lives in WikiBrain, and a copy inside this tool would drift from it. Claude
already knows which excerpt matters — that judgement is upstream of this layer.

## 14. Seven tools, not four

**Decision.** The four specified tools plus `route_task`, `council_config` and
`register_candidate`.

**Why.** `route_task` makes the mode decision inspectable and free — it calls no
API, so the "why this mode" line costs nothing. `register_candidate` lets
Claude's own work enter the record, without which the statistics would only ever
describe GPT and no comparison could be attributed. `council_config` answers
"what is actually active right now", which is the first question when behaviour
surprises you.

## 15. A skill plus five thin commands

**Decision.** One skill carries the policy; five command files are thin entry
points that invoke it.

**Why.** In Claude Code a skill's name is its slash command, so `/gpt` and
`/compare-models` need their own files. Keeping the policy in one place means it
cannot drift between five copies.

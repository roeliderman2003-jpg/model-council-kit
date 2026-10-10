# Eval templates

Seven representative tasks. Each is a **template with placeholders** — the real
business data is yours to fill in, and none of it is invented here.

## How to fill one in

1. Copy the template, e.g. `cp landing-page-copy.json my-landing-page.json`.
2. Replace every `<<...>>` placeholder with a real value.
3. Delete any field you genuinely have no value for, rather than guessing —
   an invented "approved fact" is worse than a missing one, because the model
   will treat it as confirmed.
4. Run it:

```bash
npm run council -- eval my-landing-page.json --dry
```

`--dry` shows exactly what would be sent. Drop it to make the real calls.

## What each field means

| Field | Meaning |
|---|---|
| `original_request` | What you would actually type. Verbatim, not cleaned up. |
| `brief` | What the task must achieve. |
| `approved_facts` | The **only** facts a model may assert. Everything else must be flagged as an assumption. |
| `constraints` | Hard rules. A violation is a disqualification, not a deduction. |
| `audience` | Who it is for. Vague audience produces vague copy. |
| `brand_voice` | Register and tone to match. |
| `source_material` | Excerpts only. Never a whole file, repository or database. |
| `success_criteria` | How you will know it worked. |
| `expected` | What a good answer looks like. Used for your own reading, not scored automatically. |
| `must_not_contain` | Phrases that would make the answer wrong. Cheap regression check. |

## Files

- `landing-page-copy.json` — long-form copy against approved facts
- `lead-ad.json` — short paid-social ad
- `whatsapp-message.json` — broadcast message, tone-sensitive
- `sales-objection-analysis.json` — qualitative analysis over call excerpts
- `feature-spec.json` — engineering spec, Claude-default territory
- `code-review.json` — code judgement where tests outrank opinion
- `customer-research-summary.json` — synthesis across interview excerpts

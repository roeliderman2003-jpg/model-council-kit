# Setting OPENAI_API_KEY on Windows

The key lives in **one place only**: a Windows user environment variable. Not in
a file in this repository, not in `.claude.json`, not in a config file, and not
pasted into a chat.

---

## Step 1 — get the key

1. Open <https://platform.openai.com/api-keys> in your browser.
2. Create a key. Give it a name you will recognise later, e.g. `model-council-windows`.
3. Copy it. OpenAI shows it once.

Do **not** paste it into a Claude Code chat, a commit, a screenshot, or a
message. If it ever lands in one of those, revoke it on that page and make a new
one — a revoked key costs nothing, a leaked one can cost a great deal.

## Step 2 — set it

Open **PowerShell** (a normal window, no administrator rights needed) and run:

```powershell
setx OPENAI_API_KEY "paste-your-key-here"
```

`setx` writes to your Windows user profile permanently. The value survives
reboots and applies to every program you launch afterwards.

**Two things people get wrong here:**

- `setx` does **not** affect the window you typed it in, or any program that is
  already running. Close and reopen Claude Code afterwards.
- Do not use `$env:OPENAI_API_KEY = "..."`. That sets it for the current
  PowerShell session only, and it disappears when the window closes.

## Step 3 — restart Claude Code, then verify

Fully quit Claude Code and start it again, so it inherits the new variable.
Then run:

```bash
node ~/model-council/scripts/doctor.mjs
```

It reports whether a key is present and **how many characters it is** — never
the value itself. Look for:

```
OpenAI key
  OK    OPENAI_API_KEY present (164 chars)
```

## Step 4 — one real call, on purpose

```bash
cd ~/model-council
npm run smoke -- --dry
```

That prints the exact payload and calls nothing. When the payload looks right:

```bash
npm run smoke -- --confirm
```

One call, on the cheap model, on a task with no business data in it. Typically
under a cent.

---

## Checking what is set, without printing it

```powershell
if ([Environment]::GetEnvironmentVariable("OPENAI_API_KEY","User")) { "set" } else { "not set" }
```

To see the length without the value:

```powershell
[Environment]::GetEnvironmentVariable("OPENAI_API_KEY","User").Length
```

## Removing it

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", $null, "User")
```

Then restart Claude Code. Model Council keeps working — it falls back to
Claude-only and says so on every routing decision.

## Using a different key per project

Set the variable normally for everyday use, and override it for one project by
launching Claude Code from a shell where you have set a session-scoped value:

```powershell
$env:OPENAI_API_KEY = "the-other-key"
claude
```

That override lives only in that window.

---

## What the code does with it

- It is read from `process.env.OPENAI_API_KEY` at call time, never cached to disk.
- `scrubForLog` masks it **by value** in every log line and every error message,
  so even a key format the redactor does not recognise cannot be printed.
- The same masking applies to any environment variable whose name contains
  `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`.
- `council_config` deliberately has no field that could carry it.

There is a test for each of those claims in `test/security/security.test.ts`.

## If OpenAI rejects the key

A 401 or 403 is reported as `no_api_key` with the suggestion to check the key,
rather than as a generic outage — the two need different fixes. Common causes:

- The key was revoked, or belongs to a different organisation.
- The account has no credit. Check <https://platform.openai.com/usage>.
- The model in `config/default.json` is not enabled for your account. A model
  being listed publicly does not mean your key can call it — try the `fast`
  model first, and change `OPENAI_GENERATOR_MODEL` if needed.

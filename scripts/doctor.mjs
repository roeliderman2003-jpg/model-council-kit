#!/usr/bin/env node
/**
 * Install diagnostics. Run when the mcp__model-council__* tools are missing.
 *
 * Reports what is wrong AND the exact command to fix it. Never prints a key —
 * only whether one is present and how long it is.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';

let problems = 0;
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m, fix) => {
  problems++;
  console.log(`  FAIL  ${m}`);
  if (fix) console.log(`        fix: ${fix}`);
};
const warn = (m) => console.log(`  WARN  ${m}`);

console.log('\nModel Council — install check\n');

// 1. Node
console.log('Runtime');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} is too old`, 'install Node 22 or newer — node:sqlite is required');

try {
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(':memory:').close();
  ok('node:sqlite available');
} catch (e) {
  bad(`node:sqlite unavailable: ${e.message}`, 'upgrade Node to 22.5 or newer');
}

// 2. Install
console.log('\nInstall');
for (const rel of ['package.json', 'src/server.ts', 'config/default.json']) {
  if (fs.existsSync(path.join(ROOT, rel))) ok(rel);
  else bad(`missing ${rel}`, `cd ${ROOT} && npm install`);
}
if (fs.existsSync(path.join(ROOT, 'dist', 'src', 'server.js'))) ok('dist/src/server.js (compiled server)');
else bad('dist/src/server.js is missing — the server cannot start', `cd ${ROOT} && npm run build`);

const rubricDir = path.join(ROOT, 'config', 'rubrics');
const rubrics = fs.existsSync(rubricDir) ? fs.readdirSync(rubricDir).filter((f) => f.endsWith('.json')) : [];
if (rubrics.length) ok(`${rubrics.length} rubric(s): ${rubrics.map((r) => r.replace('.json', '')).join(', ')}`);
else bad('no rubrics installed', 'restore config/rubrics/ from the repository');

// 3. How GPT is reached. Two independent routes; either one is enough, and
// the free one is checked first because it is the one to prefer.
console.log('\nGPT route');

const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
let codexBin =
  process.env.CODEX_BINARY && fs.existsSync(process.env.CODEX_BINARY) ? process.env.CODEX_BINARY : null;
if (!codexBin && process.env.LOCALAPPDATA) {
  const binRoot = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(binRoot)) {
    for (const d of fs.readdirSync(binRoot)) {
      const exe = path.join(binRoot, d, 'codex.exe');
      if (fs.existsSync(exe)) { codexBin = exe; break; }
    }
  }
}

let codexUsable = false;
if (codexBin) {
  let mode = null;
  try {
    mode = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).auth_mode ?? null;
  } catch { /* not signed in */ }
  if (mode === 'chatgpt') {
    codexUsable = true;
    ok('Codex CLI signed in with ChatGPT - GPT available at NO API charge');
    console.log(`        binary: ${codexBin}`);
    console.log('        Uses your plan included usage. Consumes plan rate limit, shared with interactive Codex.');
  } else if (mode) {
    codexUsable = true;
    warn(`Codex CLI signed in with auth_mode "${mode}" - NOT the subscription, so calls may be billed`);
  } else {
    warn('Codex CLI found but not signed in');
    console.log('        Run `codex` once and choose "Sign in with ChatGPT" for GPT at no extra cost.');
  }
} else {
  warn('Codex CLI not found');
  console.log('        Installing it gives GPT on your ChatGPT plan with no API billing:');
  console.log('        https://developers.openai.com/codex');
}

const key = process.env.OPENAI_API_KEY;
if (key && key.trim()) ok(`OPENAI_API_KEY present (${key.trim().length} chars) - billed per token`);
else if (codexUsable) ok('OPENAI_API_KEY not set - not needed, the Codex route is active');
else {
  warn('OPENAI_API_KEY is not set and Codex is unavailable');
  console.log('        Everything still works; Claude just handles every task alone.');
  console.log(`        To enable GPT, see ${path.join(ROOT, 'docs', 'WINDOWS-API-KEY.md')}`);
  console.log('        Note: after setx you must restart Claude Code for it to inherit the variable.');
}

// 4. Storage
console.log('\nStorage');
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
  const dbPath = process.env.MODEL_COUNCIL_DB_PATH || path.join(ROOT, cfg.storage.db_path);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
  const tasks = (() => {
    try {
      return db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
    } catch {
      return 0;
    }
  })();
  db.close();
  ok(`database writable at ${dbPath} (${row.n} tables, ${tasks} tasks recorded)`);
} catch (e) {
  bad(`database problem: ${e.message}`, 'check the data/ directory is writable');
}

// 5. MCP registration
console.log('\nClaude Code registration');
const claudeJson = path.join(HOME, '.claude.json');
let registered = false;
try {
  const j = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  const inGlobal = j.mcpServers && Object.keys(j.mcpServers).includes('model-council');
  const inProject = Object.values(j.projects || {}).some(
    (p) => p.mcpServers && Object.keys(p.mcpServers).includes('model-council'),
  );
  registered = Boolean(inGlobal || inProject);
  if (inGlobal) ok('registered in the user-level mcpServers');
  else if (inProject) ok('registered at project level');
} catch {
  warn(`could not read ${claudeJson}`);
}
if (!registered) {
  bad(
    'model-council is not registered as an MCP server',
    `node "${path.join(ROOT, 'scripts', 'register-mcp.mjs')}"`,
  );
}

const skillPath = path.join(HOME, '.claude', 'skills', 'model-council', 'SKILL.md');
if (fs.existsSync(skillPath)) ok('skill installed');
else bad('skill not installed', `copy ${path.join(ROOT, 'skill', 'SKILL.md')} to ${skillPath}`);

const cmdDir = path.join(HOME, '.claude', 'commands');
const expected = ['gpt.md', 'compare-models.md', 'router-stats.md', 'record-outcome.md', 'router-config.md'];
const present = expected.filter((f) => fs.existsSync(path.join(cmdDir, f)));
if (present.length === expected.length) ok(`all ${expected.length} slash commands installed`);
else bad(`${present.length}/${expected.length} slash commands installed`, `copy ${path.join(ROOT, 'commands')}\\*.md to ${cmdDir}`);

// 6. Is the RUNNING server older than the build?
//
// The host launches a server once and keeps it for the session. `npm run
// build` does not restart it, so after a code change the live process still
// serves the previous build while every file on disk says the change landed.
// The symptom is a fix that appears not to have worked.
console.log('\nRunning server');
try {
  const built = path.join(ROOT, 'dist', 'src', 'server.js');
  const builtAt = fs.existsSync(built) ? fs.statSync(built).mtimeMs : 0;
  const ps = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*model-council*dist*' } | ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') }",
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  const starts = ps.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x) => Date.parse(x));
  if (!starts.length) {
    ok('no server process running yet — it starts with Claude Code');
  } else {
    const newest = Math.max(...starts);
    // Compare BUILD IDENTITY, not timestamps. tsc rewrites dist on every
    // build even when the output is byte-identical, so an mtime comparison
    // reports a current server as stale after any test run — and a check
    // that fires when nothing is wrong stops being read.
    let currentId = null;
    let runningId = null;
    try {
      currentId = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'build-id.json'), 'utf8')).build_id;
    } catch { /* not stamped yet */ }
    try {
      runningId = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'running-build.json'), 'utf8')).build_id;
    } catch { /* server has not recorded one */ }

    if (!currentId) {
      warn('dist carries no build id — run `npm run build` to stamp one');
    } else if (!runningId) {
      warn(`a server is running but recorded no build id (started ${new Date(newest).toISOString()}); restart it to enable this check`);
    } else if (runningId === currentId) {
      ok(`running server matches the current build (${currentId})`);
    } else {
      bad(
        `the running server is build ${runningId}, but dist is ${currentId} — it is serving older code`,
        'restart Claude Code. Rebuilding does not restart an already-running MCP server.',
      );
    }
    if (starts.length > 1) {
      warn(`${starts.length} server processes are running; stale ones are harmless but can be killed`);
    }
  }
} catch (e) {
  warn(`could not inspect running processes: ${String(e.message).split(/\r?\n/)[0]}`);
}

// 7. The server actually boots
console.log('\nServer boot');
try {
  const out = execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'boot-probe.mjs')],
    { encoding: 'utf8', timeout: 60000, cwd: ROOT },
  );
  const line = out.trim().split('\n').pop();
  ok(`server responds — ${line}`);
} catch (e) {
  bad(`server did not start: ${String(e.stderr || e.message).split('\n')[0]}`, `cd ${ROOT} && npm run typecheck`);
}

console.log(
  problems === 0
    ? '\nAll checks passed.\n'
    : `\n${problems} problem(s) found. Fix the FAIL lines above, then re-run.\n`,
);
process.exit(problems === 0 ? 0 : 1);

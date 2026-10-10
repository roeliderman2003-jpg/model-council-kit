#!/usr/bin/env node
/**
 * Registers the server in ~/.claude.json when the `claude` CLI is not reachable.
 *
 * .claude.json is a hot shared file — several Claude Code sessions may be
 * running at once. This script therefore: backs up first, adds exactly one key,
 * writes atomically via a temp file and rename, and verifies afterwards that the
 * top-level key count and the project count are unchanged. If anything looks
 * off it restores the backup and says so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const TARGET = path.join(HOME, '.claude.json');
const remove = process.argv.includes('--remove');

if (!fs.existsSync(TARGET)) {
  console.error(`${TARGET} not found. Start Claude Code once, then re-run.`);
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
const beforeKeys = Object.keys(before).length;
const beforeProjects = Object.keys(before.projects || {}).length;
const beforeServers = Object.keys(before.mcpServers || {});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${TARGET}.backup-${stamp}`;
fs.copyFileSync(TARGET, backup);
console.log(`backup:   ${backup}`);

if (remove) {
  if (!before.mcpServers?.['model-council']) {
    console.log('model-council was not registered. Nothing to do.');
    fs.unlinkSync(backup);
    process.exit(0);
  }
  delete before.mcpServers['model-council'];
} else {
  if (before.mcpServers?.['model-council']) {
    console.log('model-council is already registered. Nothing to do.');
    fs.unlinkSync(backup);
    process.exit(0);
  }
  before.mcpServers = before.mcpServers || {};
  // Point at the COMPILED server, not at tsx. Running the TypeScript through
  // tsx recompiles the whole dependency tree on every boot: ~17s warm, and past
  // the 30s MCP connect timeout on a cold disk after a reboot. Plain node on
  // the built output boots in about a second.
  const built = path.join(ROOT, 'dist', 'src', 'server.js');
  if (!fs.existsSync(built)) {
    console.error(`
${built} is missing. Run \`npm run build\` first.
`);
    fs.unlinkSync(backup);
    process.exit(1);
  }
  // Absolute node path, not the bare string 'node'. The host resolves the
  // command against ITS OWN environment, which a GUI-launched app does not
  // necessarily share with a terminal — and a command that fails to resolve
  // surfaces as a connect timeout rather than as "command not found", which is
  // the least diagnosable failure this server can have.
  before.mcpServers['model-council'] = {
    type: 'stdio',
    command: process.execPath,
    args: [built],
    env: {},
  };
}

// Atomic write: temp file in the same directory, then rename.
const tmp = `${TARGET}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(before, null, 2), 'utf8');
fs.renameSync(tmp, TARGET);

// Verify nothing else moved.
const after = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
const afterKeys = Object.keys(after).length;
const afterProjects = Object.keys(after.projects || {}).length;
const afterServers = Object.keys(after.mcpServers || {});
const expectedServers = remove
  ? beforeServers.filter((s) => s !== 'model-council')
  : [...beforeServers, 'model-council'];

const problems = [];
if (afterKeys !== beforeKeys) problems.push(`top-level keys ${beforeKeys} -> ${afterKeys}`);
if (afterProjects !== beforeProjects) problems.push(`projects ${beforeProjects} -> ${afterProjects}`);
if (afterServers.sort().join() !== expectedServers.sort().join())
  problems.push(`mcpServers ${beforeServers.join()} -> ${afterServers.join()}`);

if (problems.length) {
  fs.copyFileSync(backup, TARGET);
  console.error(`\nUnexpected change, backup restored:\n  ${problems.join('\n  ')}\n`);
  process.exit(1);
}

console.log(`servers:  ${afterServers.join(', ')}`);
console.log(`projects: ${afterProjects} (unchanged)`);
console.log(remove ? '\nmodel-council removed.\n' : '\nmodel-council registered. Restart Claude Code to load it.\n');

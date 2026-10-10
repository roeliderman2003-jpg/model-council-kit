#!/usr/bin/env node
/**
 * Installs the skill and slash commands into the user-level Claude Code
 * directory, and registers the MCP server.
 *
 * Non-destructive: it never overwrites an unrelated file, and it prints the
 * command it would run rather than editing .claude.json directly, so an
 * existing MCP configuration is not disturbed by this script.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CLAUDE_DIR = path.join(HOME, '.claude');
const args = process.argv.slice(2);
const force = args.includes('--force');

console.log('\nModel Council — install\n');

// The skill and commands name this folder; {{COUNCIL_DIR}} is filled in here
// so the files work wherever the project was unpacked.
const COUNCIL_DIR = ROOT.split(path.sep).join('/');

function copyIfSafe(src, dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const content = fs.readFileSync(src, 'utf8').split('{{COUNCIL_DIR}}').join(COUNCIL_DIR);
  if (fs.existsSync(dest) && !force) {
    const same = content === fs.readFileSync(dest, 'utf8');
    if (same) {
      console.log(`  unchanged  ${label}`);
      return;
    }
    fs.copyFileSync(dest, `${dest}.backup`);
    console.log(`  backed up  ${label} -> ${path.basename(dest)}.backup`);
  }
  fs.writeFileSync(dest, content, 'utf8');
  console.log(`  installed  ${label}`);
}

// 1. Skill
copyIfSafe(
  path.join(ROOT, 'skill', 'SKILL.md'),
  path.join(CLAUDE_DIR, 'skills', 'model-council', 'SKILL.md'),
  'skill: model-council',
);

// 2. Slash commands
const cmdSrc = path.join(ROOT, 'commands');
for (const file of fs.readdirSync(cmdSrc).filter((f) => f.endsWith('.md'))) {
  copyIfSafe(path.join(cmdSrc, file), path.join(CLAUDE_DIR, 'commands', file), `command: /${file.replace('.md', '')}`);
}

// 3. Build. The server must run as compiled JavaScript: going through tsx
// recompiles the dependency tree on every boot (~17s warm, over the 30s MCP
// connect timeout on a cold disk), which shows up as a server that simply
// fails to connect after a reboot.
console.log('');
const built = path.join(ROOT, 'dist', 'src', 'server.js');
try {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe', shell: process.platform === 'win32' });
  console.log('  built      dist/src/server.js');
} catch (e) {
  console.log(`  FAILED     npm run build: ${String(e.message).split(/\r?\n/)[0]}`);
  console.log('             The server cannot start without it. Fix the build, then re-run.');
  process.exit(1);
}

// 4. MCP registration
const addCmd = ['mcp', 'add', 'model-council', '--scope', 'user', '--', 'node', built];

let registered = false;
try {
  const j = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
  registered = Boolean(j.mcpServers && j.mcpServers['model-council']);
} catch {
  /* file may not exist yet */
}

if (registered && !force) {
  console.log('  unchanged  MCP server already registered');
} else {
  try {
    execFileSync('claude', addCmd, { stdio: 'pipe', encoding: 'utf8', shell: true });
    console.log('  installed  MCP server registered (user scope)');
  } catch (e) {
    console.log('  MANUAL     could not run the claude CLI here. Run this yourself:\n');
    console.log(`    claude mcp add model-council --scope user -- node "${built}"\n`);
    console.log(`    (${String(e.message).split(/\r?\n/)[0]})`);
  }
}

console.log('\nNext:');
console.log('  1. Restart Claude Code so it loads the server, the skill and the commands.');
console.log('  2. Sign in to Codex with your ChatGPT account if you have not:  codex login');
console.log(`  3. Verify:  node "${path.join(ROOT, 'scripts', 'doctor.mjs')}"\n`);

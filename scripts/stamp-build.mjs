#!/usr/bin/env node
/**
 * Writes a content fingerprint of the compiled server after every build.
 *
 * The doctor needs to answer "is the running server serving current code?".
 * Timestamps cannot answer it: `tsc` rewrites dist on every build even when the
 * output is byte-identical, so a running server that IS current looks stale the
 * moment anyone runs the tests. A check that fires when nothing is wrong gets
 * ignored, and then it is not there for the case it was built for.
 *
 * A hash of the emitted JavaScript answers it exactly. The server records the
 * id it loaded; the doctor compares that against the id on disk. Identical
 * output produces an identical id, so a rebuild is silent and a real code
 * change is caught.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'src');

if (!fs.existsSync(DIST)) {
  console.error('dist/src is missing — run `npm run build` first.');
  process.exit(1);
}

/** Every emitted .js file, sorted, hashed as one stream. Source maps excluded. */
const files = fs
  .readdirSync(DIST, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.js'))
  .sort();

const h = crypto.createHash('sha256');
for (const rel of files) {
  h.update(rel);
  h.update(fs.readFileSync(path.join(DIST, rel)));
}
const buildId = h.digest('hex').slice(0, 16);

fs.writeFileSync(
  path.join(ROOT, 'dist', 'build-id.json'),
  JSON.stringify({ build_id: buildId, files: files.length, stamped_at: new Date().toISOString() }, null, 2),
  'utf8',
);

console.log(`build ${buildId} (${files.length} files)`);

#!/usr/bin/env node
/**
 * Boots the MCP server in-process over a linked pair of transports and lists
 * its tools. Used by doctor.mjs to prove the server actually starts, rather
 * than only that its files exist.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist', 'src', 'server.js')],
  env: { ...process.env },
  stderr: 'pipe',
});

const client = new Client({ name: 'boot-probe', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const cfg = await client.callTool({ name: 'council_config', arguments: { section: 'models' } });
const parsed = JSON.parse(cfg.content[0].text);
await client.close();

console.log(
  `${tools.length} tools · generator=${parsed.models?.generator ?? '?'} · evaluator=${parsed.models?.evaluator ?? '?'} · boot ${Date.now() - startedAt}ms`,
);
process.exit(0);

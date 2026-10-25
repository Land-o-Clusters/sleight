#!/usr/bin/env node
// Read-only metadata timing. Never starts a benchmark, app, card or Apple event.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';

const started = performance.now();
const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript',
  fileURLToPath(new URL('../plugins/sleight/lib/remote-approvals.js', import.meta.url)), '{"operation":"catalog"}'],
{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
const elapsedMs = performance.now() - started, catalog = JSON.parse(stdout);
if (!Array.isArray(catalog.apps)) throw Error(catalog.error ?? 'App catalog unavailable');
console.log(JSON.stringify({ elapsedMs, apps: catalog.apps.length, defaults: Object.keys(catalog.defaults ?? {}).length, load: loadavg() }));

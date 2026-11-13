#!/usr/bin/env node
// Print locations and categories only. Never echo the private added lines.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { privateIdentity, privateMatches } from './lib/public-privacy.mjs';

export async function scanHistory({ range = 'origin/main..HEAD', cwd = process.cwd(), identity = privateIdentity(), onHit = () => {} } = {}) {
  if (!range || range.startsWith('-') || range.includes('\0')) throw Error('Expected one Git revision range');
  const child = spawn('/usr/bin/git', ['-c', 'core.quotepath=false', 'log', '--format=%x00%H', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--diff-merges=first-parent', '-p', range, '--'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  let commit = '', file = '', addedLine = 0, inHunk = false, hits = 0;
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (/^\0[a-f0-9]{40,64}$/.test(line)) {
      commit = line.slice(1); file = ''; inHunk = false;
    } else if (line.startsWith('diff --git ')) {
      file = ''; inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const path = line.slice(4).split('\t')[0];
      file = (path.startsWith('"') ? JSON.parse(path) : path).replace(/^b\//, '');
    } else if (line.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) throw Error('Unrecognized Git hunk');
      addedLine = Number(match[1]); inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      const matches = privateMatches(line.slice(1), identity);
      if (matches.length) { hits++; onHit({ commit, file, line: addedLine, matches }); }
      addedLine++;
    } else if (inHunk && line.startsWith(' ')) addedLine++;
  }
  const result = await completion;
  if (result.code !== 0) throw Error(`git log failed (${result.code ?? result.signal}): ${stderr.trim()}`);
  return { hits };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1) throw Error('Usage: node scripts/release-history-scan.mjs [RANGE]');
  const range = args[0] ?? 'origin/main..HEAD';
  const { hits } = await scanHistory({ range, onHit: hit => {
    console.log(`${hit.commit} ${JSON.stringify(hit.file)}:${hit.line}: ${hit.matches.join(', ')}`);
  } });
  console.log(`Release history scan: ${hits} added line(s) contain private identity data.`);
  return hits ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

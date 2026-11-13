#!/usr/bin/env node
// Print locations and categories only. Never echo the private added lines.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateIdentity, privateMatches } from './lib/public-privacy.mjs';

// Git terminates patch lines with LF. CR, including the CR in CRLF, is file content.
async function* lfLines(input) {
  input.setEncoding('utf8');
  let pending = [];
  for await (const chunk of input) {
    let start = 0, end;
    // Search each chunk once; join a long line only when it is complete.
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      const part = chunk.slice(start, end);
      if (pending.length) {
        pending.push(part);
        yield pending.join('');
        pending = [];
      } else yield part;
      start = end + 1;
    }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length) yield pending.join('');
}

export async function scanHistory({ range = 'origin/main..HEAD', cwd = process.cwd(), identity = privateIdentity(), onHit = () => {} } = {}) {
  if (!range || range.startsWith('-') || range.includes('\0')) throw Error('Expected one Git revision range');
  // Pin blank context and a/b prefixes independently of the user's diff configuration.
  const child = spawn('/usr/bin/git', ['-c', 'core.quotepath=false', '-c', 'diff.suppressBlankEmpty=false',
    'log', '--format=%x00%H', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
    '--no-renames', '--diff-merges=first-parent', '-p', range, '--'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  let commit = '', file = '', addedLine = 0, inHunk = false, hits = 0;
  let oldRemaining = 0, newRemaining = 0, failure;
  for await (const line of lfLines(child.stdout)) {
    // Drain Git and collect its exit even when a malformed patch has already failed.
    if (failure) continue;
    if (inHunk) {
      if (line.startsWith('+')) {
        const matches = privateMatches(line.slice(1), identity);
        if (matches.length) { hits++; onHit({ commit, file, line: addedLine, matches }); }
        addedLine++; newRemaining--;
      } else if (line.startsWith('-')) oldRemaining--;
      else if (line === '' || line.startsWith(' ')) { addedLine++; oldRemaining--; newRemaining--; }
      else if (line.startsWith('\\')) continue;
      else { failure = Error('Unrecognized line in Git hunk'); continue; }
      if (oldRemaining < 0 || newRemaining < 0) failure = Error('Unrecognized line in Git hunk');
      inHunk = oldRemaining > 0 || newRemaining > 0;
    } else if (/^\0[a-f0-9]{40,64}$/.test(line)) {
      commit = line.slice(1); file = ''; inHunk = false;
    } else if (line.startsWith('diff --git ')) {
      file = ''; inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const path = line.slice(4).split('\t')[0];
      file = (path.startsWith('"') ? JSON.parse(path) : path).replace(/^b\//, '');
    } else if (line.startsWith('--- ')) {
      continue; // Old-file header, not a counted deletion.
    } else if (line.startsWith('@@')) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) { failure = Error('Unrecognized Git hunk'); continue; }
      oldRemaining = Number(match[1] ?? 1); newRemaining = Number(match[3] ?? 1);
      addedLine = Number(match[2]); inHunk = oldRemaining > 0 || newRemaining > 0;
    } else if (/^[+ -]/.test(line)) {
      failure = Error('Unrecognized line outside Git hunk');
    }
  }
  const result = await completion;
  if (result.code !== 0) throw Error(`git log failed (${result.code ?? result.signal}): ${stderr.trim()}`);
  if (failure) throw failure;
  if (inHunk) throw Error('Unrecognized line: incomplete Git hunk');
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

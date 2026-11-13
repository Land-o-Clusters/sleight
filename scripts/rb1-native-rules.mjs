// Offline UTF-8 inventory. Reads source and Git objects, without a model or engine.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { screenshotGuidance } from '../plugins/sleight/lib/screenshot-guidance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const path = 'plugins/sleight/skills/drive-mac-apps/';
const hash = text => createHash('sha256').update(text).digest('hex');
const read = (revision, file) => revision === 'working'
  ? readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  : execFileSync('/usr/bin/git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' });

export function inventory(revision, browserRevision = revision) {
  const skill = screenshotGuidance(read(revision, path + 'SKILL.md').replace(/^---\n[\s\S]*?\n---\n+/, '').trim());
  const browser = read(browserRevision, path + 'BROWSERS.turbo-v3.md').trimEnd()
    .replace('{browser}', 'bbench').replace('{application}', ' (Google Chrome)');
  const rules = skill.replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, browser + '\n');
  const sections = [...rules.matchAll(/(?:^# [^\n]+|^## [^\n]+)\n[\s\S]*?(?=^## |$(?![\s\S]))/gm)]
    .map(match => ({ section: match[0].split('\n')[0], bytes: Buffer.byteLength(match[0]), sha256: hash(match[0]) }));
  return { revision, browserRevision, skillBytes: Buffer.byteLength(skill), fullBytes: Buffer.byteLength(rules),
    nativeBytes: Buffer.byteLength(rules.replace(/## Browsers\n[\s\S]*?(?=\n## |$)/, '').trim()),
    sections, fullHash: hash(rules), skillHash: hash(skill) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(['v1.4.2', '78958628', '998d0dfb', 'working'].map(revision => inventory(revision))
    .concat(inventory('working', '78958628')), null, 2));
}

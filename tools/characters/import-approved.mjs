#!/usr/bin/env node
// Losslessly package the approved Chromium art. Reads source data only; launches no browser.
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CAST } from './build.mjs';
import { decodePNG } from './lib/png.mjs';

const args = process.argv.slice(2);
if (args.length !== 2) throw Error('Usage: node tools/characters/import-approved.mjs APPROVED_DIRECTORY NEW_OUTPUT');
const [source, output] = args.map(p => resolve(p));
if (fs.existsSync(output)) throw Error('Output must be absent');
const temp = fs.mkdtempSync(join(tmpdir(), 'sleight-approved-'));
const manifest = { version: 1, packs: {} };
fs.mkdirSync(output, { recursive: true });
try {
  for (const id of CAST) {
    const folder = join(output, id); fs.mkdirSync(folder);
    for (const sheet of ['sheet', 'extra', 'perch']) {
      const png = sheet === 'sheet' ? join(source, id, 'sheet.png') : join(temp, 'input.png');
      if (sheet !== 'sheet') execFileSync('dwebp', [join(source, id, `${sheet}.webp`), '-o', png], { stdio: 'ignore' });
      const webp = join(folder, `${sheet}.webp`), decoded = join(temp, 'decoded.png');
      execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', '-exact', '-metadata', 'none', png, '-o', webp]);
      execFileSync('dwebp', [webp, '-o', decoded], { stdio: 'ignore' });
      const a = decodePNG(fs.readFileSync(png)), b = decodePNG(fs.readFileSync(decoded));
      if (a.width !== b.width || a.height !== b.height || !a.data.equals(b.data)) throw Error(`${id}/${sheet}: RGBA changed`);
    }
    const data = JSON.parse(fs.readFileSync(join(source, id, 'character.json'))); data.sheet = 'sheet.webp';
    fs.writeFileSync(join(folder, 'character.json'), JSON.stringify(data, null, 2) + '\n');
    fs.copyFileSync(join(source, id, 'preview.png'), join(folder, 'preview.png'));
    manifest.packs[id] = Object.fromEntries(fs.readdirSync(folder).sort().map(name => {
      fs.chmodSync(join(folder, name), 0o644);
      return [name, createHash('sha256').update(fs.readFileSync(join(folder, name))).digest('hex')];
    }));
    console.log(`${id}: ${fs.readdirSync(folder).reduce((n, f) => n + fs.statSync(join(folder, f)).size, 0)} bytes; 3/3 sheets RGBA identical`);
  }
  fs.writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

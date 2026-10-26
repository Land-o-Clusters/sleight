#!/usr/bin/env node
// Repository entry point for the generator shipped with the installed plugin.
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCast, swiftPins } from '../../plugins/sleight/skills/make-character/tool/build.mjs';
export { buildCast, CAST, swiftPins } from '../../plugins/sleight/skills/make-character/tool/build.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--sync-native-pins') {
    const pins = JSON.parse(fs.readFileSync(new URL('../../plugins/sleight/characters/manifest.json', import.meta.url)));
    const source = new URL('../../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
    const text = fs.readFileSync(source, 'utf8');
    if (!text.includes('// BEGIN BUILTIN CHARACTER HASHES')) throw Error('Native pin marker missing');
    fs.writeFileSync(source, text.replace(/\/\/ BEGIN BUILTIN CHARACTER HASHES[\s\S]*?\/\/ END BUILTIN CHARACTER HASHES/, () => swiftPins(pins)));
  } else {
    if (args.length === 4 && args[0] === '--design' && args[2] === '--out') await buildCast(resolve(args[3]), { design: args[1] });
    else if (args.length === 2 && args[0] === '--out') await buildCast(resolve(args[1]));
    else throw Error('Usage: node tools/characters/build.mjs [--design DESIGN.mjs] --out NEW_DIRECTORY | --sync-native-pins');
  }
}

import { createHash } from 'node:crypto';

// Defer only these reviewed native how-to sections on a turbo-first session.
// An edited section stays whole until reviewed again, so a new safety line cannot
// disappear just because somebody put it under one of these headings.
const deferred = new Set([
  'aa20057c10892ce008c1290444f150471d84ba82040d2403bfb2118aa349eed2', // Calls
  'ec248c19403511227d74c7dc7c6984a116d2a400434d0a6395da8ed77aa25c5b', // Text, menus and files
  'ba184d9791115f85aa2a3ad080e8229033b768fc025d3ad2fe9cc9d67ccd4b3f', // Other tools, retain clipboard and guard rules below
]);
const nativeIntro = '`mcp__plugin_sleight_computer__js` runs persistent JavaScript with `cua`. `js_reset` restarts it.\n'
  + 'Follow engine docs and app instructions.\nTop-level `await`, no `return`. Write text with `nodeRepl.write(...)`.';

export function turboFirstRules(rules) {
  return rules.replace(nativeIntro, 'Follow engine docs and app instructions.')
    .replace(/## (?:Calls|Text, menus and files|sleight's other tools)\n[\s\S]*?(?=\n## |$)/g, section => {
    if (!deferred.has(createHash('sha256').update(section).digest('hex'))) return section;
    if (section.startsWith("## sleight's other tools")) return section.slice(section.indexOf('- Copy and Cut'));
    // Keep the file-opening safety passage with the shared stop and approval rules.
    // The complete native guidance still arrives with the first native acquisition.
    const openFile = section.match(/- Open a file[^\n]*(?:\n  [^\n]*)*/)?.[0];
    return openFile ? openFile + '\n' : '';
  });
}

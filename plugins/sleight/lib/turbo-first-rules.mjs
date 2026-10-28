import { createHash } from 'node:crypto';

// Defer only these reviewed native how-to sections on a turbo-first session.
// An edited section stays whole until reviewed again, so a new safety line cannot
// disappear just because somebody put it under one of these headings.
const deferred = new Set([
  '151b160e6b4b039b66f2b47f4c23bb11a2148947deedc757c4f87d905109b584', // Calls
  'e11c3476471507ee0e89876859f28acc7b87c7ded972af39794b3560a639af88', // Text, menus and files
  'ba184d9791115f85aa2a3ad080e8229033b768fc025d3ad2fe9cc9d67ccd4b3f', // Other tools, retain clipboard and guard rules below
]);
const nativeIntro = '`mcp__plugin_sleight_computer__js` runs persistent JavaScript with `cua`. `js_reset` restarts it.\n'
  + 'Follow engine docs and app instructions.\nTop-level `await`, no `return`. Write text with `nodeRepl.write(...)`.';

export function turboFirstRules(rules) {
  return rules.replace(nativeIntro, 'Follow engine docs and app instructions.')
    .replace(/## (?:Calls|Text, menus and files|sleight's other tools)\n[\s\S]*?(?=\n## |$)/g, section => {
    if (!deferred.has(createHash('sha256').update(section).digest('hex'))) return section;
    if (section.startsWith("## sleight's other tools")) return "## sleight's other tools\n" + section.slice(section.indexOf('- Copy and Cut'));
    // Keep the file-opening safety passage with the shared stop and approval rules.
    // The complete native guidance still arrives with the first native acquisition.
    const openFile = section.match(/- Acquire a document[^\n]*\n- Open a file[^\n]*(?:\n  [^\n]*)*/)?.[0];
    return openFile ? openFile + '\n' : '';
  });
}

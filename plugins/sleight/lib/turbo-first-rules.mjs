import { createHash } from 'node:crypto';

// Defer only these reviewed native how-to sections on a turbo-first session.
// An edited section stays whole until reviewed again, so a new safety line cannot
// disappear just because somebody put it under one of these headings.
const deferred = new Set([
  'b5d03c7056c5cdd5bcdc4c69cbe4b9ce9d7a3b84590906c88471ad05413de98d', // Calls
  '903eb02958f3cb3e58140823766a15a88facaaa33ed90ecde3946ea26ebb594a', // Text, menus and files
  'a06e65e1bdb122a30d5878b676345bfa2325c91f8b98170c59c3d98b7607257a', // Other tools, retain clipboard and guard rules below
  '81bf5dfdfa332a6b9f62e969698f951dbe13b2753ed16d9c0edda7a2aeeee561', // Calls with SLEIGHT_LEAN_CALLS=1
  '2fb8beb3c90b9edc0217efa4bb4aefa583d43a34538bb57df8d0fc0171aa8e56', // Calls with SLEIGHT_SF3=1
  'e464d0ced0539f30ac32a7059b90d1f45e1684014d27c546c6e6c485929cadb5', // SF3 with lean calls
]);
const nativeIntro = '`mcp__plugin_sleight_computer__js`: persistent JS with `cua`. `js_reset` restarts it.\n'
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

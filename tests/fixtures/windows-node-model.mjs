// Bounded PowerShell-free interpreter for discovery's branch decisions. OS observations are injected.
// This is not a PowerShell interpreter; unrecognized script structure refuses the test.
import { win32 as path } from 'node:path';
export function discoveryModel(source) {
  const read = expression => {
    const match = expression.exec(source); if (!match) throw Error('Unrecognized discovery control flow'); return match;
  };
  const canonicalBad = read(/if \(\$File[^\n]+\{ return \$(true|false) \}/)[1] === 'true';
  const reparse = read(/ReparsePoint\) \{[^\n]*return \$(true|false) \}/)[1] === 'true';
  const project = read(/'package\.json'[^\n]+\{[^\n]*return \$(true|false) \}/)[1] === 'true';
  const projectEither = read(/'\.git'\)\)\) (-or|-and)/)[1] === '-or';
  const homeExcluded = /\$cursor -ine \$profileFolder -and/.test(source);
  const locationNegated = read(/if \(((-not )?)\(Test-NodeLocation \$candidate\)\) \{ continue \}/)[2] === '-not ';
  const versionRule = /if \(\[int\]\$Matches\[1\] (-lt|-gt|-le|-ge) (\d+)\) \{[^}]+\n\s+(continue|exit 1)\n\s+\}/s.exec(source);
  const compare = { '-lt': (a,b) => a < b, '-gt': (a,b) => a > b, '-le': (a,b) => a <= b, '-ge': (a,b) => a >= b }[versionRule[1]];
  if (!/return \[IO.File\]::Exists\(\$File\)/.test(source)) throw Error('Unrecognized final file guard');
  return ({ knownFolders = [], entries = [], home, files }) => {
    const candidates = [...knownFolders.map(root => path.join(root, 'nodejs', 'node.exe')),
      ...entries.filter(root => /^[A-Za-z]:[\\/]/.test(root)).map(root => path.join(root, 'node.exe'))];
    const info = name => files.get(name.toLowerCase()) ?? {};
    const location = file => {
      if (!/^[A-Za-z]:\\/.test(file) || path.normalize(file) !== file) return canonicalBad;
      for (let cursor = file; cursor; cursor = path.dirname(cursor) === cursor ? '' : path.dirname(cursor)) {
        const item = info(cursor);
        if (item.reparse) return reparse;
        const git = item.git === true, pkg = item.package === true && (!homeExcluded || cursor.toLowerCase() !== home.toLowerCase());
        if (projectEither ? git || pkg : git && pkg) return project;
      }
      return info(file).file === true;
    };
    for (const raw of new Set(candidates)) {
      const candidate = path.normalize(raw), valid = location(candidate);
      if (locationNegated ? !valid : valid) continue;
      const major = info(candidate).major;
      if (!Number.isInteger(major)) continue;
      if (compare(major, Number(versionRule[2]))) { if (versionRule[3] === 'exit 1') return undefined; continue; }
      return candidate;
    }
  };
}
export function cmdModel(source, selected) {
  const branch = /if (not )?defined SLEIGHT_NODE \(([\s\S]*?)\n\)/i.exec(source);
  if (!branch || !/exit \/b 1/.test(branch[2]) || !/"%SLEIGHT_NODE%" "%~dp0\.\.\\lib\\launch\.mjs" %\*/.test(source)) throw Error('Unrecognized CMD control flow');
  return (branch[1] ? !selected : !!selected) ? { exit: 1 } : { node: selected, script: '..\\lib\\launch.mjs' };
}

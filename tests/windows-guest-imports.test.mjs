import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseModule, parseScript } from '../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { exportGuest, EXPORT_PATHS } from '../bench/windows/export-guest.mjs';
import { discoverSuites } from '../bench/windows/run-checks.mjs';

function imports(source) {
  let ast;
  try { ast = parseModule(source, { next: true }); }
  catch { ast = parseScript(source, { next: true }); }
  const specifiers = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) {
      if (typeof node.source?.value === 'string') specifiers.push(node.source.value);
      else if (node.type === 'ImportExpression' && node.source?.type === 'TemplateLiteral' && !node.source.expressions.length)
        specifiers.push(node.source.quasis[0].value.cooked);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  return specifiers.filter(value => value.startsWith('./') || value.startsWith('../'));
}

function unresolvedImports(root) {
  const failures = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:mjs|js)$/.test(entry.name)) {
        for (const specifier of imports(readFileSync(file, 'utf8'))) {
          const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
          let path = relative(root, target);
          let regular = false;
          try {
            regular = lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink();
            path = relative(realpathSync(root), realpathSync(target));
          } catch {}
          if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep) || !regular)
            failures.push(relative(root, file) + ' -> ' + specifier);
        }
      }
    }
  }
  walk(root);
  return failures.sort();
}

test('import audit covers static imports, re-exports and literal dynamic imports without reading strings or comments', t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-import-audit-')));
  const root = join(bank, 'kit'); mkdirSync(root);
  writeFileSync(join(bank, 'outside.mjs'), 'export const outside = true;');
  writeFileSync(join(root, 'present.mjs'), 'export const value = 1;');
  writeFileSync(join(root, 'forms.js'), `
    import './present.mjs';
    import { value } from './missing-static.mjs';
    export { value } from './missing-named.mjs';
    export * from './missing-star.mjs';
    import('./missing-dynamic.mjs');
    import(\`./missing-template.mjs\`);
    import('./present.mjs?query#fragment');
    import('../outside.mjs');
    import('node:fs');
    import(variable);
    const example = "import './not-code.mjs'";
    // import './comment.mjs';
  `);
  assert.deepEqual(unresolvedImports(root), ['../outside.mjs', './missing-dynamic.mjs', './missing-named.mjs',
    './missing-star.mjs', './missing-static.mjs', './missing-template.mjs'].map(specifier => 'forms.js -> ' + specifier).sort());
});

test('every relative import in the exported runtime fixture resolves inside the kit', { skip: process.platform === 'win32' }, t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-import-export-')));
  const root = join(bank, 'source'); mkdirSync(root);
  const source = fileURLToPath(new URL('..', import.meta.url));
  // Audit the runtime and the actual suites selected by the guest check runner.
  const paths = [...new Set([...EXPORT_PATHS.filter(path => path !== 'tests'),
    'plugins/sleight/hooks/narration.mjs', 'plugins/sleight/hooks/stop-notice.mjs'])];
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, 'tests'));
  const manifest = JSON.parse(readFileSync(join(source, 'bench/windows/check-manifest.json'), 'utf8'));
  const suites = discoverSuites(source, manifest);
  for (const suite of suites) assert.ok(suite.files.length, `${suite.item} selects no guest tests`);
  const guestTests = [...new Set([...suites.flatMap(suite => suite.files),
    'tests/windows-driver-sitting.test.mjs', 'tests/windows-vm-kit.test.mjs'])];
  const testFiles = new Set(guestTests);
  for (const path of testFiles) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(source, path), join(root, path));
    if (/\.(?:mjs|js)$/.test(path)) for (const specifier of imports(readFileSync(join(source, path), 'utf8'))) {
      const dependency = relative(source, fileURLToPath(new URL(specifier, pathToFileURL(join(source, path)))));
      if (dependency.startsWith('tests' + sep)) testFiles.add(dependency);
    }
  }
  // A Mac-only entry point must remain outside the kit.
  writeFileSync(join(root, 'plugins/sleight/hooks/register.tsx'), '// not needed by the guest runtime\n');
  const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['add', '--', ...paths, 'tests', 'plugins/sleight/hooks/register.tsx']); git(['commit', '-qm', 'Runtime fixture']);
  const output = join(bank, 'kit');
  const receipt = exportGuest({ root, revision: git(['rev-parse', 'HEAD']), output });
  const failures = unresolvedImports(output);
  t.diagnostic(`Exported ${receipt.files} files, ${receipt.bytes} bytes; ${failures.length} unresolved imports`);
  assert.deepEqual(failures, []);
  t.diagnostic(`Audited ${guestTests.length} real guest test files`);
  for (const path of guestTests) {
    const file = join(output, path), original = readFileSync(file, 'utf8');
    writeFileSync(file, original + "\nimport '../bench/missing-guest-dependency.mjs';\n");
    assert.ok(unresolvedImports(output).includes(path + ' -> ../bench/missing-guest-dependency.mjs'),
      `missing dependency in ${path} escaped the audit`);
    writeFileSync(file, original);
  }
  // A removed exporter dependency must fail the same audit used for the real kit.
  rmSync(join(output, 'plugins/sleight/skills/make-character/tool/lib/svg.mjs'));
  assert.ok(unresolvedImports(output).some(failure => failure.endsWith(' -> ./svg.mjs')));
  assert.deepEqual(readdirSync(join(output, 'plugins/sleight/hooks')).sort(), ['narration.mjs', 'stop-notice.mjs']);
});

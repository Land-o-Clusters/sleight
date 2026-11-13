import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as production from '../plugins/sleight/lib/mac-driver/build.mjs';
let { macDriverSource, prepareMacDriver, validateMacDriverClipboardSource } = production;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const buildURL = new URL('../plugins/sleight/lib/mac-driver/build.mjs', import.meta.url);
const nativeURL = new URL('../plugins/sleight/lib/mac-driver/native/', import.meta.url);
const watchPath = new URL('DriverClipboardWatch.swift', nativeURL).pathname;
const otherPath = new URL('DriverOther.swift', nativeURL).pathname;
const peerURL = new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url);

async function copyBuild(t, transform) {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-scan-build-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let text = await readFile(buildURL, 'utf8');
  text = transform(text, root);
  if (mutation) text = mutateBuild(text);
  text = text.replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, buildURL).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(buildURL.href));
  const path = join(root, 'build.mjs');
  await writeFile(path, text);
  return import(new URL('file://' + path));
}

const runtimeIdentifiers = ['NSClassFromString', 'NSSelectorFromString', 'objc_getClass', 'objc_lookUpClass',
  'objc_msgSend', 'dlsym', 'dlopen', 'classNamed', '_silgen_name', 'objc_getRequiredClass', 'objc_getClassList',
  'objc_copyClassList', 'NSProtocolFromString', 'sel_getUid', 'sel_registerName'];
const mutation = process.env.SCN1_MUTATION;
function mutateBuild(text) {
  const from = mutation === 'path' ? 'reviewedSourceLines.get(path)'
    : mutation === 'peer' ? "  validateMacDriverClipboardSource(peer.toString('utf8'), peerSource);"
    : mutation === 'count' ? "      if (source.split(literal).length !== 2) throw Error('DRIVER_CLIPBOARD_CAPABILITY');"
    : '|' + mutation;
  const to = mutation === 'path' ? "reviewedSourceLines.get(source.includes('// Source: DriverClipboardWatch.swift\\n') ? clipboardWatchPath : path)" : '';
  assert.equal(text.split(from).length, 2, `mutation ${mutation} has one production seam`);
  return text.replace(from, to);
}
before(async () => {
  if (!mutation) return;
  const module = await copyBuild({ after }, text => text);
  ({ macDriverSource, prepareMacDriver, validateMacDriverClipboardSource } = module);
});

test('source composition puts the single entry point last and contains no consent UI', async () => {
  const source = await macDriverSource();
  assert.match(source, /AXUIElementCopyMultipleAttributeValues|final class DriverCore/);
  assert.ok(source.endsWith('driverMain()\n\n'));
  assert.doesNotMatch(source, /NSPanel|NSWindow\(|orderFront|activateIgnoringOtherApps/);
  // Front restore and the keyboard focus-belief fallback each have one guarded
  // activation site. No other module may acquire an activation site.
  const activationSources = source.split('// Source: ').slice(1)
    .flatMap(part => Array.from(part.matchAll(/\.activate\(/g), () => part.split('\n')[0]));
  assert.deepEqual(activationSources, ['DriverFocusBelief.swift', 'DriverTools.swift']);
  assert.match(source, /start\(app\) == previous\.processStart/);
});

test('off-platform preparation refuses before calling the compiler', async () => {
  const result = await prepareMacDriver({ platform: 'linux', prepare() { throw Error('called'); } });
  assert.equal(result.code, 'PLATFORM');
});

test('only the exact text-belief experiment switch reaches the helper environment', () => {
  for (const value of [undefined, '', 'always', 'fallback', 'FALLBACK', 'fallback;ignored']) {
    const env = production.macDriverTextEnvironment({ SLEIGHT_DRIVER_TEXT_BELIEF: value, DYLD_INSERT_LIBRARIES: 'untrusted' });
    assert.deepEqual(env, value === 'fallback' ? { SLEIGHT_DRIVER_TEXT_BELIEF: 'fallback' } : {});
  }
});

test('builder calls the existing compile API with hashed sources and removes staging', async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-driver-build-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let staging, calls = 0;
  const host = await prepareMacDriver({ platform: 'darwin', tools: async () => true, cacheRoot: root, prepare: async options => {
    calls++; staging = options.sourceRoot;
    assert.equal(options.inventory.accepted, true);
    assert.equal((await stat(staging)).mode & 0o777, 0o700);
    const hashes = {};
    for (const file of options.inventory.files) {
      const name = file.path.split('/').at(-1), bytes = await readFile(join(staging, name));
      assert.equal(file.sha256, digest(bytes)); hashes[name] = file.sha256;
    }
    const directory = join(root, 'bank'); await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'glide-engine'), 'fake compiled driver', { mode: 0o700 });
    const record = join(directory, 'build.json');
    await writeFile(record, JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, recipes: helperBuildRecipes(hashes),
      binaries: { 'glide-engine': digest('fake compiled driver') } }), { mode: 0o600 });
    return { status: 'ready', directory, record };
  } });
  assert.equal(calls, 1); assert.equal(host.status, 'ready');
  assert.equal(host.binarySha256, digest('fake compiled driver'));
  await assert.rejects(stat(staging), { code: 'ENOENT' });
  assert.throws(() => host.spawn({ nonce: 'invalid' }), /INVALID_NONCE/);
  await writeFile(host.binary, 'tampered');
  assert.throws(() => host.spawn({ nonce: 'a'.repeat(64) }), /HOST_PACKAGE_MISMATCH/);
});

test('builder preserves unavailable results and cleans staging on refusal', async () => {
  let staging;
  const host = await prepareMacDriver({ platform: 'darwin', tools: async () => true, prepare: async options => {
    staging = options.sourceRoot; return { status: 'unavailable', code: 'HOST_BUILD_BUSY' };
  } });
  assert.equal(host.code, 'HOST_BUILD_BUSY');
  await assert.rejects(stat(staging), { code: 'ENOENT' });
});

test('GLINT3 prebuilt identity permits the executable modes accepted by packaging', async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-prebuilt-identity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'glide-engine');
  await writeFile(binary, 'prebuilt bytes', { mode: 0o755 });
  const host = await prepareMacDriver({ platform: 'darwin', prebuilt: identity => ({ binary, build: identity.build, validate() {} }),
    tools: () => assert.fail('prebuilt receipt must not inspect compiler tools') });
  assert.equal(host.origin, 'prebuilt');
  assert.equal(host.binarySha256, digest('prebuilt bytes'));
});

test('missing Apple tools refuses before compilation and removes source staging', async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-tools-missing-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let compiles = 0, probes = 0;
  const result = await prepareMacDriver({ platform: 'darwin', cacheRoot: root,
    cached: () => false, tools: async () => { probes++; return false; }, prepare: async () => { compiles++; } });
  assert.equal(result.code, 'APPLE_TOOLS_MISSING'); assert.equal(probes, 1); assert.equal(compiles, 0);
});

test('a cached build bypasses the Apple tools probe', async t => {
  let probes = 0, compiles = 0;
  const result = await prepareMacDriver({ platform: 'darwin', cached: () => true,
    tools: async () => { probes++; return false; }, prepare: async () => { compiles++; return { status: 'unavailable', code: 'HOST_BUILD_BUSY' }; } });
  assert.equal(result.code, 'HOST_BUILD_BUSY'); assert.equal(compiles, 1); assert.equal(probes, 0);
});

// Keep only the existing literal WindowServer and window-location lookups.
// Any new dynamic lookup could otherwise hide a clipboard API from this check.
const forbiddenClipboardCapability = source => {
  try { validateMacDriverClipboardSource(source); return null; } catch (error) { return error.message; }
};

test('own-runtime build excludes legacy clipboard mutation and recovery capabilities', () => {
  const source = macDriverSource();
  assert.equal(forbiddenClipboardCapability(source), null);
  assert.match(source, /struct DriverStrictText/);
  assert.equal(source.split('NSPasteboard.general.changeCount').length - 1, 1);
});

test('clipboard inventory check rejects alternate board APIs, commands and dynamic execution bridges', () => {
  const forbidden = [
    'UIPasteboard.general.string = "replacement"', 'PasteboardCreate(kPasteboardClipboard, &board)',
    'PasteboardPutItemFlavor(board, 1, type, data, 0)', 'let command = "pbcopy"', 'let command = "pbpaste"',
    'let task = Process()', 'let task = NSTask()', 'NSAppleScript(source: script)', 'NSAppleEventDescriptor()',
    'system(command)', 'popen(command, "w")', 'posix_spawn(&pid, command)', 'execve(path, argv, env)',
    'dlopen(library, 0)', 'dlsym(handle, name)', 'NSClassFromString(name)', 'NSSelectorFromString(name)',
    'objc_getClass(name)', 'objc_msgSend(board, selector)', 'sel_registerName(name)',
    'SetClipboardData(format, data)', 'OpenClipboard(window)', 'gtk_clipboard_set_text(board, text)',
    'let command = "osascript"', 'board.clearContents()', 'board.writeObjects(items)', 'board.setString(text, forType: type)',
  ];
  forbidden.push('NSPasteboard.general.string', 'board.pasteboardItems', 'board.data(forType: type)',
    'board.readObjects(forClasses: classes)', 'board.setData(data, forType: type)', 'NSPasteboardItem()',
    'NSPasteboard.PasteboardType.string', 'NSPasteboard(name: name)', 'NSPasteboard.general.changeCount');
  const source = macDriverSource();
  for (const code of forbidden) assert.ok(forbiddenClipboardCapability(source + '\n' + code), code);
  assert.ok(forbiddenClipboardCapability(source.replace('NSPasteboard.general.changeCount', '0') + '\nNSPasteboard.general.changeCount'));
});

test('clipboard inventory permits attributed text strings and unrelated types properties', () => {
  const source = macDriverSource();
  for (const code of [
    'let text = NSAttributedString(string: "document").string',
    'let value: NSAttributedString = attributed; let text = value.string',
    'struct Inventory { let types: [String] }; let types = inventory.types',
  ]) assert.equal(forbiddenClipboardCapability(source + '\n' + code), null, code);
});

test('clipboard inventory rejects each pasteboard-only name without a board receiver', () => {
  const source = macDriverSource();
  for (const code of ['pasteboardItems', 'readObjects(forClasses: classes)', 'writeObjects(items)', 'clearContents()',
    'setString(text, forType: type)', 'setData(data, forType: type)', 'data(forType: type)', 'NSPasteboardItem()']) {
    assert.equal(forbiddenClipboardCapability(source + '\n' + code), 'DRIVER_CLIPBOARD_CAPABILITY', code);
  }
});

const boardTokenWitnesses = [
  ['alias', 'let p = NSPasteboard.general; p.string(forType: type)'],
  ['second site spelled to dodge the literal count', 'let count = NSPasteboard .general.changeCount'],
];
for (const [name, code] of boardTokenWitnesses) {
  test(`clipboard inventory rejects ${name}`, () => {
    assert.equal(forbiddenClipboardCapability(macDriverSource() + '\n' + code), 'DRIVER_CLIPBOARD_CAPABILITY');
  });
}

test('removing the NSPasteboard token rule admits both forbidden witnesses', async t => {
  const module = await copyBuild(t, original => {
    const mutated = original.replace('(?:NSPasteboard|', '(?:');
    assert.notEqual(mutated, original, 'mutation must remove the production token rule');
    return mutated;
  });
  const validate = module.validateMacDriverClipboardSource;
  const source = macDriverSource();
  assert.doesNotThrow(() => validateMacDriverClipboardSource(source));
  for (const [name, code] of boardTokenWitnesses) {
    assert.throws(() => validateMacDriverClipboardSource(source + '\n' + code), /DRIVER_CLIPBOARD_CAPABILITY/, name);
    assert.doesNotThrow(() => validate(source + '\n' + code), name);
  }
});

for (const identifier of runtimeIdentifiers) {
  test(`runtime identifier rule: ${identifier}`, () => {
    const name = identifier === '_silgen_name' ? '@_silgen_name' : identifier;
    const source = macDriverSource();
    for (const code of [name, `let f = ${name}`, `(${name})(name)`, `${name} /* gap */ (name)`,
      `// ${name}`, `let name = "${name}"`,
      '`' + identifier + '`("NSPaste" + "board")']) {
      assert.throws(() => validateMacDriverClipboardSource(source + '\n' + code), /DRIVER_CLIPBOARD_CAPABILITY/, code);
      assert.throws(() => validateMacDriverClipboardSource(code, otherPath), /DRIVER_CLIPBOARD_CAPABILITY/, code);
    }
    assert.throws(() => validateMacDriverClipboardSource(`${name} /* gap */ (name)`, '/fixture/peer-host.c'), /DRIVER_CLIPBOARD_CAPABILITY/);
  });
}

test('runtime identifier rule: Selector', () => {
  const source = macDriverSource();
  for (const code of ['Selector("general" + "Paste" + "board")', 'Selector(("general" + "Paste" + "board"))',
    'Selector /* gap */ ("clear")', '`Selector`("clear")', 'Selector(#"general"#)',
    'Selector("""general""")', 'Selector /* outer /* inner */ outer */ ("clear")',
    'Selector // gap\n ( /* gap */ ("clear"))', 'let url = "https://example.invalid"; Selector /* gap */ ("clear")',
    'let value = "\\(Selector /* gap */ ("clear"))"', '// Selector("clear")']) {
    assert.throws(() => validateMacDriverClipboardSource(source + '\n' + code), /DRIVER_CLIPBOARD_CAPABILITY/, code);
    assert.throws(() => validateMacDriverClipboardSource(code, otherPath), /DRIVER_CLIPBOARD_CAPABILITY/, code);
  }
});

for (const [name, code] of [
  ['variable', 'Selector(existingName)'],
  ['expression', 'perform(Selector(makeName()))'],
  ['parentheses', 'Selector((existingName))'],
  ['backtick', '`Selector` /* gap */ (existingName)'],
  ['comments', 'Selector /* outer /* inner */ end */ (existingName)'],
  ['newline', 'Selector // gap\n (existingName)'],
  ['function value', 'let makeSelector = Selector'],
]) test(`CB1K dynamic selector refuses ${name}`, () => {
  assert.throws(() => validateMacDriverClipboardSource(macDriverSource() + '\n' + code), /DRIVER_CLIPBOARD_CAPABILITY/);
  assert.throws(() => validateMacDriverClipboardSource(code, otherPath), /DRIVER_CLIPBOARD_CAPABILITY/);
});

test('reviewed count path ignores a forged Source marker', async t => {
  const watch = await readFile(new URL('DriverClipboardWatch.swift', nativeURL), 'utf8');
  assert.doesNotThrow(() => validateMacDriverClipboardSource(watch, watchPath));
  assert.throws(() => validateMacDriverClipboardSource('// Source: DriverClipboardWatch.swift\n' + watch, otherPath),
    /DRIVER_CLIPBOARD_CAPABILITY/);
  assert.throws(() => validateMacDriverClipboardSource(watch, '/fixture/DriverClipboardWatch.swift'), /DRIVER_CLIPBOARD_CAPABILITY/);
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-scan-marker-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of await readdir(nativeURL)) {
    if (!file.endsWith('.swift')) continue;
    const source = await readFile(new URL(file, nativeURL), 'utf8');
    await writeFile(join(root, file), file === 'DriverClipboardWatch.swift'
      ? source.replace('NSPasteboard.general.changeCount', '0') : source);
  }
  await writeFile(join(root, 'DriverAInjected.swift'),
    '// Source: DriverClipboardWatch.swift\n        return try NSPasteboard.general.changeCount\n');
  const builder = await copyBuild(t, text => text.replace(
    "const sourceRoot = fileURLToPath(new URL('./native/', import.meta.url));",
    `const sourceRoot = ${JSON.stringify(root)};`));
  assert.throws(() => builder.macDriverSource(), /DRIVER_CLIPBOARD_CAPABILITY/);
});

test('a second exact changeCount site fails even without the board token rule', async t => {
  const module = await copyBuild(t, text => text.replace('(?:NSPasteboard|', '(?:'));
  const watch = await readFile(new URL('DriverClipboardWatch.swift', nativeURL), 'utf8');
  assert.throws(() => module.validateMacDriverClipboardSource(watch + '\nNSPasteboard.general.changeCount', watchPath),
    /DRIVER_CLIPBOARD_CAPABILITY/);
});

test('reviewed dynamic sites cannot be copied or repeated', async () => {
  for (const file of ['DriverTools.swift', 'DriverPointer.swift']) {
    const path = new URL(file, nativeURL).pathname;
    const source = await readFile(path, 'utf8');
    assert.doesNotThrow(() => validateMacDriverClipboardSource(source, path));
    assert.throws(() => validateMacDriverClipboardSource(source, otherPath), /DRIVER_CLIPBOARD_CAPABILITY/);
    const line = source.split('\n').find(line => /\b(?:dlopen|dlsym)\b/.test(line));
    assert.throws(() => validateMacDriverClipboardSource(source + '\n' + line, path), /DRIVER_CLIPBOARD_CAPABILITY/);
    const changed = line.replace(/CGSMainConnectionID|CGEventSetWindowLocation/, 'OtherSymbol');
    assert.notEqual(changed, line);
    assert.throws(() => validateMacDriverClipboardSource(source.replace(line, changed), path),
      /DRIVER_CLIPBOARD_CAPABILITY/);
  }
});

test('peer C is scanned before cache probes or compilation', async t => {
  const peer = await readFile(new URL('../plugins/sleight/lib/direct-browser/native/peer-host.c', import.meta.url), 'utf8');
  let calls = 0;
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-scan-peer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'peer-host.c');
  const builder = await copyBuild(t, text => text.replace(
    "const peerSource = fileURLToPath(new URL('../direct-browser/native/peer-host.c', import.meta.url));",
    `const peerSource = ${JSON.stringify(fixture)};`));
  for (const code of [...runtimeIdentifiers.map(name => `void *f = ${name};`),
    'void *f = dlopen /* gap */ (0, 0);', '/* Source: DriverClipboardWatch.swift */\nNSPasteboard.general.changeCount']) {
    await writeFile(fixture, peer + '\n' + code);
    await assert.rejects(builder.prepareMacDriver({ platform: 'darwin', cached: () => { calls++; return false; },
      tools: async () => { calls++; return false; }, prepare: async () => { calls++; throw Error('compiler called'); } }),
    /DRIVER_CLIPBOARD_CAPABILITY/, code);
  }
  assert.equal(calls, 0);
});

for (const [name, code] of [
  ['token pasting', '#define CAT(a,b) a##b\nvoid *f = CAT(dl,sym)(0,"x");'],
  ['LF splice', 'void *f = dl' + '\\' + '\nsym(0,"x");'],
  ['CRLF splice', 'void *f = dl' + '\\' + '\r\nsym(0,"x");'],
  ['spaced splice', 'void *f = dl' + '\\' + ' \nsym(0,"x");'],
]) test(`CB1K peer C refuses ${name} before preparation`, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-scan-peer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'peer-host.c');
  await writeFile(fixture, code);
  const builder = await copyBuild(t, text => text.replace(
    "const peerSource = fileURLToPath(new URL('../direct-browser/native/peer-host.c', import.meta.url));",
    `const peerSource = ${JSON.stringify(fixture)};`));
  let calls = 0;
  await assert.rejects(builder.prepareMacDriver({ platform: 'darwin', cached: () => { calls++; return false; },
    tools: async () => { calls++; return false; }, prepare: async () => { calls++; throw Error('compiler called'); } }),
  /DRIVER_CLIPBOARD_CAPABILITY/);
  assert.equal(calls, 0);
  assert.throws(() => validateMacDriverClipboardSource(code, '/fixture/peer-host.c'), /DRIVER_CLIPBOARD_CAPABILITY/);
});

test('CB1L current peer C passes its content pin and reaches the cache probe', async () => {
  const peer = await readFile(peerURL, 'utf8');
  assert.doesNotThrow(() => validateMacDriverClipboardSource(peer, peerURL.pathname));
  let probes = 0, compiles = 0;
  const result = await prepareMacDriver({ platform: 'darwin', cached: () => { probes++; return false; },
    tools: async () => false, prepare: async () => { compiles++; } });
  assert.equal(result.code, 'APPLE_TOOLS_MISSING');
  assert.equal(probes, 1);
  assert.equal(compiles, 0);
});

for (const [name, transform] of [
  ['one changed byte', peer => peer.replace('include', 'Include')],
  ['added comment', peer => peer + '\n/* reviewed? */\n'],
  ['digraph token pasting', peer => peer + '\n#define CAT(a,b) a%:%:b\n'],
  ['form feed splice', peer => peer + '\nint na' + '\\' + '\f\nme;\n'],
  ['vertical tab splice', peer => peer + '\nint na' + '\\' + '\v\nme;\n'],
]) test(`CB1L peer content pin refuses ${name} before cache probes`, async t => {
  const peer = await readFile(peerURL, 'utf8'), changed = transform(peer);
  assert.notEqual(changed, peer);
  if (name === 'one changed byte') {
    assert.equal(changed.length, peer.length);
    assert.equal([...peer].filter((byte, index) => byte !== changed[index]).length, 1);
  }
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-scan-pin-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'peer-host.c');
  await writeFile(fixture, changed);
  const builder = await copyBuild(t, text => text.replace(
    "const peerSource = fileURLToPath(new URL('../direct-browser/native/peer-host.c', import.meta.url));",
    `const peerSource = ${JSON.stringify(fixture)};`));
  let calls = 0;
  await assert.rejects(builder.prepareMacDriver({ platform: 'darwin', cached: () => { calls++; return false; },
    tools: async () => { calls++; return false; }, prepare: async () => { calls++; throw Error('compiler called'); } }),
  /DRIVER_CLIPBOARD_CAPABILITY/);
  assert.equal(calls, 0);
  assert.throws(() => validateMacDriverClipboardSource(changed, peerURL.pathname), /DRIVER_CLIPBOARD_CAPABILITY/);
});


import { prepareNativeHelpers } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { helperBuildKey, helperBuildRecipes } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { runtimeBuildState } from '../plugins/sleight/lib/runtime-doctor.mjs';
import { ownHostPid } from '../plugins/sleight/lib/own-host.mjs';

test('GL1A 6: stale source names get a new bank and exact binary names reject supersets', { skip: process.platform !== 'darwin' }, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-glide-upgrade-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = macDriverSource(), peer = await readFile(peerURL);
  const oldHashes = { 'peer-host.c': digest(peer), 'consent-host.swift': digest(source) };
  const oldBank = join(root, helperBuildKey(oldHashes));
  await mkdir(oldBank, { mode: 0o700 });
  for (const name of ['consent-host', 'peer-host']) await writeFile(join(oldBank, name), name, { mode: 0o700 });
  await writeFile(join(oldBank, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: oldHashes,
    binaries: { 'consent-host': digest('consent-host'), 'peer-host': digest('peer-host') } }), { mode: 0o600 });
  assert.equal(runtimeBuildState({ cacheRoot: root }).status, 'not compiled for this source');
  assert.equal(ownHostPid(500, () => '/fixture/Library/Caches/sleight/turbo-host/mac-driver/k0/consent-host'), true);
  let compiles = [], progress = [];
  const prepare = (options, selectedSources) => prepareNativeHelpers({ ...options,
    compile: async ({ name, binary }) => { compiles.push(name); await writeFile(binary, 'compiled ' + name, { mode: 0o700 }); } }, selectedSources);
  const built = await prepareMacDriver({ cacheRoot: root, prepare, tools: async () => true, onProgress: row => progress.push(row) });
  assert.equal(built.status, 'ready');
  assert.notEqual(built.binary, join(oldBank, 'consent-host'));
  assert.match(built.binary, /\/glide-engine$/);
  assert.deepEqual(compiles.sort(), ['glide-engine', 'peer-host']);
  assert.equal(progress.some(row => row.helper === 'glide-engine'), true);
  const directory = built.binary.slice(0, built.binary.lastIndexOf('/'));
  const path = join(directory, 'build.json'), record = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(record.binaries).sort(), ['glide-engine', 'peer-host']);
  delete record.recipes; await writeFile(path, JSON.stringify(record)); compiles = [];
  const recipeRebuild = await prepareMacDriver({ cacheRoot: root, prepare, tools: async () => true });
  assert.equal(recipeRebuild.status, 'ready'); assert.deepEqual(compiles.sort(), ['glide-engine', 'peer-host']);
  record.recipes = helperBuildRecipes(record.sources);

  await writeFile(join(directory, 'consent-host'), 'stale', { mode: 0o700 });
  record.binaries['consent-host'] = digest('stale');
  await writeFile(path, JSON.stringify(record)); compiles = [];
  const rebuilt = await prepareMacDriver({ cacheRoot: root, prepare, tools: async () => true });
  assert.equal(rebuilt.status, 'ready');
  assert.deepEqual(compiles.sort(), ['glide-engine', 'peer-host'], 'a superset record must recompile');
});


test('GL1A 4: a linked driver binary cannot receive a launch receipt', async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-glide-linked-build-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'target'); await writeFile(target, 'driver', { mode: 0o700 });
  await assert.rejects(prepareMacDriver({ platform: 'darwin', cacheRoot: root, tools: async () => true,
    prepare: async options => {
      const directory = join(root, 'bank'); await mkdir(directory, { mode: 0o700 });
      await symlink(target, join(directory, 'glide-engine'));
      const sources = Object.fromEntries(options.inventory.files.map(file => [file.path.split('/').at(-1), file.sha256]));
      const record = join(directory, 'build.json');
      await writeFile(record, JSON.stringify({ protocol: 1, arch: process.arch, sources, recipes: helperBuildRecipes(sources),
        binaries: { 'glide-engine': digest('driver') } }), { mode: 0o600 });
      return { status: 'ready', directory, record };
    } }), /HOST_PACKAGE_MISMATCH/);
});


for (const recipes of [undefined, {}]) test('CP1A2 Glide launch refuses missing or tampered recipe: ' + JSON.stringify(recipes), async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-glide-recipe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareMacDriver({ platform: 'darwin', cacheRoot: root, tools: async () => true, prebuilt: () => undefined,
    prepare: async options => {
      const sources = Object.fromEntries(options.inventory.files.map(file => [file.path.split('/').at(-1), file.sha256]));
      const directory = join(root, 'bank'); await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'glide-engine'), 'driver', { mode: 0o700 });
      const record = join(directory, 'build.json');
      await writeFile(record, JSON.stringify({ protocol: 1, arch: process.arch, sources, recipes,
        binaries: { 'glide-engine': digest('driver') } }), { mode: 0o600 });
      return { status: 'ready', directory, record };
    } }), /HOST_PACKAGE_MISMATCH/);
});

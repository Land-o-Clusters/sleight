import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchBlockedWindowsApp } from '../plugins/sleight/lib/blocked-apps-windows.mjs';
import * as resources from '../bench/windows/version-resource.mjs';
import * as stubs from '../bench/windows/browser-stub.mjs';
import { fixtureTargets, collectorPlan, proveFixtureLaunch, GUEST_OPERATIONS } from '../bench/windows/uc3f-collect.mjs';

const edge = {
  originalFilename: 'msedge.exe', productName: 'Microsoft Edge',
  companyName: 'Microsoft Corporation', fileDescription: 'Microsoft\u00ae Edge',
};
const identity = { processStart: '100', pid: 40, integrity: 'medium', imageIdentity: '100:200', refused: null };
const metadataWindow = {
  ...identity, windowId: '77',
  image: 'C:\\sleight-setup\\uc3f-0123456789abcdef\\uc3f-metadata-stub.exe',
  originalFilename: edge.originalFilename, productName: edge.productName,
  title: stubs.STUB_TITLE, className: stubs.STUB_CLASS,
};
const neutralWindow = {
  ...identity, windowId: '78',
  image: 'C:\\sleight-setup\\uc3f-0123456789abcdef\\uc3f-neutral-stub.exe',
  originalFilename: stubs.NEUTRAL_VERSION.originalFilename, productName: stubs.NEUTRAL_VERSION.productName,
  title: stubs.STUB_TITLE, className: stubs.STUB_CLASS,
};
function inventory(windows) {
  return { async request(method) {
    if (method !== 'getState') throw Object.assign(Error('UNEXPECTED'), { code: 'UNEXPECTED' });
    return { windows };
  } };
}
const launched = { metadataWindow, neutralWindow, source: edge, launched: true, driver: inventory([metadataWindow, neutralWindow]) };
const collectUrl = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
const resourceUrl = new URL('../bench/windows/version-resource.mjs', import.meta.url);
const stubUrl = new URL('../bench/windows/browser-stub.mjs', import.meta.url);

function load(url, source) {
  const text = source.replace(/from (['"])(\.[^'"]+)\1/g,
    (_match, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
}

test('version resource round-trips the four copied fields and rejects a writer that drops one', async () => {
  const bytes = resources.versionResource(edge);
  assert.deepEqual(resources.readVersionStrings(bytes), edge);
  const wide = bytes.toString('utf16le');
  assert.ok(wide.includes('FileVersion') && wide.includes('ProductVersion') && wide.includes('040904b0'));
  assert.ok(bytes.readUInt32LE(4) === 0x20);
  const neutral = resources.readVersionStrings(resources.versionResource(stubs.NEUTRAL_VERSION));
  assert.deepEqual(neutral, stubs.NEUTRAL_VERSION);
  assert.equal(matchBlockedWindowsApp({ originalFilename: neutral.originalFilename, productName: neutral.productName }), undefined);
  assert.equal(matchBlockedWindowsApp({ originalFilename: edge.originalFilename }).browser, true);
  assert.equal(matchBlockedWindowsApp({ productName: edge.productName }).browser, true);
  const source = readFileSync(resourceUrl, 'utf8');
  const broken = await load(resourceUrl, source.replace('FIELD_ORDER.map', "FIELD_ORDER.filter(key => key !== 'originalFilename').map"));
  assert.throws(() => broken.assertVersionCopied(edge, broken.readVersionStrings(broken.versionResource(edge))), { code: 'VERSION_RESOURCE_INVALID' });
  const noVersion = await load(resourceUrl, source.replace("stringEntry('FileVersion', '1.0.0.0'),\n    stringEntry('ProductVersion', '1.0.0.0'),\n  ", ''));
  const omitted = noVersion.versionResource(edge).toString('utf16le');
  assert.throws(() => { assert.ok(omitted.includes('FileVersion') && omitted.includes('ProductVersion')); }, assert.AssertionError);
});

test('renamed stub passes only when the product refuses the metadata window', async () => {
  const verdict = await stubs.qualifyRenamedStubs(launched);
  assert.equal(verdict.metadata.code, 'BROWSER_TARGET_REFUSED');
  assert.equal(verdict.product.metadata, 'BROWSER_TARGET_REFUSED');
  assert.equal(verdict.product.neutral, 'APP_DECLINED');
  assert.deepEqual(verdict.metadata.matchedFields, ['originalFilename', 'productName']);
  assert.deepEqual(verdict.neutral, { code: 'OK', browser: false });
  const bareWindow = { ...neutralWindow, windowId: '77', image: metadataWindow.image };
  const bare = { metadataWindow: bareWindow, neutralWindow, source: stubs.NEUTRAL_VERSION, launched: true,
    driver: inventory([bareWindow, neutralWindow]) };
  await assert.rejects(stubs.qualifyRenamedStubs(bare), { code: 'BROWSER_REFUSAL_UNPROVED' });
  await assert.rejects(stubs.qualifyRenamedStubs({ ...launched, launched: false }), { code: 'FIXTURE_LAUNCH_UNPROVED' });
  await assert.rejects(stubs.qualifyRenamedStubs({ ...launched, driver: undefined }), { code: 'PRODUCT_REFUSAL_REQUIRED' });
  const missingNeutral = { ...launched, driver: inventory([metadataWindow]) };
  await assert.rejects(stubs.qualifyRenamedStubs(missingNeutral), { code: 'NEUTRAL_STUB_UNPROVED' });
  const loose = await load(stubUrl, readFileSync(stubUrl, 'utf8').replace(
    "if (neutralRefusal.code !== 'APP_DECLINED' || !neutralRefusal.methods.includes('getState')) fail('NEUTRAL_STUB_UNPROVED');",
    "if (neutralRefusal.code === 'BROWSER_TARGET_REFUSED') fail('NEUTRAL_STUB_REFUSED');",
  ));
  const tolerated = await loose.qualifyRenamedStubs(missingNeutral);
  assert.throws(() => { assert.equal(tolerated.product.neutral, 'APP_DECLINED'); }, assert.AssertionError);
});

test('a basename-only check and a launch-only pass both fail the renamed job', async () => {
  const source = readFileSync(stubUrl, 'utf8');
  const basenameOnly = await load(stubUrl, source.replace(
    'return browserFields.filter(field => {',
    "return ['image'].filter(field => {",
  ));
  await assert.rejects(basenameOnly.qualifyRenamedStubs(launched), { code: 'BROWSER_REFUSAL_UNPROVED' });
  const launchOnly = await load(stubUrl, source.replace(
    `const metadataRefusal = await productBrowserRefusal(metadataWindow, driver);
  if (metadataRefusal.code !== 'BROWSER_TARGET_REFUSED' || !metadataRefusal.methods.includes('getState')) fail('BROWSER_REFUSAL_UNPROVED');
  const neutralRefusal = await productBrowserRefusal(neutralWindow, driver);
  if (neutralRefusal.code !== 'APP_DECLINED' || !neutralRefusal.methods.includes('getState')) fail('NEUTRAL_STUB_UNPROVED');
  return {
    metadata: qualifyMetadataStub(metadataWindow, source),
    neutral: qualifyNeutralStub(neutralWindow),
    product: { metadata: metadataRefusal.code, neutral: neutralRefusal.code },
  };`,
    "return { metadata: { code: 'OK', matchedFields: [] }, neutral: { code: 'OK', browser: false }, product: { metadata: 'ADMITTED', neutral: 'ADMITTED' } };",
  ));
  const broken = await launchOnly.qualifyRenamedStubs(launched);
  assert.throws(() => {
    assert.equal(broken.metadata.code, 'BROWSER_TARGET_REFUSED');
    assert.ok(broken.metadata.matchedFields.includes('originalFilename'));
  }, assert.AssertionError);
  const direct = await load(stubUrl, source.replace(
    "await safety.request('getApp', { selector: { windowId: window.windowId } });",
    "throw Object.assign(Error(forbiddenWindowsTarget(window)?.code || 'ADMITTED'), { code: forbiddenWindowsTarget(window)?.code || 'ADMITTED' });",
  ));
  await assert.rejects(direct.qualifyRenamedStubs(launched), { code: 'BROWSER_REFUSAL_UNPROVED' });
});

test('the renamed job builds both stubs and records the measured product refusal', () => {
  const row = collectorPlan(['browser-refused-renamed'])[0];
  assert.deepEqual(fixtureTargets(row), ['metadata-stub', 'neutral-stub']);
  const source = readFileSync(collectUrl, 'utf8') + readFileSync(new URL('../bench/windows/uc3f-fixtures.mjs', import.meta.url), 'utf8');
  const selftestSource = readFileSync(new URL('../bench/windows/uc3f-selftest.mjs', import.meta.url), 'utf8');
  const audit = text => {
    assert.ok(text.includes('qualifyRenamedStubs({ metadataWindow, neutralWindow, source: edgeMetadata, launched: true, driver: await client() })'));
    assert.ok(text.includes('product: verdict.product'));
    assert.ok(text.includes('browserRefusal: verdict.product.metadata'));
    assert.ok(selftestSource.includes("value?.browserRefusal === 'BROWSER_TARGET_REFUSED'"));
    assert.ok(text.indexOf('qualifyRenamedStubs(') > text.indexOf("psCall('launch'"));
    assert.ok(text.includes("Add-Type -TypeDefinition $source -CompilerParameters $compiler"));
    assert.ok(text.includes("Join-Path $r.bank 'stub-compile-error.txt'"));
    assert.ok(text.includes(stubs.STUB_TITLE) && text.includes(stubs.STUB_CLASS));
    assert.equal((text.match(/Add-Type -TypeDefinition/g) ?? []).length >= 2, true);
  };
  audit(source);
  assert.throws(() => audit(source.replace('qualifyRenamedStubs(', 'launchOnly(')), assert.AssertionError);
  assert.throws(() => audit(source.replace('driver: await client()', 'driver: null')), assert.AssertionError);
  assert.throws(() => audit(source.replace('product: verdict.product', 'product: null')), assert.AssertionError);
  assert.throws(() => audit(source.replace('browserRefusal: verdict.product.metadata', 'browserRefusal: null')), assert.AssertionError);
  assert.ok(GUEST_OPERATIONS.includes("'compile-stub'") && GUEST_OPERATIONS.includes("'edge-metadata'"));
  assert.doesNotMatch(stubs.STUB_SOURCE, /SendInput|keybd_event|mouse_event|SetCursorPos/);
  assert.equal(stubs.STUB_SOURCE.split(stubs.STUB_TITLE).length, 2);
});

test('stub launch proof requires the fixed title and class on the direct process', () => {
  const token = 'uc3f-0123456789abcdef';
  const proof = target => ({
    launcher: { pid: 40, processStart: '100', image: `C:\\bank\\${target}.exe`, observedEnd: '120' },
    expectedImage: `C:\\bank\\${target}.exe`,
    windows: [{ pid: 40, processStart: '100', image: `C:\\bank\\${target}.exe`, windowId: '77',
      title: stubs.STUB_TITLE, className: stubs.STUB_CLASS }],
  });
  assert.equal(proveFixtureLaunch(proof('uc3f-metadata-stub'), { target: 'metadata-stub', token }).windowId, '77');
  const wrong = proof('uc3f-neutral-stub');
  wrong.windows[0].title = 'Microsoft Edge';
  assert.throws(() => proveFixtureLaunch(wrong, { target: 'neutral-stub', token }), { code: 'FIXTURE_LAUNCH_UNPROVED' });
});

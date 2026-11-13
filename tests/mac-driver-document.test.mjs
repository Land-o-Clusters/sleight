import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { recordedFixture } from './fixtures/mac-driver-recorded-tree.mjs';
import { structuralKey } from '../plugins/sleight/lib/compact-reads.mjs';
import { documentReadText } from '../plugins/sleight/lib/repl/document-read.mjs';
import { compareMacElement, createMacReadState, classifyConsequentialLabel } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { enginePayment } from '../plugins/sleight/lib/payment-gate.mjs';
import { differentFocusTarget, isPaymentTarget, elementLines } from '../plugins/sleight/lib/document-scope.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const nonce = 'd'.repeat(64);
const frame = { x: 0, y: 0, width: 800, height: 600 };
const node = (role, rest = {}) => ({ AXRole: role, frame, ...rest });
const binding = { windowId: '7', processStart: '1.2' };
const marker = 'DT1_PRIVATE_DOCUMENT_759b';
const fixture = (app, children) => ({ apps: [{ id: 'test.recorded', name: app, pid: 42, processStart: '1.2' }],
  windows: [{ ...binding, pid: 42, bundleId: 'test.recorded', identityVerified: true, app, title: 'Recorded document', bounds: frame }],
  trees: { '7': node('AXWindow', { AXTitle: 'Recorded document', children }) } });

// Recorded role shapes, with attributed data supplied by the fake AX provider.
// Engine recordings do not contain attributed strings. These are format probes,
// not evidence that a particular app exposes these attributes in the background.
const textedit = fixture('TextEdit', [node('AXTextArea', {
  AXValue: marker + '\nBody paragraph\nLast line', AXSelectedTextRange: { location: marker.length + 1, length: 4 },
  attributed: { string: marker + '\nBody paragraph\nLast line', runs: [
    { location: 0, length: marker.length, attributes: { AXHeadingLevel: 1, AXFont: { AXFontName: 'Helvetica-Bold' } } },
  ] },
})]);
const word = fixture('Microsoft Word', [node('AXLayoutArea', { children: [node('AXTextArea', {
  AXDescription: 'Page 1 content', AXValue: 'Memo\nCopper shipped\nA\tB\tC\nD\tE\tF',
  AXSelectedTextRange: { location: 13, length: 0 },
  attributed: { string: 'Memo\nCopper shipped\nA\tB\tC\nD\tE\tF', runs: [
    { location: 0, length: 4, attributes: { AXHeadingLevel: 1 } },
  ] },
}), node('AXTable', { AXRowCount: 2, AXColumnCount: 3 })] })]);
const safari = fixture('Safari', [node('AXWebArea', { children: [
  node('AXHeading', { AXTitle: 'Shipping', AXHeadingLevel: 2 }),
  node('AXStaticText', { AXValue: 'The copper order shipped on time.' }),
  node('AXTable', { AXRowCount: 2, AXColumnCount: 3 }),
] })]);

test('native structured reads preserve rti1 trees and keep additional structure transient',
  { skip: process.platform !== 'darwin', timeout: 600000 }, async t => {
    const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-document-test-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'driver.swift'), binary = join(root, 'driver');
    const additions = `
      runtime.register(method: "fixtureRti1Tree") { request, core in
        try core.readRti1Tree(request.params, request: request)
      }
      runtime.register(method: "fixtureMap") { _, core in
        ["maps": core.maps.values.map { map in ["text": map.text ?? "", "labels": map.elements.values.map { $0.label }] }]
      }
      runtime.register(method: "fixtureDocumentReadCounts") { _, _ in dt1DocumentReadCounts }
      runtime.register(method: "fixtureDocumentRead") { request, core in
        try core.readDocumentTree(request.params, request: request, backend: DT1Capture())
      }
      runtime.register(method: "fixtureDocumentResolve") { request, core in
        let element = try core.resolveElement(request.params, request: request)
        return ["label": element.label, "identifier": element.identifier]
      }
      runtime.register(method: "fixtureAttributedModel") { _, _ in
        let heading = NSMutableParagraphStyle(); heading.headerLevel = 1
        let value = NSMutableAttributedString(string: "Memo\\nA\\nB\\nC\\nD\\nE\\nF")
        value.addAttribute(.paragraphStyle, value: heading, range: NSRange(location: 0, length: 4))
        let table = NSTextTable(); table.numberOfColumns = 3
        for index in 0..<6 {
          let style = NSMutableParagraphStyle()
          style.textBlocks = [NSTextTableBlock(table: table, startingRow: index / 3, rowSpan: 1, startingColumn: index % 3, columnSpan: 1)]
          value.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 5 + index * 2, length: 1))
        }
        let centered = NSMutableParagraphStyle(); centered.alignment = .center
        let styled = NSAttributedString(string: "Centered paragraph", attributes: [.paragraphStyle: centered])
        return ["formatted": DriverDocumentRead.paragraphs(value).joined(separator: "\\n"),
          "centered": DriverDocumentRead.paragraphs(styled).joined(separator: "\\n"),
          "centeredAddsStructure": DriverDocumentRead.hasStyles(styled, heading: 0),
          "plainAddsStructure": DriverDocumentRead.hasStyles(NSAttributedString(string: "Plain"), heading: 0)]
      }
    `;
    const backend = `
      final class DT1Capture: DriverCaptureBackend {
        func preflight() -> Bool { true }
        func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
          let context = CGContext(data: nil, width: 800, height: 600, bitsPerComponent: 8, bytesPerRow: 3200,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
          return DriverCapturedImage(image: context.makeImage()!, target: target)
        }
      }
    `;
    const oracle = await readFile(new URL('./fixtures/rti1-document-tree.swift', import.meta.url), 'utf8');
    const attributeSignature = 'func attributes(_ names: [String], request: DriverRequest, strict: Bool = false) throws -> DriverObject {';
    const productionSource = macDriverSource();
    assert.equal(productionSource.split(attributeSignature).length, 2, 'document read counter injection must match exactly once');
    const countedSource = productionSource.replace('final class DriverNode {', 'var dt1DocumentReadCounts = [String: Int]()\nfinal class DriverNode {')
      .replace(attributeSignature, attributeSignature + '\nfor name in names { dt1DocumentReadCounts[name, default: 0] += 1 }');
    await writeFile(source, countedSource.replace('func driverMain() {', oracle + '\nfunc driverMain() {').replace('func driverMain() {', backend + '\nfunc driverMain() {')
      .replace('DispatchQueue.global().async { runtime.serve() }', additions + '\nDispatchQueue.global().async { runtime.serve() }'));
    const compiling = promisify(execFile)('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-Xfrontend', '-warn-long-expression-type-checking=2000', '-Xfrontend', '-warn-long-function-bodies=10000', '-D', 'SLEIGHT_DRIVER_FIXTURES',
      '-module-cache-path', join(root, 'modules'), source, '-o', binary],
    { maxBuffer: 2 * 1024 * 1024, timeout: 540000 });
    let compileLog = '';
    compiling.child.stderr.on('data', bytes => { compileLog += bytes; });
    try { await compiling; }
    finally { await writeFile(join(root, 'compile.log'), compileLog); }
    t.diagnostic(`fixture binary ${(await stat(binary)).size} bytes`);
    let serial = 0;
    const run = async (data, calls = [['getAXState', binding], ['fixtureMap', {}]]) => {
      const input = join(root, `fixture-${++serial}.json`); await writeFile(input, JSON.stringify(data));
      return await new Promise((resolve, reject) => {
        const child = spawn(binary, ['--fixture', input], { env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', events = '';
        child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
        child.stdio[3].on('data', b => { events += b; }); child.once('error', reject);
        child.once('close', code => resolve({ code, stderr, events, rows: stdout.trim().split('\n').filter(Boolean).map(JSON.parse) }));
        child.stdin.end(calls.map(([method, params], i) => JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
          id: i + 1, method, params, deadline: Date.now() + 10000 }) + '\n').join(''));
      });
    };
    const document = read => read.document.sections.map(section => section.text).join('\n');
    await t.test('DT1E the 4000-unit budget stops text metadata AX reads on all later nodes', async () => {
      for (const tail of [1, 24]) {
        const data = fixture('Safari', [node('AXWebArea', { children: [
          node('AXStaticText', { AXValue: 'x'.repeat(4000) }),
          ...Array.from({ length: tail }, () => node('AXStaticText', { AXValue: 'late' })),
        ] })]);
        const result = await run(data, [['getAXState', binding], ['fixtureDocumentReadCounts', {}]]);
        assert.equal(result.rows[0].ok, true);
        const counts = result.rows[1].result;
        for (const name of ['AXNumberOfCharacters', 'AXSelectedTextRange', 'AXHeadingLevel', 'AXAttributedStringForRange'])
          assert.equal(counts[name], 2, `${name}: root plus the node that fills the budget, tail=${tail}`);
      }
    });
    await t.test('Cocoa paragraph and text-table attributes produce headings and a 2x3 table without a window', async () => {
      const result = await run(textedit, [['fixtureAttributedModel', {}]]);
      assert.equal(result.rows[0].ok, true); assert.match(result.rows[0].result.formatted, /^para offset 0 length 4 H1/);
      assert.match(result.rows[0].result.formatted, /table 2x3/);
      assert.equal(result.rows[0].result.centered, 'para offset 0 length 18 P align center');
      assert.doesNotMatch(result.rows[0].result.formatted, /"Memo"|"[A-F]"/);
      assert.equal(result.rows[0].result.centeredAddsStructure, true);
      assert.equal(result.rows[0].result.plainAddsStructure, false);
    });
    await t.test('named paragraph styles retain their range without copying any paragraph text', async () => {
      const text = 'Plain\nStyled\nTail';
      const result = await run(fixture('TextEdit', [node('AXTextArea', { AXValue: text,
        AXSelectedTextRange: { location: 7, length: 3 }, attributed: { string: text,
          runs: [{ location: 6, length: 6, attributes: { AXParagraphStyle: 'Quote' } }] },
      })]));
      const out = document(result.rows[0].result);
      assert.match(out, /element 1 para offset 6 length 6 P style "Quote"/);
      assert.match(out, /element 1 cursor offset 7\nelement 1 selection offset 7 length 3/);
      assert.doesNotMatch(out, /Plain|Styled|Tail/);
    });
    for (const [name, data, patterns] of [
      ['TextEdit RTF shape', textedit, [/element 1 para offset 0 length 25 H1/, /selection offset 26 length 4/, /cursor offset 26/]],
      ['Word docx pane shape', word, [/element 2 para offset 0 length 4 H1/, /element 3 table 2x3/, /cursor offset 13/]],
      ['Safari page shape', safari, [/element 2 heading H2/, /element 4 table 2x3/]],
    ]) await t.test(name, async () => {
      const result = await run(data); assert.equal(result.code, 0, result.stderr);
      assert.equal(result.rows[0].ok, true, JSON.stringify(result.rows[0]));
      for (const pattern of patterns) assert.match(document(result.rows[0].result), pattern);
      assert.doesNotMatch(document(result.rows[0].result), /DT1_PRIVATE_DOCUMENT_759b|Body paragraph|Last line|"Memo"|Copper shipped|Shipping|The copper order/);
      assert.equal(result.rows[0].result.document.needsPixels, false);
      const parity = await run(data, [['getAXState', binding], ['fixtureRti1Tree', binding]]);
      assert.equal(parity.rows[0].result.text, parity.rows[1].result.text, 'rti1 tree is byte-identical');
      const block = documentReadText(result.rows[0].result);
      t.diagnostic(`${name}: tree ${Buffer.byteLength(parity.rows[1].result.text)} bytes, added block ${Buffer.byteLength(block)} bytes, content item ${Buffer.byteLength(JSON.stringify({ type: 'text', text: block }))} JSON bytes`);
      assert.doesNotMatch(result.stderr + result.events, /DT1_PRIVATE_DOCUMENT_759b/);
    });
    for (const [app, rootRole] of [['Safari', 'AXWebArea'], ['Electron', 'AXTextArea'], ['Microsoft Excel', 'AXLayoutArea'], ['Document', 'AXDocument']]) {
      await t.test(`${app} document descendants retain control labels and actions`, async () => {
        const controls = [node('AXButton', { AXTitle: 'Save', AXDescription: 'Save draft', AXIdentifier: 'save',
          AXURL: 'https://example.test/save', AXHelp: 'Write file', actions: ['AXPress', 'AXShowMenu'] }),
        node('AXTextField', { AXTitle: 'Email', AXDescription: 'Reply address', AXIdentifier: 'email',
          AXPlaceholderValue: 'name@example.test', AXValue: marker, settable: true }),
        node('AXLink', { AXTitle: 'Help', AXURL: 'https://example.test/help' })];
        const data = fixture(app, [node(rootRole, { AXTitle: 'Editor', children: [node('AXGroup', { children: controls })] })]);
        const result = await run(data), read = result.rows[0].result;
        assert.equal(result.rows[0].ok, true);
        assert.match(read.text, /1 (?:web area|text entry area|layout area|container) Editor/);
        assert.match(read.text, /button Save, Description: Save draft, Help: Write file, ID: save, URL: https:\/\/example.test\/save, Secondary Actions: Show Menu/);
        assert.match(read.text, /text field \(settable\) Email, Description: Reply address, Value: DT1_PRIVATE_DOCUMENT_759b, Placeholder: name@example.test, ID: email/);
        assert.match(read.text, /link Help, URL: https:\/\/example.test\/help/);
        assert.equal(JSON.stringify(result.rows[1]).includes(marker), true, 'rti1 field values remain canonical');
        assert.equal(read.document.sections.length, 0, 'plain field values add no structure');
        assert.equal(read.document.needsPixels, false);
        const resolved = await run(data, [['getAXState', binding], ['fixtureDocumentResolve', { ...binding, readId: 1, target: { label: 'Save' } }]]);
        assert.deepEqual(resolved.rows[1].result, { label: 'Save', identifier: 'save' });
      });
    }
    for (const name of ['word-table-size', 'notes-popup-subtree']) await t.test(`recorded compound labels survive: ${name}`, async () => {
      const recorded = JSON.parse(await readFile(new URL(`./fixtures/rt11d-${name}.json`, import.meta.url), 'utf8'));
      const data = recordedFixture(recorded.delivered), result = await run(data);
      const oracle = await run(data, [['fixtureRti1Tree', binding]]);
      // GL9/GL9B deliberately retain role and disabled state on menu-bar items.
      // GLS2B also marks these eight populated content menus expanded.
      // Keep the frozen rti1 oracle and compare every other byte unchanged.
      const disabledItems = name === 'notes-popup-subtree' ? [7, 8, 45, 53, 54, 55, 56, 57, 58, 59, 60] : [];
      const expandedMenus = name === 'notes-popup-subtree' ? [3, 10, 18, 23, 30, 43, 47, 52] : [];
      let expectedTree = oracle.rows[0].result.text;
      for (const number of disabledItems)
        expectedTree = expectedTree.replace(new RegExp(`^(\\t*${number} )`, 'm'), '$1menu bar item (disabled) ');
      for (const number of expandedMenus)
        expectedTree = expectedTree.replace(new RegExp(`^(\\t*${number} menu) `, 'm'), '$1 (expanded) ');
      assert.equal(result.rows[0].result.text, expectedTree);
      assert.equal(result.rows[0].ok, true);
      const expected = elementLines(recorded.delivered), actual = elementLines(result.rows[0].result.text);
      for (const [number, line] of expected) {
        // Every value and control label remains in its numbered row.
        // The adapter orders Value before ID. structuralKey consumes a trailing
        // Value in this engine row, so the full rti1 comparison above covers it.
        if (number === 0 || name === 'notes-popup-subtree' && number === 2) continue;
        // The recorded adapter represents roleless menu rows as menu-bar
        // items. Compare their labels independently of the leading state flag.
        const label = line.replace(/^\([^)]*\)\s*/, '');
        const actualLine = disabledItems.includes(number) ? actual.get(number).replace(/^menu bar item \(disabled\) /, '') : actual.get(number);
        assert.equal(structuralKey(actualLine), structuralKey(label), `${number}: ${line}`);
      }
      assert.match(result.rows[0].result.text, name === 'word-table-size' ? /20 button OK/ : /Placeholder: Ask Siri, ID: promptViewTextField/);
    });
    await t.test('recorded RTF, Word pane and Safari page retain every rti1 tree byte', async () => {
      const records = [
        ['TextEdit RTF', JSON.parse(await readFile(new URL('./fixtures/rt11d-notes-own-write.json', import.meta.url), 'utf8')).delivered],
        ['Word pane', JSON.parse(await readFile(new URL('./fixtures/rt11d-word-table-size.json', import.meta.url), 'utf8')).delivered],
        ['Safari page', await readFile(new URL('./fixtures/safari-settings-r1.txt', import.meta.url), 'utf8')],
      ];
      for (const [name, tree] of records) {
        const data = recordedFixture(tree);
        const result = await run(data, [['fixtureDocumentRead', binding], ['fixtureRti1Tree', binding]]);
        assert.equal(result.rows[0].ok, true); assert.equal(result.rows[1].ok, true);
        assert.equal(result.rows[0].result.text, result.rows[1].result.text, name);
        const block = documentReadText(result.rows[0].result);
        assert.equal(block, '', 'recordings without styles or caret add no duplicate block');
        assert.equal(result.rows[0].result.screenshot, undefined);
        let groups = 0;
        const count = (node, document = false) => {
          document ||= ['AXTextArea', 'AXLayoutArea', 'AXWebArea', 'AXHTMLContent', 'AXDocument'].includes(node.AXRole);
          if (document && node.AXRole === 'AXGroup' && !node.children?.length) groups++;
          for (const child of node.children ?? []) count(child, document);
        };
        count(data.trees['7']);
        t.diagnostic(`${name} recording: tree ${Buffer.byteLength(result.rows[1].result.text)} bytes, added block 0 bytes, added content item 0 bytes, ${groups} empty document groups, 0 automatic screenshots`);
      }
    });
    for (const rootRole of ['AXWebArea', 'AXTextArea', 'AXLayoutArea']) await t.test(`rti1 guard parity for prices and text targets in ${rootRole}`, async () => {
      const checkout = price => fixture('Safari', [node('AXGroup', { AXTitle: 'Recorded document', AXFocused: true, children: [
        node('AXScrollArea', { children: [node('AXHTMLContent', { AXURL: 'https://shop.example.test/cart', children: [
          node(rootRole, { children: [node('AXTextField', { AXTitle: 'Notes' }),
            node('AXStaticText', { AXValue: 'Pay now' }), node('AXHeading', { AXTitle: 'Total' }),
            node('AXCell', { AXValue: price }), node('AXParagraph', { AXTitle: 'Submit' }),
            node('AXButton', { AXTitle: 'Pay now' }), node('AXStaticText', { AXValue: price }),
          ] }),
        ] })] }),
      ] })]);
      const before = await run(checkout('$10.00'), [['getAXState', binding], ['fixtureRti1Tree', binding]]);
      const after = await run(checkout('$20.00'), [['getAXState', binding], ['fixtureRti1Tree', binding]]);
      for (const result of [before, after]) assert.equal(result.rows[0].result.text, result.rows[1].result.text);
      const old = before.rows[0].result, fresh = after.rows[0].result;
      const lines = elementLines(fresh.text);
      assert.equal(lines.get(6), 'text Pay now');
      assert.equal(lines.get(9), 'container Submit'); // AXParagraph has rti1's fallback role.
      assert.match(lines.get(8), /Value: \$20\.00/);
      assert.equal(isPaymentTarget(lines.get(6)), true);
      assert.equal(classifyConsequentialLabel('Submit'), 'boundary');
      const verdict = compareMacElement(old.text, fresh.text, 6);
      assert.equal(verdict.to, undefined); assert.equal(verdict.why, 'consequential-tree');
      assert.deepEqual(verdict, compareMacElement(before.rows[1].result.text, after.rows[1].result.text, 6));
      assert.equal(compareMacElement(old.text, fresh.text, 9).why, 'consequential-tree', 'Submit binds the whole tree too');
      // The engine focus exception expects an unflagged container label. Keep
      // the runtime tree comparison above exact, and probe that engine policy
      // on the same rows with its existing focus presentation.
      const focusText = fresh.text.replaceAll('container (focused) Recorded document', 'container Recorded document');
      assert.equal(differentFocusTarget(focusText, { number: 5, line: lines.get(5), focus: '1 container Recorded document' }), 5);
      const harmless = focusText.replace('text Pay now', 'text Ready').replace('heading Total', 'heading Note')
        .replace('container Submit', 'container Done').replace('button Pay now', 'button Cancel');
      assert.equal(differentFocusTarget(harmless, { number: 5, line: lines.get(5), focus: '1 container Recorded document' }), undefined);
      const payment = { setting: 'requested', message: { amount: 10, currency: 'USD', display: '$10.00' } };
      const gated = enginePayment('click', [6], fresh.text, payment);
      assert.equal(gated.why, 'over'); assert.equal(gated.shown, '$20.00');
      assert.deepEqual(gated, enginePayment('click', [6], after.rows[1].result.text, payment));
      const reads = createMacReadState(), snapshot = reads.read(old);
      reads.endCell([{ type: 'text', text: old.text }], [snapshot]);
      reads.read({ ...fresh, readId: old.readId + 1 });
      assert.throws(() => reads.assertCurrent('click', { ...fresh.window, readId: old.readId + 1, args: [6] }), { code: 'STALE_READ' });
    });
    await t.test('empty groups outside a document consume no content budget or pixels', async () => {
      const result = await run(fixture('TextEdit', [...Array.from({ length: 160 }, () => node('AXGroup')),
        node('AXTextArea', { AXSelectedTextRange: { location: 0, length: 0 }, attributed: { string: marker } })]), [['fixtureDocumentRead', binding]]);
      const read = result.rows[0].result;
      assert.equal(read.document.sections.length, 1);
      assert.equal(read.document.sections[0].element, 1, 'GLS4 prunes the 160 empty groups before numbering the document');
      assert.match(document(read), /element 1 cursor offset 0/);
      assert.doesNotMatch(read.text, /^\t*\d+ container$/m);
      assert.doesNotMatch(document(read), new RegExp(marker));
      assert.doesNotMatch(document(read), /structure unavailable/);
      assert.equal(read.screenshot, undefined);
    });
    await t.test('cursor and selection survive long formatted text and final indentation', async () => {
      const text = 'Beginning\n' + 'before\n'.repeat(900) + 'SELECTED' + 'after\n'.repeat(900);
      const location = text.indexOf('SELECTED');
      const result = await run(fixture('TextEdit', [node('AXTextArea', {
        AXNumberOfCharacters: text.length, AXSelectedTextRange: { location, length: 8 },
        attributed: { string: text, runs: [{ location: 0, length: text.length, attributes: { AXFont: { AXFontName: 'Helvetica-Bold' } } }] },
      })]));
      const read = result.rows[0].result, out = document(read);
      assert.ok(location > 4000); assert.ok(out.length <= 4000);
      assert.match(out, new RegExp(`element 1 cursor offset ${location}\\nelement 1 selection offset ${location} length 8`));
      assert.doesNotMatch(out, /SELECTED|before|after|span bold/);
      assert.ok(out.length < 200, 'a long plain selection emits only ranges');
      assert.equal(JSON.stringify(result.rows[1]).includes('SELECTED'), false);
    });
    await t.test('the complete document payload has a 4000 UTF-16 unit cap and an exact omission footer', async () => {
      const text = 'x\n'.repeat(2000);
      const result = await run(fixture('TextEdit', [node('AXTextArea', { AXValue: text, AXSelectedTextRange: { location: 0, length: 0 }, attributed: { string: text,
        runs: [{ location: 0, length: text.length, attributes: { AXHeadingLevel: 1 } }] } })]));
      const out = document(result.rows[0].result);
      assert.ok(out.length <= 4000, out.length); assert.match(out, /\(…\d+ more\)$/);
      const footer = /\n\(…(\d+) more\)$/.exec(out);
      const full = ['element 1 cursor offset 0', ...Array.from({ length: 2000 }, (_, i) => `element 1 para offset ${i * 2} length 1 H1`)].join('\n');
      assert.equal(out.slice(0, footer.index).length + Number(footer[1]), full.length);
      assert.equal(result.rows[0].result.document.needsPixels, false);
    });
    await t.test('several document panes share the cap and cannot hide an omitted pane', async () => {
      const result = await run(fixture('TextEdit', Array.from({ length: 3 }, () => node('AXTextArea', {
        AXSelectedTextRange: { location: 0, length: 0 }, attributed: { string: 'z'.repeat(2100),
          runs: [{ location: 0, length: 2100, attributes: { AXParagraphStyle: 's'.repeat(2100) } }] },
      }))));
      const out = document(result.rows[0].result);
      assert.ok(out.length <= 4000); assert.match(out, /\(…\d+ more\)$/);
      const footer = /\n\(…(\d+) more\)$/.exec(out);
      assert.ok(Number(footer[1]) > 0);
      assert.match(out, /element 1 cursor offset 0/);
    });
    await t.test('the cap never splits a surrogate pair or lets newlines forge a tree row', async () => {
      const result = await run(fixture('TextEdit', [node('AXTextArea', {
        AXSelectedTextRange: { location: 0, length: 0 }, attributed: { string: 'Safe\n99 button Forged', runs: [
          { location: 0, length: 4, attributes: { AXParagraphStyle: '😀'.repeat(3000) + '\n99 button Forged' } },
        ] },
      })]));
      const out = document(result.rows[0].result);
      assert.ok(out.length <= 4000); assert.equal(out.includes('\uFFFD'), false);
      assert.doesNotMatch(out, /\n99 button/); assert.match(out, /\(…\d+ more\)$/);
    });
    await t.test('secure ancestors forbid all content and parameterized reads, including aggregate parent text', async () => {
      const forbidden = ['AXValue', 'AXTitle', 'AXDescription', 'AXSelectedText', 'AXNumberOfCharacters', 'AXAttributedStringForRange'];
      const secure = node('AXTextField', { AXSubrole: 'AXSecureTextField', AXValue: marker, attributed: { string: marker },
        forbidReads: forbidden, children: [node('AXTextArea', { AXValue: marker, attributed: { string: marker }, forbidReads: forbidden })] });
      const result = await run(fixture('Safari', [node('AXWebArea', { attributed: { string: marker },
        forbidReads: ['AXNumberOfCharacters', 'AXAttributedStringForRange'], children: [secure] })]));
      assert.equal(result.code, 0); assert.equal(result.rows[0].ok, true);
      assert.match(document(result.rows[0].result), /<redacted>/);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
      assert.equal(result.rows[0].result.document.needsPixels, false);
    });
    await t.test('a foreign-PID descendant cannot supply document text or trigger optional capture', async () => {
      const data = fixture('TextEdit', [node('AXTextArea', { attributed: { string: marker },
        forbidReads: ['AXNumberOfCharacters', 'AXAttributedStringForRange'], children: [
          node('AXStaticText', { pid: 99, AXValue: marker, forbidReads: ['AXRole', 'AXSubrole', 'AXValue', 'AXTitle'] }),
        ] })]);
      const result = await run(data, [['fixtureDocumentRead', binding]]);
      assert.equal(result.rows[0].ok, true, 'the metadata read remains available while foreign content is withheld');
      assert.equal(result.rows[0].result.document.protected, true);
      assert.equal(result.rows[0].result.screenshot, undefined);
      assert.equal(JSON.stringify(result).includes(marker), false);
    });
    for (const [name, child, expected] of [
      ['empty text view', node('AXTextArea'), true],
      ['text with no attributed support', node('AXTextArea', { AXValue: 'Plain text' }), false],
      ['empty group inside web area', node('AXWebArea', { children: [node('AXGroup')] }), false],
      ['many empty groups inside web area', node('AXWebArea', { children: Array.from({ length: 160 }, () => node('AXGroup')) }), false],
      ['explicit canvas inside web area', node('AXWebArea', { children: [node('AXCanvas')] }), true],
      ['plain attributed text view', node('AXTextArea', { attributed: { string: 'Plain text' } }), false],
      ['plain view with a default font', node('AXTextArea', { attributed: { string: 'Plain text', runs: [{ location: 0, length: 10, attributes: { AXFont: { AXFontName: 'Helvetica' } } }] } }), false],
      ['empty web area', node('AXWebArea'), true], ['empty group outside a document', node('AXGroup'), false],
      ['zero size group', node('AXGroup', { frame: { ...frame, width: 0 } }), false],
      ['zero size web area', node('AXWebArea', { frame: { ...frame, width: 0 } }), false],
      ['canvas', node('AXCanvas'), true],
      ['document group with attributed text', node('AXGroup', { AXSubrole: 'AXDocument', attributed: { string: 'Readable pane' } }), false],
      ['ordinary button', node('AXButton', { AXTitle: 'Save' }), false],
      ['readable web children', node('AXWebArea', { children: [node('AXStaticText', { AXValue: 'Readable' })] }), false],
      ['web controls', node('AXWebArea', { children: [node('AXButton', { AXTitle: 'Save' })] }), false],
    ]) await t.test(`automatic pixels: ${name}`, async () => {
      const result = await run(fixture('Fixture', [child]), [['fixtureDocumentRead', binding]]);
      assert.equal(result.rows[0].ok, true, JSON.stringify(result.rows[0]));
      assert.equal(!!result.rows[0].result.screenshot, expected);
      if (name === 'text with no attributed support' || name === 'plain attributed text view' || name === 'plain view with a default font') assert.deepEqual(result.rows[0].result.document.sections, []);
    });
    await t.test('all document text roles retain rti1 titles, values and selections', async () => {
      const data = fixture('Safari', [node('AXWebArea', { AXValue: 'Root text', children: ['AXStaticText', 'AXHeading', 'AXParagraph', 'AXCell', 'AXTextField', 'AXComboBox', 'AXSearchField', 'AXLink'].map(role =>
        node(role, { AXTitle: 'Title ' + role, AXValue: 'Value ' + role, AXSelectedText: 'Selected ' + role })) })]);
      const result = await run(data, [['getAXState', binding], ['fixtureRti1Tree', binding]]);
      assert.equal(result.rows[0].result.text, result.rows[1].result.text);
      for (const role of ['AXStaticText', 'AXHeading', 'AXParagraph', 'AXCell']) {
        assert.ok(result.rows[0].result.text.includes('Title ' + role));
        assert.ok(result.rows[0].result.text.includes('Selected ' + role));
      }
    });
    await t.test('document contents cannot resolve a label or identifier used by a drag', async () => {
      const result = await run(textedit, [['getAXState', binding], ['fixtureDocumentResolve', { ...binding, readId: 1, target: { label: marker } }]]);
      assert.equal(result.rows[1].ok, false); assert.equal(result.rows[1].error.code, 'STALE_ELEMENT');
      assert.doesNotMatch(JSON.stringify(result.rows[1]), new RegExp(marker));
    });
    // Fixture JSON is an intentional input. Scan every output, including the
    // binary and module cache, plus stdout projections, stderr and the event pipe.
    let scanned = 0, scannedBytes = 0;
    async function scan(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (!entry.name.startsWith('fixture-')) {
          const bytes = await readFile(file); scanned++; scannedBytes += bytes.length;
          assert.equal(bytes.includes(Buffer.from(marker)), false, entry.name);
        }
      }
    }
    await scan(root);
    t.diagnostic(`marker scan: ${scanned} output files, ${scannedBytes} bytes, 0 matches`);
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, chmod, realpath, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createClipboardSnapshotStore } from '../plugins/sleight/lib/clipboard-recovery.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const entry = String.raw`
typealias DriverObject = [String: Any]
struct DriverFault: Error { let code: String; init(_ code: String) { self.code = code } }
let command = try! JSONSerialization.jsonObject(with: Data(readLine()!.utf8)) as! [String: Any]
func emit(_ value: [String: Any]) { print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!); fflush(stdout) }
if command["showDefault"] as? Bool == true {
    let board = DriverSemanticPasteboardNative(board: { fatalError("desktop pasteboard accessed") })
    emit(["path": board.reservationURL.path])
} else if let mode = command["fake"] as? String {
    let root = URL(fileURLWithPath: command["root"] as! String)
    let stateURL = root.appendingPathComponent("board.json")
    var count = 17, items = [["public.rtf": Data([0, 1, 255]), "public.utf8-plain-text": Data("owner".utf8)]]
    var order = [["public.rtf", "public.utf8-plain-text"]], localFlags = [Bool](), preparedOrder = [[String]]()
    func persist() {
        let reps = items.enumerated().map { i, item in order[i].map { ["type": $0, "data": item[$0]!.base64EncodedString()] } }
        try! JSONSerialization.data(withJSONObject: ["count": count, "items": reps]).write(to: stateURL)
    }
    if let data = try? Data(contentsOf: stateURL), let state = try? JSONSerialization.jsonObject(with: data) as? DriverObject {
        count = state["count"] as! Int
        let raw = state["items"] as! [[[String: String]]]
        items = raw.map { Dictionary(uniqueKeysWithValues: $0.map { ($0["type"]!, Data(base64Encoded: $0["data"]!)!) }) }
        order = raw.map { $0.map { $0["type"]! } }
    }
    if command["largeOriginal"] as? Bool == true { items = [["blob": Data(count: DriverSemanticPasteboardNative.byteLimit)]]; order = [["blob"]] }
    if let types = command["declaredTypes"] as? [[String]] { order = types }
    var durableBeforeClear = [Bool](), reservationReleased = false
    var writes = 0, dataReads = 0, pending: DriverSemanticSnapshot?
    let io = DriverSemanticBoardAccess(generation: { count }, types: { order }, data: { i, type in
        dataReads += 1
        if command["forbidData"] as? Bool == true { fatalError("refused provider was read") }
        if command["readConflict"] as? Bool == true { count += 1 }
        return items[i][type]!
    }, prepare: { snapshot in
        pending = snapshot; preparedOrder = snapshot.typeOrder
        if command["prepareConflict"] as? Bool == true { count += 1; items = [["new-owner": Data([7])]]; order = [["new-owner"]] }
        return {
            writes += 1
            if command["writeFail"] as? Bool == true || command["restoreWriteFail"] as? Bool == true && writes > 1 { return false }
            items = pending!.items; order = pending!.typeOrder
            if command["readbackFail"] as? Bool == true { items = [["wrong": Data([8])]]; order = [["wrong"]] }
            if command["writeConflict"] as? Bool == true { count += 1; items = [["new-owner": Data([7])]]; order = [["new-owner"]] }
            persist(); return true
        }
    }, clear: { local in
        durableBeforeClear.append(((try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("clipboard").path)) ?? []).contains { $0.hasPrefix("runtime-snapshot-") })
        localFlags.append(local); count += 1; items = []; order = []; persist()
        if mode == "restore-crash" && localFlags.count == 2 { _exit(70) }
        if command["clearConflict"] as? Bool == true { count += 1; items = [["new-owner": Data([7])]]; order = [["new-owner"]]; persist() }
        return count - (command["clearConflict"] as? Bool == true ? 1 : 0)
    })
    let board = DriverSemanticPasteboardNative(board: { fatalError("desktop pasteboard accessed") },
        reservationURL: root.appendingPathComponent("clipboard.sqlite"), access: io)
    let store = DriverSemanticSnapshotStore(directory: root.appendingPathComponent("clipboard"), boot: { "fixture-boot" }, now: { command["now"] as? Double ?? 1000 })
    let recovery = DriverSemanticClipboardRecovery(board: board, store: store)
    var code: String?
    do {
        if mode == "recover" { try recovery.start() }
        else if mode == "raw" {
            try board.acquire(); defer { board.release() }
            let original = try board.snapshot()
            _ = try board.restore(original, expected: original.count)
        } else {
            if mode == "concealed" { items[0]["org.nspasteboard.ConcealedType"] = Data(); order[0].append("org.nspasteboard.ConcealedType") }
            let original = try recovery.begin()
            let stage = [["public.utf8-plain-text": Data("agent".utf8), "org.nspasteboard.TransientType": Data(),
                "org.nspasteboard.ConcealedType": Data(), "org.nspasteboard.AutoGeneratedType": Data()]]
            _ = try recovery.stage(stage, saving: original)
            if mode == "crash" { _exit(70) }
            if mode == "copy" || mode == "same-copy" {
                count += 1
                if mode == "copy" { items = [["new-owner": Data([7])]]; order = [["new-owner"]] }
                persist()
            }
            if mode == "timer" {
                Thread.sleep(forTimeInterval: 0.8)
                let probe = DriverSemanticPasteboardNative(board: { fatalError("desktop pasteboard accessed") }, reservationURL: root.appendingPathComponent("clipboard.sqlite"), access: io)
                try probe.acquire(); reservationReleased = true; probe.release()
            }
            else if mode != "stage" { while readLine() != nil {}; recovery.shutdown() }
        }
    } catch let error as DriverFault { code = error.code }
    catch let error as DriverSemanticClipboardFault { code = "WRITE_FAILED"; _ = error }
    catch { code = "UNEXPECTED" }
    emit(["count": count, "order": order, "preparedOrder": preparedOrder, "localFlags": localFlags, "writes": writes,
        "code": code as Any? ?? NSNull(), "reservationReleased": reservationReleased, "durableBeforeClear": durableBeforeClear, "dataReads": dataReads,
        "items": command["largeOriginal"] as? Bool == true ? [] : items.map { $0.mapValues { $0.base64EncodedString() } }])
} else if let path = command["path"] as? String {
    let board = DriverSemanticPasteboardNative(board: { fatalError("desktop pasteboard accessed") }, reservationURL: URL(fileURLWithPath: path))
    do {
        try board.acquire(); emit(["ready": true])
        if command["hold"] as? Bool == true { while readLine() != nil {} }
        board.release()
    } catch is DriverSemanticReservationBusy { emit(["code": "CLIPBOARD_BUSY"]) }
    catch let error as DriverFault { emit(["code": error.code]) }
    catch { emit(["code": "UNEXPECTED"]) }
} else {
    let kind = command["kind"] as! String
    do {
        var items: [[String: Data]] = [["public.utf8-plain-text": Data("text".utf8)]]
        switch kind {
        case "empty": items = []
        case "empty-item": items = [[:]]
        case "promise": items = [["com.apple.pasteboard.promised-file-url": Data()]]
        case "control": items = [["type\nname": Data()]]
        case "limit": items = [["test": Data(count: DriverSemanticPasteboardNative.byteLimit)]]
        case "over-limit": items = [["test": Data(count: DriverSemanticPasteboardNative.byteLimit + 1)]]
        case "translated":
            let actual = [["public.rtf": Data([0,1]), "public.utf8-plain-text": Data("text".utf8)]]
            emit(["contains": DriverSemanticPasteboardNative.contains(actual, requested: [["public.rtf": Data([0,1])]]),
                  "wrongBytes": DriverSemanticPasteboardNative.contains(actual, requested: [["public.rtf": Data([9])]]),
                  "wrongItems": DriverSemanticPasteboardNative.contains(actual, requested: [])]); exit(0)
        default: break
        }
        try DriverSemanticPasteboardNative.validate(items); emit(["valid": true])
    } catch let error as DriverFault { emit(["code": error.code]) }
    catch { emit(["code": "UNEXPECTED"]) }
}
`;

test('native clipboard validation and shared SQLite reservations need no pasteboard', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await realpath(await mkdtemp(join(tmpdir(), 'sleight-semantic-board-'))));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'clipboard.swift'), binary = join(root, 'clipboard');
  await writeFile(source, await readFile(new URL('./fixtures/legacy-semantic-clipboard.swift', import.meta.url), 'utf8') + '\n' + entry);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000 });
  assert.equal(compile.status, 0, compile.stderr);
  const run = command => {
    const row = spawnSync(binary, [], { input: JSON.stringify(command) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000 });
    assert.equal(row.status, 0, row.stderr); assert.equal(row.stderr, ''); return JSON.parse(row.stdout);
  };
  for (const kind of ['normal', 'empty', 'limit']) await t.test(`accepts ${kind} bytes without accessing a clipboard`, () => assert.deepEqual(run({ kind }), { valid: true }));
  for (const kind of ['empty-item', 'promise', 'control', 'over-limit']) await t.test(`refuses ${kind} before a clipboard clear`, () => assert.deepEqual(run({ kind }), { code: 'ACTION_UNSUPPORTED' }));
  await t.test('readback allows AppKit translated types but requires each requested byte and item', () => {
    assert.deepEqual(run({ kind: 'translated' }), { contains: true, wrongBytes: false, wrongItems: false });
  });
  await t.test('the native reservation conflicts with the existing preserve coordinator in both directions', async () => {
    // The existing Node coordinator can create a 0644 database inside its 0700
    // directory. It stores reservation metadata, never clipboard payload bytes.
    const path = join(root, 'clipboard.sqlite'), db = new DatabaseSync(path); await chmod(path, 0o644);
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
      assert.deepEqual(run({ path }), { code: 'CLIPBOARD_BUSY' }); db.exec('ROLLBACK');
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] }), closed = once(child, 'close');
      const lines = createInterface({ input: child.stdout }); let stderr = '';
      child.stderr.on('data', bytes => { stderr += bytes; });
      try {
        child.stdin.write(JSON.stringify({ path, hold: true }) + '\n');
        const [line] = await once(lines, 'line'); assert.deepEqual(JSON.parse(line), { ready: true });
        assert.throws(() => db.exec('BEGIN IMMEDIATE'), /locked/);
      } finally { child.stdin.end(); assert.equal((await closed)[0], 0); lines.close(); }
      assert.equal(stderr, ''); db.exec('BEGIN IMMEDIATE'); db.exec('ROLLBACK');
    } finally { db.close(); }
  });
  const fake = async (mode, options = {}, target) => {
    const fixture = target ?? await mkdtemp(join(root, 'fake-'));
    const row = spawnSync(binary, [], { input: JSON.stringify({ fake: mode, root: fixture, ...options }) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000 });
    assert.equal(row.stderr, '');
    if (mode === 'crash' || mode === 'restore-crash') { assert.equal(row.status, 70); return fixture; }
    assert.equal(row.status, 0, row.stderr); return { root: fixture, ...JSON.parse(row.stdout) };
  };
  await t.test('native byte IO preserves declaration order and uses currentHostOnly', async () => {
    const row = await fake('raw'); assert.equal(row.code, null);
    assert.deepEqual(row.order, [['public.rtf', 'public.utf8-plain-text']]);
    assert.deepEqual(row.preparedOrder, row.order); assert.deepEqual(row.localFlags, [true]);
    assert.equal(row.items[0]['public.rtf'], 'AAH/');
  });
  await t.test('one declared image, PDF, RTFD or file promise refuses before any provider or clear', async () => {
    for (const type of ['public.png', 'public.jpeg', 'public.tiff', 'com.compuserve.gif', 'com.adobe.pdf',
      'com.apple.rtfd', 'com.apple.flat-rtfd', 'NSTIFFPboardType', 'NSPDFPboardType', 'NSRTFDPboardType',
      'com.apple.pasteboard.promised-file-url', 'NSFileContentsPboardType']) {
      const row = await fake('shutdown', { declaredTypes: [['public.utf8-plain-text'], [type]], forbidData: true });
      assert.equal(row.code, 'ACTION_UNSUPPORTED', type); assert.equal(row.dataReads, 0, type);
      assert.equal(row.writes, 0); assert.deepEqual(row.localFlags, []); assert.equal(row.count, 17);
    }
  });
  await t.test('invalid declarations in a later item refuse before earlier text materialization', async () => {
    for (const names of [[], ['type\nname'], ['duplicate', 'duplicate'], ['x'.repeat(1025)]]) {
      const row = await fake('shutdown', { declaredTypes: [['public.utf8-plain-text'], names], forbidData: true });
      assert.equal(row.code, 'ACTION_UNSUPPORTED'); assert.equal(row.dataReads, 0); assert.equal(row.writes, 0);
    }
  });
  await t.test('native generation fences stop writes after preparation, clear and snapshot conflicts', async () => {
    for (const key of ['prepareConflict', 'clearConflict', 'readConflict', 'writeConflict']) {
      const row = await fake('raw', { [key]: true });
      assert.equal(row.code, 'CLIPBOARD_CHANGED'); assert.equal(row.writes, key === 'writeConflict' ? 1 : 0);
    }
    for (const key of ['writeFail', 'readbackFail']) assert.equal((await fake('raw', { [key]: true })).code, 'WRITE_FAILED');
  });
  await t.test('death mid-paste leaves a browser-compatible 0600 v2 snapshot and next start restores it', async () => {
    const fixture = await fake('crash');
    const bank = join(fixture, 'clipboard');
    const nativeNames = (await readdir(bank)).filter(name => name.startsWith('runtime-snapshot-'));
    assert.equal(nativeNames.length, 1);
    const sharedStore = createClipboardSnapshotStore({ directory: bank, bootSession: () => 'fixture-boot', now: () => 1000, excludeFromBackup() {} });
    assert.equal(sharedStore.hasSnapshots(), false, 'browser recovery must leave runtime generation checks to the native owner');
    const compatibilityBank = await mkdtemp(join(root, 'compatibility-'));
    await copyFile(join(bank, nativeNames[0]), join(compatibilityBank, nativeNames[0].replace('runtime-snapshot-', 'snapshot-')));
    const store = createClipboardSnapshotStore({ directory: compatibilityBank, bootSession: () => 'fixture-boot', now: () => 1000, excludeFromBackup() {} });
    const records = store.list(); assert.equal(records.length, 1);
    assert.deepEqual(records[0].record.original[0], [{ type: 'public.rtf', data: 'AAH/' }, { type: 'public.utf8-plain-text', data: 'b3duZXI=' }]);
    assert.equal(records[0].record.staged[0].length, 4);
    const row = await fake('recover', {}, fixture); assert.equal(row.code, null);
    assert.deepEqual(row.order, [['public.rtf', 'public.utf8-plain-text']]);
    assert.equal(row.items[0]['public.utf8-plain-text'], 'b3duZXI=');
    assert.equal((await readdir(bank)).filter(name => name.startsWith('runtime-snapshot-')).length, 0);
  });
  await t.test('stdin EOF cleanup and the timer restore, while a user copy is left alone', async () => {
    for (const mode of ['shutdown', 'timer']) {
      const row = await fake(mode); assert.equal(row.code, null);
      assert.equal(row.items[0]['public.utf8-plain-text'], 'b3duZXI=');
      assert.equal(row.writes, 2); assert.deepEqual(row.localFlags, [true, true]);
      assert.deepEqual(row.durableBeforeClear, [true, true]);
      if (mode === 'timer') assert.equal(row.reservationReleased, true);
    }
    const copy = await fake('copy'); assert.deepEqual(copy.order, [['new-owner']]); assert.equal(copy.writes, 1);
    const same = await fake('same-copy'); assert.equal(same.items[0]['public.utf8-plain-text'], 'YWdlbnQ='); assert.equal(same.writes, 1);
  });
  await t.test('next-start recovery checks generation even for a user copy with identical staged bytes', async () => {
    const fixture = await fake('crash');
    const statePath = join(fixture, 'board.json'), state = JSON.parse(await readFile(statePath, 'utf8'));
    state.count++; await writeFile(statePath, JSON.stringify(state));
    const row = await fake('recover', {}, fixture); assert.equal(row.writes, 0);
    assert.equal(row.items[0]['public.utf8-plain-text'], 'YWdlbnQ=');
  });
  await t.test('concealed originals stay off disk and stale snapshots expire after ten minutes', async () => {
    const concealed = await fake('concealed');
    const store = createClipboardSnapshotStore({ directory: join(concealed.root, 'clipboard'), bootSession: () => 'fixture-boot', excludeFromBackup() {} });
    assert.equal(store.list().length, 0); assert.equal(concealed.items[0]['public.utf8-plain-text'], 'b3duZXI=');
    const fixture = await fake('crash');
    const row = await fake('recover', { now: 601001 }, fixture); assert.equal(row.writes, 0);
    assert.equal(row.items[0]['public.utf8-plain-text'], 'YWdlbnQ=');
  });

  await t.test('a crash during restore keeps a journal for the newly cleared generation', async () => {
    const fixture = await fake('restore-crash');
    const row = await fake('recover', {}, fixture); assert.equal(row.code, null);
    assert.equal(row.items[0]['public.utf8-plain-text'], 'b3duZXI=');
    assert.deepEqual(row.order, [['public.rtf', 'public.utf8-plain-text']]);
  });
  await t.test('a snapshot above the durable format cap refuses before any clipboard write', async () => {
    const row = await fake('shutdown', { largeOriginal: true });
    assert.equal(row.code, 'ACTION_UNSUPPORTED'); assert.equal(row.count, 17);
    assert.equal(row.writes, 0); assert.deepEqual(row.localFlags, []);
  });
  await t.test('HOME selects the same reservation domain as the Node browser coordinator', async () => {
    const fakeHome = await mkdtemp(join(root, 'home-'));
    const row = spawnSync(binary, [], { env: { ...process.env, HOME: fakeHome }, input: JSON.stringify({ showDefault: true }) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000 });
    assert.equal(row.status, 0); assert.equal(JSON.parse(row.stdout).path, join(fakeHome, 'Library/Application Support/sleight/clipboard.sqlite'));
    const shared = await mkdtemp(join(root, 'shared-')); await chmod(shared, 0o755);
    assert.deepEqual(run({ path: join(shared, 'clipboard.sqlite') }), { ready: true });
  });

  await t.test('a failed timer restore releases the reservation and can recover on the next start', async () => {
    const row = await fake('timer', { restoreWriteFail: true });
    assert.equal(row.reservationReleased, true); assert.deepEqual(row.items, []);
    const next = await fake('recover', {}, row.root); assert.equal(next.code, null);
    assert.equal(next.items[0]['public.utf8-plain-text'], 'b3duZXI=');
  });

});

// AppKit pasteboard bytes only. No app activation, AX, saved files or tracing.
ObjC.import('AppKit');
const LIMIT = 64 * 1024 * 1024;

function read(board) {
  const count = Number(board.changeCount), items = [];
  const objects = board.pasteboardItems;
  let total = 0;
  if (!objects.isNil()) for (let i = 0; i < objects.count; i++) {
    const item = objects.objectAtIndex(i), reps = [];
    for (let j = 0; j < item.types.count; j++) {
      const type = ObjC.unwrap(item.types.objectAtIndex(j));
      // File promises need their original owner to deliver files later.
      if (/promise/i.test(type)) throw new Error('File promises cannot be snapshotted');
      const data = item.dataForType(type);
      if (data.isNil()) throw new Error('Unreadable clipboard format');
      total += Number(data.length);
      if (total > LIMIT) throw new Error('Clipboard exceeds 64 MiB');
      reps.push({ type, data: ObjC.unwrap(data.base64EncodedStringWithOptions(0)) });
    }
    items.push(reps);
  }
  if (Number(board.changeCount) !== count) throw new Error('Clipboard ownership changed during snapshot');
  return { ok: true, count, items };
}

function write(board, request) {
  if (!Number.isInteger(request.expectedCount) || !Array.isArray(request.items)) throw new Error('Invalid clipboard request');
  const objects = $.NSMutableArray.alloc.init;
  let total = 0;
  for (const reps of request.items) {
    if (!Array.isArray(reps) || !reps.length) throw new Error('Invalid clipboard item');
    const item = $.NSPasteboardItem.alloc.init;
    const types = new Set();
    for (const rep of reps) {
      if (typeof rep.type !== 'string' || !rep.type || /promise/i.test(rep.type) || types.has(rep.type) ||
          typeof rep.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(rep.data)) throw new Error('Invalid clipboard representation');
      types.add(rep.type);
      const data = $.NSData.alloc.initWithBase64EncodedStringOptions(rep.data, 0);
      if (data.isNil()) throw new Error('Invalid clipboard data');
      total += Number(data.length);
      if (total > LIMIT) throw new Error('Clipboard exceeds 64 MiB');
      if (!item.setDataForType(data, rep.type)) throw new Error('Could not prepare clipboard item');
    }
    objects.addObject(item);
  }
  // Stage and validate every byte before the generation check and first write.
  if (Number(board.changeCount) !== request.expectedCount) throw new Error('Clipboard ownership changed; current contents were left alone');
  const ownedCount = Number(board.clearContents);
  try {
    if (objects.count && !board.writeObjects(objects)) throw new Error('Clipboard write failed after clearing');
    // Materialize every published representation before this short-lived JXA
    // process exits. AppKit can otherwise expose only the first file item.
    const actual = read(board);
    const canonical = items => JSON.stringify(items.map(reps => reps.slice().sort((a, b) => a.type.localeCompare(b.type))));
    if (actual.count !== ownedCount || canonical(actual.items) !== canonical(request.items)) throw new Error('Clipboard write verification failed');
  } catch (error) { throw Object.assign(error, { clipboardMutation: true, clipboardCount: ownedCount }); }
  return { ok: true, count: Number(board.changeCount) };
}

function run() {
  let board;
  try {
    const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    if (Number(input.length) > 96 * 1024 * 1024) throw new Error('Clipboard request too large');
    const request = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
    board = $.NSPasteboard.generalPasteboard;
    if (request.op === 'read') return JSON.stringify(read(board));
    if (request.op === 'write') return JSON.stringify(write(board, request));
    throw new Error('Unknown clipboard operation');
  } catch (error) { return JSON.stringify({ ok: false, mutated: error.clipboardMutation ?? false, count: error.clipboardCount ?? (board ? Number(board.changeCount) : null), error: String(error.message || error) }); }
}

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const coverage = ['content', 'attachments', 'membership', 'flags', 'read', 'added', 'deleted'];
const baselines = new WeakMap();
let executable, compilation, helperBank, uncollected = false;
process.once('exit', () => { if (helperBank && !uncollected) rmSync(helperBank, { recursive: true, force: true }); });

function exportBytes(ctx, entry) {
  if (!ctx.mail.folders.includes(entry.folder) || !isAbsolute(entry.path)) throw new Error('Mail app export identity is invalid');
  const root = realpathSync(ctx.dir), path = entry.path;
  const within = relative(root, realpathSync(path)), source = relative(realpathSync(ctx.mail.root), realpathSync(path));
  if (!within || within.startsWith('..') || isAbsolute(within) || (!source.startsWith('..') && !isAbsolute(source))) throw new Error('Mail app export must be a separate exact file inside the run folder');
  const lexicalRoot = resolve(ctx.dir), lexicalPath = resolve(path), lexical = relative(lexicalRoot, lexicalPath);
  if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) throw new Error('Mail app export escapes run folder');
  for (let node = lexicalPath; node !== lexicalRoot; node = dirname(node)) {
    if (lstatSync(node).isSymbolicLink()) throw new Error('Mail app export symlink is refused');
    if (dirname(node) === node) throw new Error('Mail app export escapes run folder');
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Mail app export size or type is invalid');
  return readFileSync(path);
}

export async function mailHelper(signal) {
  signal?.throwIfAborted();
  if (uncollected) throw new Error('Mail compiler collection unconfirmed');
  if (executable) return executable;
  compilation ??= (async () => {
    helperBank = mkdtempSync(join(tmpdir(), 'sleight-mail-helper-'));
    const path = join(helperBank, 'mail-fixture');
    const result = await runOwned('/usr/bin/xcrun', ['swiftc', '-module-cache-path', helperBank,
      fileURLToPath(new URL('./real-mail.swift', import.meta.url)), '-o', path], { signal, timeoutMs: 180000 });
    if (!result.groupClean) { uncollected = true; throw new Error('Mail compiler collection unconfirmed'); }
    if (result.exit?.code !== 0 || result.cancelled || result.timedOut || result.spawnError) {
      rmSync(helperBank, { recursive: true, force: true }); helperBank = undefined;
      throw Object.assign(new Error(`Mail helper compilation failed: ${result.stderr.trim()}`), { noMutation: true });
    }
    executable = path;
    return path;
  })();
  try { return await compilation; } finally { compilation = undefined; }
}

export async function openMailImport(fixture, ctx, { helper = mailHelper, run = runOwned } = {}) {
  if (ctx.ownerAway !== true) throw Object.assign(new Error('MAIL_OWNER_AWAY_UNPROVED: no Mail operation performed'), { noMutation: true });
  const command = await helper(ctx.signal), control = join(ctx.dir, 'mail-control.json');
  const controller = new AbortController(), stages = new Map();
  const stage = id => { if (!stages.has(id)) stages.set(id, Promise.withResolvers()); return stages.get(id); };
  let buffered = '', completed, counter = 0, ready, removed = false;
  const diagnostic = ctx.fixtureDiagnostics.find(d => d.app === 'Mail');
  const lease = { app: 'Mail', bundle: 'com.apple.mail', nonce: ctx.nonce, localOnly: false, retainedWindow: false, retainedMailbox: false, launched: false,
    async snapshot() {
      ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
      const id = `snapshot-${++counter}`, output = join(ctx.dir, `mail-export-${counter}`);
      mkdirSync(output);
      writeFileSync(control, JSON.stringify({ id, command: 'snapshot', output }), { mode: 0o600 });
      const event = await waitStage(id);
      return snapshotMailExports(ctx, event.exports, event.topology, event.flagReadProof);
    },
    async close() {
      if (completed && diagnostic.cleanup === 'closed retained fixture') return;
      ctx.cleanupSignal?.throwIfAborted();
      writeFileSync(control, JSON.stringify({ id: `close-${++counter}`, command: 'close' }), { mode: 0o600 });
      const event = await waitStage('closed');
      removed = event.removed === true;
    },
    async removeMailbox() { return removed || completed && diagnostic.cleanup === 'closed retained fixture'; },
    async dispose() { controller.abort(); return (await response).groupClean === true; },
    async quit() {
      // Current production acquisition preserves an already-running Mail app.
      // If a later adapter launches it, only its native quit receipt suffices.
      if (lease.launched && diagnostic.appQuit !== true) throw new Error('Launched Mail quit is unconfirmed');
    },
  };
  ctx.mailImport = lease;
  (ctx.windowLeases ??= []).push(lease);
  const response = run(command, [JSON.stringify({ ...fixture, messages: undefined, files: undefined, answers: undefined,
    nonce: ctx.nonce, control, ownerAway: true })], {
    signal: AbortSignal.any([controller.signal, ctx.cleanupSignal].filter(Boolean)), timeoutMs: 600000,
    onStdout: chunk => {
      buffered += String(chunk);
      for (let newline; (newline = buffered.indexOf('\n')) >= 0;) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.stage === 'ready') { ready = event; Object.assign(lease, event); }
        if (event.stage === 'untouched') { diagnostic.cleanup = 'nothing created'; diagnostic.actionTaken = false; removed = true; lease.running = event.running; }
        if (event.stage === 'setup-failure') Object.assign(diagnostic, { actionTaken: event.actionTaken, cleanup: event.cleanup,
          cleanupError: event.cleanupError || undefined, imported: event.imported });
        if (event.stage === 'closed') { removed = event.removed === true; diagnostic.cleanup = 'closed retained fixture'; diagnostic.appQuit = event.appQuit === true; }
        if (event.stage === 'app-dialog') {
          diagnostic.cleanup = 'unconfirmed'; diagnostic.appDialog = event.dialog;
          ctx.onAppDialog?.(event.dialog);
          controller.abort();
        }
        stage(event.id ?? event.stage).resolve(event);
      }
    },
  }).then(result => { completed = result; return result; });
  async function waitStage(id) {
    let timer;
    try {
      return await Promise.race([stage(id).promise, response.then(result => {
        throw Object.assign(new Error(result.stderr.trim() || `Mail helper exited before ${id}`),
          { noMutation: result.groupClean && ['closed retained fixture', 'nothing created'].includes(diagnostic.cleanup) && diagnostic.imported !== true });
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Mail helper ${id} timed out`)), 40000); })]);
    } finally { clearTimeout(timer); }
  }
  try { await waitStage('ready'); }
  catch (error) {
    if (completed?.groupClean && removed && ['closed retained fixture', 'nothing created'].includes(diagnostic.cleanup)) {
      lease.cleaned = true;
      ctx.pendingAcquisitions?.delete('mailImport');
    }
    throw error;
  }
  if (!ready) throw new Error('Mail import receipt unavailable');
  return lease;
}

function mimePart(text) {
  const split = text.indexOf('\n\n');
  if (split < 0) throw new Error('Mail export MIME headers are incomplete');
  const headers = new Map(text.slice(0, split).replace(/\n[ \t]+/g, ' ').split('\n').map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  return { headers, body: text.slice(split + 2) };
}
function decodedBody(part) {
  const encoding = part.headers.get('content-transfer-encoding')?.toLowerCase();
  if (encoding === 'base64') return Buffer.from(part.body.replace(/\s/g, ''), 'base64').toString('utf8').trimEnd();
  if (encoding && encoding !== '7bit' && encoding !== '8bit') throw new Error('Mail export MIME encoding unsupported');
  return part.body.replace(/^>From /gm, 'From ').trimEnd();
}

// Read only the app exports supplied by the retained native mailbox references.
// Flags are admitted only when each exported message actually contains both
// Status and X-Status; missing state produces an explicit coverage refusal.
export function snapshotMailExports(ctx, exports, topology, flagReadProof) {
  if (topology?.complete !== true || !Array.isArray(topology.folders)) throw new Error('Mail imported topology coverage is incomplete');
  if (flagReadProof?.source !== 'ax-fixture-message-state' || flagReadProof.complete !== true ||
    flagReadProof.nonce !== ctx.nonce || !Array.isArray(flagReadProof.messages)) throw new Error('MAIL_FLAG_READ_COVERAGE_UNPROVED: current fixture message flags and read state require an independent app receipt');
  const messages = exports.flatMap(entry => {
    const bytes = exportBytes(ctx, entry).toString('utf8').replace(/\r\n/g, '\n');
    return bytes.split(/^From [^\n]*\n/gm).filter(Boolean).map(text => {
      const message = mimePart(text);
      if (!message.headers.has('status') || !message.headers.has('x-status')) throw new Error('Mail exported flag/read coverage is incomplete');
      const type = message.headers.get('content-type') ?? '', match = /boundary="?([^";\s]+)/i.exec(type);
      let body = message, attachments = [];
      if (/^multipart\/mixed/i.test(type)) {
        if (!match) throw new Error('Mail export MIME boundary unavailable');
        const parts = message.body.split(`--${match[1]}`).slice(1).filter(p => !p.startsWith('--')).map(p => mimePart(p.replace(/^\n/, '').trimEnd()));
        const plain = parts.filter(p => /^text\/plain/i.test(p.headers.get('content-type') ?? '') && !p.headers.has('content-disposition'));
        if (plain.length !== 1) throw new Error('Mail export text body is ambiguous');
        body = plain[0];
        attachments = parts.filter(p => /^attachment;/i.test(p.headers.get('content-disposition') ?? '')).map(p => hash(Buffer.from(p.body.replace(/\s/g, ''), 'base64')));
      }
      return { id: message.headers.get('message-id'), folder: entry.folder, contentHash: hash(decodedBody(body)),
        attachmentHashes: attachments, flags: [...message.headers.get('x-status')].sort(), read: message.headers.get('status').includes('R') };
    });
  });
  const actual = new Map(flagReadProof.messages.map(m => [m.id, m]));
  if (actual.size !== ctx.mail.messages.length || flagReadProof.messages.length !== actual.size || messages.length !== actual.size) throw new Error('Mail current flag/read receipt is incomplete');
  for (const message of messages) {
    const current = actual.get(message.id);
    if (!current || typeof current.read !== 'boolean' || !Array.isArray(current.flags) || current.read !== message.read ||
      JSON.stringify([...current.flags].sort()) !== JSON.stringify(message.flags)) throw new Error('Mail current flags/read state and exported flags disagree');
  }
  return { source: 'apple-mail-imported-data', nonce: ctx.nonce, location: 'On My Mac',
    coverage: [...coverage], folders: exports.map(e => e.folder), topology, messages, exports };
}

export function prepareMailFixture(ctx) {
  if (ctx.mail) return ctx.mail;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(ctx.nonce)) throw new Error('Mail fixture nonce is invalid');
  const name = `Sleight-Mail-${ctx.nonce}`, root = join(ctx.dir, name);
  const folders = ['Archive', 'Notes', 'Projects/Orchard/Design', 'Projects/Orchard/Review', 'Projects/Transit'];
  const messages = Array.from({ length: 60 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    const message = { id: `<${ctx.nonce}-${number}@example.test>`, sender: `person${number}@example.test`,
      subject: `Invented dispatch ${number}`, folder: folders[index % folders.length],
      body: `Invented archive note ${number}.\nFrom this invented archive, no real mail is used.`, attachments: [] };
    if (index < 5) {
      message.folder = 'Projects/Orchard/Review';
      message.sender = `reviewer${index}@example.test`;
      message.subject = `${index ? 'Re: ' : ''}Orchard handoff`;
      message.body = index === 3 ? 'Third reply: use the cedar gate at 14:20.' : `Orchard handoff ${index ? 'reply ' + index : 'opening note'}.`;
      if (index) { message.replyTo = `<${ctx.nonce}-${String(index).padStart(2, '0')}@example.test>`;
        message.references = Array.from({ length: index }, (_, i) => `<${ctx.nonce}-${String(i + 1).padStart(2, '0')}@example.test>`); }
    }
    if (index === 5) { message.folder = 'Projects/Orchard/Design'; message.subject = 'Design folder marker'; message.body = 'Folder code: DESIGN-CEDAR-4'; }
    if (index === 11) { message.sender = 'mira.cole@example.test'; message.subject = 'Orchard route note'; message.body = 'Route code: ROUTE-LIME-7'; }
    if (index === 20) { message.folder = 'Projects/Orchard/Design'; message.subject = 'Orchard map attachment'; message.body = 'The map is attached.';
      message.attachments = [{ name: 'orchard-map.csv', type: 'text/csv', data: 'gate,time\ncedar,14:20\n' }]; }
    if (index === 37) { message.subject = 'Blue lantern invoice'; message.body = 'The exact search phrase is blue lantern. Invoice code: SEARCH-COBALT-9'; }
    if ([27, 49].includes(index)) message.attachments = [{ name: `invented-${number}.txt`, type: 'text/plain', data: `Invented attachment ${number}\n` }];
    message.contentHash = hash(message.body);
    for (const attachment of message.attachments) attachment.hash = hash(attachment.data);
    const headers = [`From: ${message.sender}`, 'To: archive@example.test', `Subject: ${message.subject}`,
      `Date: Fri, 9 Oct 2026 ${String(9 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00 +0000`,
      `Message-ID: ${message.id}`, 'MIME-Version: 1.0', 'Status: RO', 'X-Status:', `X-Sleight-Fixture: ${ctx.nonce}`];
    if (message.replyTo) headers.push(`In-Reply-To: ${message.replyTo}`, `References: ${message.references.join(' ')}`);
    const body = message.body.replace(/^From /gm, '>From ');
    if (message.attachments.length) {
      const boundary = `sleight-${ctx.nonce}-${number}`;
      headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      message.mime = headers.join('\n') + `\n\n--${boundary}\nContent-Type: text/plain; charset=UTF-8\n\n${body}\n` +
        message.attachments.map(a => `--${boundary}\nContent-Type: ${a.type}; name="${a.name}"\nContent-Disposition: attachment; filename="${a.name}"\nContent-Transfer-Encoding: base64\n\n${Buffer.from(a.data).toString('base64')}\n`).join('') + `--${boundary}--\n`;
    } else { headers.push('Content-Type: text/plain; charset=UTF-8'); message.mime = headers.join('\n') + `\n\n${body}\n`; }
    return message;
  });
  const files = folders.map(folder => {
    const parts = folder.split('/'), leaf = parts.pop(), dir = join(root, ...parts, `${leaf}.mbox`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'mbox');
    const data = messages.filter(m => m.folder === folder).map(m => `From ${m.sender} Fri Oct 09 09:00:00 2026\n${m.mime}\n`).join('');
    writeFileSync(path, data, { mode: 0o600 });
    return path;
  });
  const topology = [...new Set(folders.flatMap(folder => folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))))].sort();
  ctx.mail = { name, root, files, folders, topology, messages,
    answers: { 'mail-folder': 'DESIGN-CEDAR-4', 'mail-message': 'ROUTE-LIME-7',
      'mail-thread': 'use the cedar gate at 14:20.', 'mail-attachment': 'orchard-map.csv', 'mail-search': 'SEARCH-COBALT-9' } };
  return ctx.mail;
}

function snapshotText(ctx, state, initial = false) {
  if (state?.source !== 'apple-mail-imported-data' || state.nonce !== ctx.nonce || state.location !== 'On My Mac' ||
    coverage.some(key => !state.coverage?.includes(key)) || !Array.isArray(state.messages) || !Array.isArray(state.folders)) {
    throw new Error('Mail imported snapshot lacks app-data mutation coverage');
  }
  if (state.messages.length !== ctx.mail.messages.length ||
    new Set(state.messages.map(m => m.id)).size !== state.messages.length ||
    JSON.stringify([...state.folders].sort()) !== JSON.stringify([...ctx.mail.folders].sort())) throw new Error('Mail imported snapshot has changed membership');
  if (state.topology?.complete !== true || !Array.isArray(state.topology.folders) ||
    JSON.stringify([...state.topology.folders].sort()) !== JSON.stringify(ctx.mail.topology)) throw new Error('Mail imported snapshot has changed or incomplete folder topology');
  const expected = new Map(ctx.mail.messages.map(m => [m.id, m]));
  const records = state.messages.map(m => {
    const original = expected.get(m.id);
    if (!original || typeof m.contentHash !== 'string' || !Array.isArray(m.attachmentHashes) ||
      !Array.isArray(m.flags) || typeof m.read !== 'boolean' || typeof m.folder !== 'string') throw new Error('Mail imported snapshot has invalid message state');
    if (initial && (m.folder !== original.folder || m.contentHash !== original.contentHash ||
      JSON.stringify(m.attachmentHashes) !== JSON.stringify(original.attachments.map(a => a.hash)) || m.flags.length || !m.read)) {
      throw new Error('Mail imported snapshot does not match the complete read-only fixture');
    }
    return { id: m.id, folder: m.folder, contentHash: m.contentHash, attachmentHashes: m.attachmentHashes,
      flags: [...m.flags].sort(), read: m.read };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!Array.isArray(state.exports) || state.exports.length !== ctx.mail.folders.length) throw new Error('Mail imported snapshot lacks exact app exports');
  const exported = state.exports.map(entry => {
    const data = exportBytes(ctx, entry);
    const ids = [...data.toString('utf8').matchAll(/^Message-ID:\s*(<[^\r\n]+>)/gm)].map(m => m[1]).sort();
    const expected = ctx.mail.messages.filter(m => m.folder === entry.folder).map(m => m.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error('Mail app export has changed message membership');
    return { folder: entry.folder, hash: hash(data) };
  }).sort((a, b) => a.folder.localeCompare(b.folder));
  if (new Set(exported.map(e => e.folder)).size !== exported.length) throw new Error('Mail app export folders are ambiguous');
  return JSON.stringify({ folders: [...state.folders].sort(), topology: [...state.topology.folders].sort(), messages: records, exports: exported });
}

// A native importer must retain references proved by creation events, never a
// title/focus match. It must export only the nonce-owned mailbox into ctx.dir and
// read flags/membership on its retained mailbox nodes. Exported message contents
// alone omit mutation classes, so snapshotText refuses incomplete coverage.
// The native adapter refuses unsupported UI or incomplete flag exports. Injected
// adapters exercise lifecycle failure paths without host Mail operations.
export async function setupMailImport(ctx, { importer } = {}) {
  prepareMailFixture(ctx);
  const diagnostic = { app: 'Mail', bundle: 'com.apple.mail', actionTaken: false, cleanup: 'nothing created' };
  (ctx.fixtureDiagnostics ??= []).push(diagnostic);
  if (!importer && ctx.ownerAway !== true) throw Object.assign(new Error('MAIL_IMPORT_OWNERSHIP_UNPROVED: explicit owner-away boundary required before creating Mail import UI; no Mail operation performed'),
    { code: 'MAIL_IMPORT_OWNERSHIP_UNPROVED', noMutation: true });
  importer ??= openMailImport;
  ctx.signal?.throwIfAborted();
  ctx.cleanupSignal?.throwIfAborted();
  ctx.pendingAcquisitions ??= new Set();
  ctx.pendingAcquisitions.add('mailImport');
  diagnostic.actionTaken = true;
  diagnostic.cleanup = 'unconfirmed';
  try { ctx.mailImport = await importer(ctx.mail, ctx); }
  catch (error) { if (error.noMutation === true) ctx.pendingAcquisitions.delete('mailImport'); throw error; }
  const lease = ctx.mailImport;
  diagnostic.actionTaken = true;
  diagnostic.cleanup = 'unconfirmed';
  if (lease?.nonce !== ctx.nonce || lease.localOnly !== true || lease.retainedWindow !== true || lease.retainedMailbox !== true ||
    ['snapshot', 'close', 'removeMailbox', 'dispose'].some(key => typeof lease[key] !== 'function')) {
    throw new Error('Mail import requires retained window and local mailbox ownership');
  }
  baselines.set(lease, snapshotText(ctx, await lease.snapshot(), true));
  ctx.pendingAcquisitions.delete('mailImport');
}

export async function checkMailAnswer(ctx, id) {
  const baseline = ctx.mailImport && baselines.get(ctx.mailImport);
  if (!baseline) return 'Mail imported-data baseline is unavailable';
  try {
    if (snapshotText(ctx, await ctx.mailImport.snapshot()) !== baseline) return 'Mail imported mailbox changed during navigation';
  } catch (error) { return error.message; }
  let answer;
  try { answer = JSON.parse(ctx.answer); } catch { return 'Mail answer must be JSON with one answer field'; }
  return answer && Object.keys(answer).length === 1 && answer.answer === ctx.mail.answers[id] || 'Mail answer does not match the fixture';
}

export async function cleanupMailImport(ctx) {
  const lease = ctx.mailImport;
  if (!lease || lease.cleaned) return;
  let failure, collected;
  try {
    await ctx.beforeFixtureCleanup?.();
    ctx.cleanupSignal?.throwIfAborted();
    if (lease.nonce !== ctx.nonce || lease.localOnly !== true || lease.retainedWindow !== true) throw new Error('Mail retained cleanup ownership is unavailable');
    await lease.close();
    if (await lease.removeMailbox() !== true) throw new Error('Owned imported mailbox removal unconfirmed');
  } catch (error) { failure = error; }
  try { collected = await lease.dispose(); if (collected !== true) throw new Error('Mail helper collection unconfirmed'); }
  catch (error) { failure ??= error; }
  if (!failure && lease.launched === true && collected === true) {
    try { await lease.quit(); } catch (error) { failure = error; }
  }
  if (failure) throw failure;
  lease.cleaned = true;
  ctx.pendingAcquisitions?.delete('mailImport');
  baselines.delete(lease);
  const diagnostic = ctx.fixtureDiagnostics?.find(d => d.app === 'Mail');
  if (diagnostic) diagnostic.cleanup = 'closed retained fixture and removed owned mailbox';
}

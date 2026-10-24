// Downloads are data. No shell, opener, browser download preference or caller-selected path.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, lstatSync, mkdirSync, openSync, closeSync, writeSync, readSync, fstatSync, linkSync, unlinkSync, realpathSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, extname } from 'node:path';

export const DOWNLOAD_LIMIT = 32 * 1024 * 1024;
export const DOWNLOAD_SESSION_LIMIT = 128 * 1024 * 1024;
export const DOWNLOAD_MESSAGE_LIMIT = 3;
const budgets = new Map(), activeStages = new Set();
const staleAfterMs = 24 * 3600 * 1000;
const extensions = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'text/plain': '.txt', 'text/csv': '.csv', 'text/tab-separated-values': '.tsv', 'application/json': '.json' };
const refused = () => { throw Error('download refused: unsupported or executable file type'); };
export function downloadRequest(message) {
  if (typeof message?.text !== 'string' || !/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:download|save)\b(?!\s+(?:nothing|none|no|not)\b)/i.test(message.text.trim()) ||
      /\b(?:(?:not|never|don't)\s+download\b|(?:not|never|don't)\s+save\b(?![^.!?\n]*\bDownloads\b)|cancel\s+(?:that|this|the|my)?\s*(?:request|download)\b)/i.test(message.text))
    throw Error('download needs a request in the user message');
  return { downloads: !/\b(?:not|never|don't|avoid|except|without)\b/i.test(message.text) &&
    /\b(?:to|in|into)\s+(?:(?:my|the)\s+)?Downloads(?:\s+folder)?[.,!]?\s*$/i.test(message.text) };
}
function directory(path) {
  const parents = [];
  for (let at = path; ; at = dirname(at)) { parents.unshift(at); if (dirname(at) === at) break; }
  for (const at of parents) {
    try { mkdirSync(at, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(at) !== at) throw Error('download directory is unsafe');
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || stat.mode & 0o022)
    throw Error('download directory is unsafe');
  return stat;
}
function privateDirectory(path) {
  const stat = directory(path);
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw Error('download directory is unsafe');
  return stat;
}
export function downloadName(headers, url, suggested) {
  const disposition = headers['content-disposition'] ?? '';
  let name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  try { name = name && decodeURIComponent(name); } catch { name = undefined; }
  name ||= /filename="([^"]*)"/i.exec(disposition)?.[1] ?? /filename=([^;]+)/i.exec(disposition)?.[1];
  try { name ||= suggested || decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* Use the fixed name. */ }
  name = String(name || 'download').normalize('NFKC').replace(/[\\/\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '_').replace(/[ .]+$/, '') || 'download';
  if (Buffer.byteLength(name) <= 255) return name;
  // Keep both ends, including the suffix, without splitting a Unicode code point.
  const chars = [...name];
  const take = (values, budget) => { let text = ''; for (const char of values) { if (Buffer.byteLength(text + char) > budget) break; text += char; } return text; };
  return take(chars, 128) + '_' + [...take([...chars].reverse(), 126)].reverse().join('');
}
function fileType(name, claimed, head, tail) {
  // Refuse scripts, installers, disk images and executable formats even if the server calls them a document.
  if (/\.(?:app|dmg|pkg|mpkg|iso|exe|dll|com|bat|cmd|msi|scr|sh|bash|zsh|fish|command|ps1|py|rb|pl|scpt|applescript|js|mjs|cjs|html?|svg)(?:\.|$)/i.test(name) ||
      /(?:executable|x-msdownload|x-dosexec|x-apple-diskimage|x-sh|javascript|html|svg)/i.test(String(claimed)) ||
      /^(?:#!|MZ|\x7fELF)/.test(head.toString('latin1')) ||
      ['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca'].includes(head.subarray(0, 4).toString('hex')) ||
      tail.subarray(0, 4).toString() === 'koly') refused();
  const detected = head.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' :
    head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? 'image/png' :
    head.subarray(0, 3).toString('hex') === 'ffd8ff' ? 'image/jpeg' : /^GIF8[79]a/.test(head.toString('ascii')) ? 'image/gif' : undefined;
  if (detected) {
    const suffix = extname(name).toLowerCase();
    if (suffix && suffix !== extensions[detected] && !(detected === 'image/jpeg' && suffix === '.jpeg')) refused();
    return detected;
  }
  let type = String(claimed ?? '').split(';')[0].trim().toLowerCase();
  if (['application/octet-stream', 'application/vnd.ms-excel'].includes(type) && /\.csv$/i.test(name)) type = 'text/csv';
  if (!['text/plain', 'text/csv', 'text/tab-separated-values', 'application/json'].includes(type) || head.includes(0) ||
      /^\s*(?:<!doctype\s+html|<html|<script|<svg)/i.test(head.toString('utf8'))) refused();
  if (extname(name) && !/\.(?:txt|csv|tsv|json|log)$/i.test(name)) refused();
  return type;
}

function sweep(bank, log) {
  try { lstatSync(bank); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  privateDirectory(bank);
  for (const entry of readdirSync(bank)) {
    if (!/^[a-f0-9]{24}$/.test(entry)) continue;
    const folder = join(bank, entry), stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) continue;
    for (const name of readdirSync(folder)) {
      if (!/^\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.part$/.test(name)) continue;
      const path = join(folder, name);
      if (activeStages.has(path)) continue;
      try {
        const file = lstatSync(path);
        if (file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid() && (file.mode & 0o777) === 0o600 && Date.now() - file.mtimeMs > staleAfterMs)
          unlinkSync(path);
      } catch (error) { if (error.code !== 'ENOENT') log('download stale stage cleanup failed'); }
    }
  }
}
function quarantineFile(path) {
  const value = '0081;' + Math.floor(Date.now() / 1000).toString(16) + ';sleight;' + randomUUID().toUpperCase();
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, path], { stdio: 'pipe', timeout: 5000 });
}
export function createDownloadStore({ home = userInfo().homedir, limit = DOWNLOAD_LIMIT, sessionLimit = DOWNLOAD_SESSION_LIMIT,
  quarantine = quarantineFile, removeStage = unlinkSync, log = line => console.error(line) } = {}) {
  const bank = join(home, 'Library/Application Support/sleight/downloads');
  // A new page registry must not reset limits for the same authenticated session.
  const sessions = budgets.get(home) ?? new Map(); budgets.set(home, sessions);
  sweep(bank, log);
  return Object.freeze({ async save({ session, message, current, suggested, url, transfer }) {
    const request = downloadRequest(message);
    if (typeof session !== 'string' || !session || typeof current !== 'function' || !current()) throw Error('download authority expired');
    const budget = sessions.get(session) ?? { bytes: 0, messages: new Map() }; sessions.set(session, budget);
    const messageKey = message.id ?? message.text;
    if (budget.bytes >= sessionLimit) throw Error('download exceeds session byte quota');
    if ((budget.messages.get(messageKey) ?? 0) >= DOWNLOAD_MESSAGE_LIMIT) throw Error('download limit: 3 downloads per user message');
    directory(join(home, 'Library')); directory(join(home, 'Library/Application Support')); directory(join(home, 'Library/Application Support/sleight'));
    privateDirectory(bank);
    const folder = join(bank, createHash('sha256').update(session).digest('hex').slice(0, 24));
    const identity = privateDirectory(folder), stage = join(folder, '.' + randomUUID() + '.part');
    let fd, published = false;
    budget.messages.set(messageKey, (budget.messages.get(messageKey) ?? 0) + 1);
    activeStages.add(stage);
    try {
      fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      let bytes = 0, headers;
      const digest = createHash('sha256');
      await transfer(async (metadata, chunks) => {
        if (headers) throw Error('multiple download responses refused');
        headers = metadata;
        const length = headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw Error('download exceeds 32 MiB limit');
        if (length !== undefined && !headers['content-encoding'] && Number(length) > sessionLimit - budget.bytes) throw Error('download exceeds session byte quota');
        for await (const chunk of chunks) {
          if (!current()) throw Error('download authority expired');
          bytes += chunk.length;
          if (bytes > limit) throw Error('download exceeds 32 MiB limit');
          if (chunk.length > sessionLimit - budget.bytes) throw Error('download exceeds session byte quota');
          budget.bytes += chunk.length;
          digest.update(chunk);
          let written = 0;
          while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
        }
      });
      if (!headers || !current()) throw Error('download did not finish');
      if (!headers['content-encoding'] && headers['content-length'] !== undefined && bytes !== Number(headers['content-length'])) throw Error('download length mismatch');
      const proposed = downloadName(headers, url, suggested), head = Buffer.alloc(Math.min(bytes, 4096)), tail = Buffer.alloc(Math.min(bytes, 512));
      readSync(fd, head, 0, head.length, 0); readSync(fd, tail, 0, tail.length, Math.max(0, bytes - 512));
      const type = fileType(proposed, headers['content-type'], head, tail);
      // Page text and signed URL paths never become model-facing names or paths.
      const name = randomUUID().slice(0, 8) + '-' + digest.digest('hex') + extensions[type];
      const destination = request.downloads ? join(home, 'Downloads') : folder;
      const destIdentity = request.downloads ? directory(destination) : identity;
      if (destIdentity.uid !== process.getuid()) throw Error('download directory is unsafe');
      if (request.downloads) {
        try { quarantine(stage); } catch { throw Error('download quarantine failed'); }
      }
      const again = lstatSync(folder), destAgain = lstatSync(destination), source = lstatSync(stage), file = fstatSync(fd);
      if (!current() || again.ino !== identity.ino || again.dev !== identity.dev || destAgain.ino !== destIdentity.ino || destAgain.dev !== destIdentity.dev ||
          source.ino !== file.ino || source.dev !== file.dev || !source.isFile() || file.size !== bytes) throw Error('download directory changed');
      // An unpredictable prefix and exclusive hard link preserve every existing file.
      const path = join(destination, name);
      linkSync(stage, path); published = true;
      return { path, name, bytes, type };
    } finally {
      if (!published) budget.messages.set(messageKey, budget.messages.get(messageKey) - 1);
      if (fd !== undefined) closeSync(fd);
      activeStages.delete(stage);
      try { removeStage(stage); } catch (error) {
        if (error.code !== 'ENOENT') {
          if (published) { try { log('download stage cleanup failed after publication'); } catch { /* Logging cannot undo publication. */ } }
          else throw error;
        }
      }
    }
  } });
}

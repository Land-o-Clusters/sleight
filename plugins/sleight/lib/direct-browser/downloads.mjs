// Downloads are data. No shell, opener, browser download preference or caller-selected path.
import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, writeSync, readSync, fstatSync, linkSync, unlinkSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, extname } from 'node:path';

export const DOWNLOAD_LIMIT = 32 * 1024 * 1024;
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
  return name.length > 140 ? name.slice(0, 80) + '_' + name.slice(-59) : name;
}
function fileType(name, claimed, head, tail) {
  // Refuse scripts, installers, disk images and executable formats even if the server calls them a document.
  if (/\.(?:app|dmg|pkg|mpkg|iso|exe|dll|com|bat|cmd|msi|scr|sh|bash|zsh|fish|command|ps1|py|rb|pl|scpt|applescript|js|mjs|cjs|html?|svg)(?:\.|$)/i.test(name) ||
      /(?:executable|x-msdownload|x-dosexec|x-apple-diskimage|x-sh|javascript|html|svg)/i.test(String(claimed)) ||
      /^(?:#!|MZ|\x7fELF)/.test(head.toString('latin1')) ||
      ['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe','bebafeca'].includes(head.subarray(0, 4).toString('hex')) ||
      tail.subarray(0, 4).toString() === 'koly') refused();
  if (head.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (head.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (/^GIF8[79]a/.test(head.toString('ascii'))) return 'image/gif';
  let type = String(claimed ?? '').split(';')[0].trim().toLowerCase();
  if (['application/octet-stream', 'application/vnd.ms-excel'].includes(type) && /\.csv$/i.test(name)) type = 'text/csv';
  if (!['text/plain', 'text/csv', 'text/tab-separated-values', 'application/json'].includes(type) || head.includes(0) ||
      /^\s*(?:<!doctype\s+html|<html|<script|<svg)/i.test(head.toString('utf8'))) refused();
  if (extname(name) && !/\.(?:txt|csv|tsv|json|log)$/i.test(name)) refused();
  return type;
}

export function createDownloadStore({ home = userInfo().homedir, limit = DOWNLOAD_LIMIT } = {}) {
  return Object.freeze({ async save({ session, message, current, suggested, url, transfer }) {
    const request = downloadRequest(message);
    if (typeof session !== 'string' || !session || typeof current !== 'function' || !current()) throw Error('download authority expired');
    const bank = join(home, 'Library/Application Support/sleight/downloads');
    directory(join(home, 'Library')); directory(join(home, 'Library/Application Support')); directory(join(home, 'Library/Application Support/sleight'));
    privateDirectory(bank);
    const folder = join(bank, createHash('sha256').update(session).digest('hex').slice(0, 24));
    const identity = privateDirectory(folder), stage = join(folder, '.' + randomUUID() + '.part');
    let fd, published;
    try {
      fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      let bytes = 0, headers;
      await transfer(async (metadata, chunks) => {
        if (headers) throw Error('multiple download responses refused');
        headers = metadata;
        const length = headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw Error('download exceeds 32 MiB limit');
        for await (const chunk of chunks) {
          if (!current()) throw Error('download authority expired');
          bytes += chunk.length;
          if (bytes > limit) throw Error('download exceeds 32 MiB limit');
          let written = 0;
          while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
        }
      });
      if (!headers || !current()) throw Error('download did not finish');
      if (!headers['content-encoding'] && headers['content-length'] !== undefined && bytes !== Number(headers['content-length'])) throw Error('download length mismatch');
      const name = downloadName(headers, url, suggested), head = Buffer.alloc(Math.min(bytes, 4096)), tail = Buffer.alloc(Math.min(bytes, 512));
      readSync(fd, head, 0, head.length, 0); readSync(fd, tail, 0, tail.length, Math.max(0, bytes - 512));
      const type = fileType(name, headers['content-type'], head, tail);
      const destination = request.downloads ? join(home, 'Downloads') : folder;
      const destIdentity = request.downloads ? directory(destination) : identity;
      if (destIdentity.uid !== process.getuid()) throw Error('download directory is unsafe');
      const again = lstatSync(folder), destAgain = lstatSync(destination), source = lstatSync(stage), file = fstatSync(fd);
      if (!current() || again.ino !== identity.ino || again.dev !== identity.dev || destAgain.ino !== destIdentity.ino || destAgain.dev !== destIdentity.dev ||
          source.ino !== file.ino || source.dev !== file.dev || !source.isFile() || file.size !== bytes) throw Error('download directory changed');
      // An unpredictable prefix and exclusive hard link preserve every existing file.
      published = join(destination, randomUUID().slice(0, 8) + '-' + name);
      linkSync(stage, published);
      return { path: published, name, bytes, type };
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(stage); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } });
}

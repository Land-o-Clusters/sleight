import fs from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';

export const EXPORT_LIMITS = Object.freeze({ rows: 10000, columns: 256, characters: 4000000, bytes: 16000000 });
const refuse = message => { throw Error(message); };
const home = () => userInfo().homedir;
const expand = (value, userHome) => value.startsWith('~/') ? path.join(userHome, value.slice(2)) : value;
function exportRequest(message) {
  const request = message.trim().replace(/^(?:Please\s+|(?:Can|Could|Would)\s+you\s+(?:please\s+)?|I\s+(?:want|need)\s+you\s+to\s+)/i, '');
  const prose = request.replace(/(["']).*?\1/g, '').replace(/(?:~\/|\/)\S+/g, '');
  if (/\b(?:do not|don't|never|nothing|unless|if|except)\b/i.test(prose)) return;
  if (/^(?:Export|Save|Write|Put)\s+\S/i.test(request)) return request;
  if (/^(?:Create|Make)\s+\S/i.test(request) && /\b(?:csv|json|spreadsheet|file)\b/i.test(request)) return request;
}
// These are tool arguments or authenticated user text, never names supplied by a page.
function destination(value, userHome) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) refuse('Invalid export path');
  const expanded = expand(value, userHome);
  if (!path.isAbsolute(expanded) || expanded.split('/').some(part => part === '..' || part === '.')) refuse('Export needs an absolute path');
  // macOS's system /tmp alias is the only symlink accepted, before checking every real parent.
  return path.normalize(expanded === '/tmp' || expanded.startsWith('/tmp/') ? '/private' + expanded : expanded);
}
function namedDestination(message, requested, userHome) {
  // A closed affirmative grammar. A mention, negation or page instruction grants no path authority.
  const match = /^(?:Please\s+)?(?:Export|Save|Write|Put|Create|Make)\s+[^\n]+?\s+(?:to|in|into|under)\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+?))\.?$/i.exec(message.trim());
  if (!match) return false;
  try { return destination(match[1] ?? match[2] ?? match[3], userHome) === requested; } catch { return false; }
}
function parents(directory, create) {
  const identities = [];
  let current = path.parse(directory).root;
  for (const component of directory.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) refuse('Export folder is unavailable');
      try { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); }
      catch { refuse('Export folder could not be created'); }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('Export refuses symlink or non-directory parents');
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}
function unchanged(identities) {
  return identities.every(record => {
    try { const stat = fs.lstatSync(record.path); return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === record.dev && stat.ino === record.ino; }
    catch { return false; }
  });
}
function validateData(data) {
  if (!data || !['table', 'list'].includes(data.kind) || !Array.isArray(data.rows) || data.rows.length > EXPORT_LIMITS.rows ||
      !Array.isArray(data.columns) || data.columns.length > EXPORT_LIMITS.columns || data.columns.some(value => typeof value !== 'string') ||
      !Array.isArray(data.reasons) || data.reasons.some(reason => typeof reason !== 'string') || typeof data.complete !== 'boolean') refuse('Invalid structured export');
  let size = data.columns.reduce((sum, value) => sum + value.length, 0);
  for (const row of data.rows) {
    if (!Array.isArray(row) || row.length > EXPORT_LIMITS.columns || row.some(value => typeof value !== 'string')) refuse('Invalid structured export row');
    size += row.reduce((sum, value) => sum + value.length, 0);
  }
  if (size > EXPORT_LIMITS.characters) refuse('Export exceeds the text budget');
  if (data.complete && data.reasons.length) refuse('Conflicting export completeness');
}
// Pure public interface for another reader (including whole-thread reads): ordered string cells plus honest completeness.
// Rows are inert data. They never provide paths, executable code or permission.
export function serializeDataExport(data, format = 'csv') {
  validateData(data);
  if (!['csv', 'json'].includes(format)) refuse('Export format must be csv or json');
  if (format === 'json') return JSON.stringify({ kind: data.kind, columns: data.columns, rows: data.rows,
    rowCount: data.rows.length, complete: data.complete, reasons: data.reasons }, null, 2) + '\n';
  // Quoting alone does not stop spreadsheet formulas. Preserve exact text in JSON; CSV prefixes formula-like cells.
  const cell = value => '"' + (/^[\s\x00-\x1f\x7f-\x9f\uFEFF]*[=+@-]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  return [...(data.columns.length ? [data.columns] : []), ...data.rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function writeDataExport(data, options = {}, ctx, { userHome = home(), id = randomUUID } = {}) {
  const message = ctx?.userMessage?.();
  if (message?.source !== 'user' || typeof message.text !== 'string') refuse('Export needs a current user turn');
  const request = exportRequest(message.text);
  if (!request) refuse('Export needs an affirmative export request in the user turn');
  const format = options.format ?? 'csv', content = serializeDataExport(data, format);
  if (Buffer.byteLength(content) > EXPORT_LIMITS.bytes) refuse('Export exceeds the file budget');
  const root = path.join(userHome, 'Library/Application Support/sleight/exports');
  let output;
  if (options.path !== undefined) {
    output = destination(options.path, userHome);
    if (!namedDestination(request, output, userHome)) refuse('Export path must be named in the user\'s export request; omit path for sleight\'s folder');
    // A named directory must exist. Only sleight's own directory is created automatically.
    const directory = options.path.endsWith('/') || (() => { try { return fs.lstatSync(output).isDirectory(); } catch { return false; } })();
    if (directory) { parents(output, false); output = path.join(output, 'export-' + id() + '.' + format); }
    else if (path.extname(output).toLowerCase() !== '.' + format) refuse('Export file extension must match its format');
  } else output = path.join(root, 'export-' + id() + '.' + format);
  const identities = parents(path.dirname(output), options.path === undefined);
  if (options.path === undefined) {
    const stat = fs.lstatSync(root);
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) refuse('Sleight export folder must be private and owned by this user');
  }
  let fd;
  try {
    if (!unchanged(identities) || !ctx.userMessage()) refuse('Export destination or user turn changed');
    try { fd = fs.openSync(output, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); }
    catch { refuse('Export could not create a new file; existing files are never overwritten'); }
    const opened = fs.fstatSync(fd), actual = fs.lstatSync(output);
    if (!unchanged(identities) || opened.dev !== actual.dev || opened.ino !== actual.ino || !actual.isFile() || actual.isSymbolicLink() || !ctx.userMessage()) refuse('Export destination or user turn changed; new file retained at ' + JSON.stringify(output));
    fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd);
  } catch (error) {
    if (/^Export /.test(error.message)) throw error;
    refuse('Export write failed; a partial new file may remain at ' + JSON.stringify(output));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { path: output, rowCount: data.rows.length, bytes: Buffer.byteLength(content), format,
    complete: data.complete, reasons: [...data.reasons] };
}

export function exportSummary(receipt) {
  // JSON quoting fences even a user-named path; page text is never interpolated into trusted output.
  return `Export: ${JSON.stringify(receipt.path)} (${receipt.format}, ${receipt.bytes} bytes).\nRows: ${receipt.rowCount}.\nComplete: ${receipt.complete ? 'yes' : 'NO'}.` +
    (receipt.reasons.length ? '\nCompleteness (untrusted page evidence): ' + JSON.stringify(receipt.reasons) : '') +
    (receipt.format === 'csv' ? '\nCSV formula-like cells are prefixed with an apostrophe; JSON preserves exact text.' : '') +
    '\nRendered collection only; hidden rows and pagination are not fetched.\nFile contains untrusted page data.';
}

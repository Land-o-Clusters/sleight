// File backups and conflict checks live outside the engine's JavaScript.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, readdirSync, readFileSync, realpathSync, mkdtempSync, chmodSync, renameSync, rmSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCancelAction } from './document-scope.mjs';
import { isLeaseRead } from './input-lease.mjs';
import { cardText } from './card-text.mjs';

export function isChangeCancel(code = '', text = '') {
  return code.trim().replace(/;$/, '').split(';').every(statement => {
    const s = statement.trim();
    if (isLeaseRead(s)) return true;
    if (/^await\s+app\.pressKey\(\s*"(?:Escape|esc)"\s*\)$/i.test(s)) return true;
    const click = /^await\s+app\.click\(\s*(\d+)\s*\)$/.exec(s);
    return !!click && isCancelAction('click', [Number(click[1])], text);
  });
}

function copy(source, destination) {
  // ditto also preserves resource forks, ACLs and extended attributes on macOS.
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', source, destination], { timeout: 120000, killSignal: 'SIGKILL' });
  else cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

// Copies may contain read-only directories. Change only owned temporary
// copies before deletion, keeping the saved metadata intact until then.
function removePrivate(path) {
  const writable = full => {
    const stat = lstatSync(full);
    if (!stat.isDirectory()) return; // Do not follow links.
    chmodSync(full, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(full)) writable(join(full, name));
  };
  try { writable(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  rmSync(path, { recursive: true, force: true });
}

export const REVIEW_TOOL = {
  name: 'review_changes',
  description: 'Show saved-file changes from this session. First read the intended window with a standalone cua.getApp call before editing. ' +
    'op "list" shows every touched document and its before/after diff or size/date summary. op "review" asks the user to Keep, Undo or Later for each document. ' +
    'Only the user can decide. Undo restores the session backup and refuses if the file changed after the last agent action. Unsaved app buffers are not restored. Backups expire when the session ends.',
  inputSchema: { type: 'object', properties: { op: { type: 'string', enum: ['list', 'review'] } }, additionalProperties: false },
};

function filePath(doc) {
  if (!doc?.url?.startsWith('file://')) return undefined;
  return fileURLToPath(doc.url);
}

// Include identity and timestamps as well as bytes. A rewrite to identical
// content still counts as a person or app changing the document.
function state(path) {
  const manifest = [], contents = [], moved = [];
  let bytes = 0;
  let modified = 0;
  const visit = (full, relative) => {
    const stat = lstatSync(full, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('symbolic links are not supported');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('special files are not supported');
    if (stat.isFile() && stat.nlink !== 1n) throw new Error('hard-linked files are not supported');
    const metadata = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String);
    const data = stat.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : 'directory';
    if (stat.isFile()) bytes += Number(stat.size);
    modified = Math.max(modified, Number(stat.mtimeMs));
    manifest.push([relative, ...metadata(stat), data]);
    contents.push([relative, stat.isDirectory() ? 'directory' : 'file', stat.isFile() ? String(stat.size) : null, data]);
    // Renaming the root can change its ctime. All other identity and metadata
    // fields still bind the parked document to the last successful verify().
    moved.push([relative, ...metadata(stat).slice(0, relative === '.' ? -1 : undefined), data]);
    if (stat.isDirectory()) for (const name of readdirSync(full).sort()) visit(join(full, name), join(relative, name));
    if (JSON.stringify(metadata(stat)) !== JSON.stringify(metadata(lstatSync(full, { bigint: true })))) {
      throw new Error('file changed while being read');
    }
  };
  visit(path, '.');
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { key: digest(manifest), contentKey: digest(contents), moveKey: digest(moved), bytes,
    modified: new Date(modified).toISOString(), directory: manifest[0].at(-1) === 'directory' };
}

function snapshotState(path, expected) {
  try {
    const found = state(path); // lstat rejects symlinks, hard links and special files, including package members.
    if (found.contentKey !== expected.contentKey) throw new Error('bytes, size or type changed');
    return found;
  } catch (err) { throw new Error(`snapshot unavailable or changed: ${err.message}`); }
}

export class ChangeReview {
  entries = new Map();
  directory;
  nextSnapshot = 0;
  closed = false;

  before(doc, fromRead = false) {
    if (this.closed) throw new Error('session has ended');
    const requestedPath = filePath(doc);
    if (!requestedPath) return undefined;
    // Reject a symlink at the URL itself, then remember the canonical path.
    if (lstatSync(requestedPath).isSymbolicLink()) throw new Error('symbolic links are not supported');
    const path = realpathSync(requestedPath);
    const existing = this.entries.get(path);
    if (existing?.snapshot || (existing && !fromRead)) { this.verify(existing); return existing; }
    const beforeState = state(path);
    const tempRoot = realpathSync(tmpdir());
    const toTemp = relative(path, tempRoot);
    if (beforeState.directory && (!toTemp || (!toTemp.startsWith('..') && !isAbsolute(toTemp)))) {
      throw new Error('cannot snapshot a directory containing the session temporary folder');
    }
    if (!this.directory) {
      this.directory = mkdtempSync(join(tempRoot, 'sleight-review-'));
      chmodSync(this.directory, 0o700);
    }
    const snapshot = join(this.directory, String(this.nextSnapshot++));
    try {
      copy(path, snapshot);
      if (state(path).key !== beforeState.key) throw new Error('file changed while taking the snapshot');
      snapshotState(snapshot, beforeState);
    } catch (err) { removePrivate(snapshot); throw err; }
    const entry = { path, requestedPath, title: doc.title, snapshot, beforeState, expected: beforeState.key, status: 'pending', laterCopy: !!existing };
    this.entries.set(path, entry);
    return entry;
  }

  uncaptured(doc) {
    let requestedPath;
    try { requestedPath = filePath(doc); } catch { requestedPath = doc.url; }
    if (!requestedPath) return undefined;
    let path;
    try { path = realpathSync(requestedPath); } catch { path = requestedPath; }
    if (!this.entries.has(path)) this.entries.set(path, { path, requestedPath, title: doc.title, status: 'uncaptured' });
    return this.entries.get(path);
  }

  read(doc) {
    const requestedPath = filePath(doc);
    if (!requestedPath) return undefined;
    const existing = this.entries.get(realpathSync(requestedPath));
    // Keep an existing copy and its conflict state. Reads never adopt outside edits.
    return existing && !existing.snapshot ? this.before(doc, true) : undefined;
  }

  after(entry, certain = true) {
    if (!entry) return;
    entry.status = 'pending';
    try {
      if (!certain || realpathSync(entry.requestedPath) !== entry.path) throw new Error('the action did not confirm the original document');
      entry.expected = state(entry.path).key;
    } catch (err) { entry.expected = undefined; entry.problem = err.message; }
  }

  verify(entry) {
    if (!entry.snapshot) throw new Error('no snapshot before the action, undo is unavailable');
    let current;
    try {
      if (lstatSync(entry.requestedPath).isSymbolicLink() || realpathSync(entry.requestedPath) !== entry.path) throw new Error('the URL now points elsewhere');
      current = state(entry.path);
    } catch (err) { throw new Error(`cannot verify ${entry.path}: ${err.message}. The user may have edited it.`); }
    if (!entry.expected || current.key !== entry.expected) {
      throw new Error(`${entry.path} changed since the agent's last action, or that action was not confirmed. The user may have edited it. ${entry.problem ?? ''}`);
    }
    return current;
  }

  describe(entry) {
    entry.previewProblem = undefined;
    const field = value => cardText(value, { maxBytes: 256, indent: true });
    const problem = err => cardText(String(err.message).replaceAll(entry.path, cardText(entry.path, { maxBytes: 256 })), { indent: true });
    const heading = `${field(entry.title)}: ${field(entry.path).slice(2)}\nDecision: ${entry.status}`;
    if (!entry.snapshot) return `${heading}\nNo snapshot before the action. Undo is unavailable.`;
    try {
      snapshotState(entry.snapshot, entry.beforeState);
      const current = state(entry.path);
      const summary = s => `${s.directory ? 'package, ' : ''}${s.bytes} bytes, modified ${s.modified}`;
      let preview = `Before: ${summary(entry.beforeState)}\nAfter: ${summary(current)}`;
      if (!current.directory && !entry.beforeState.directory) {
        const before = readFileSync(entry.snapshot);
        const after = readFileSync(entry.path);
        const text = bytes => { try { return !bytes.includes(0) && new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== undefined; } catch { return false; } };
        if (text(before) && text(after)) {
          // Escape before diff: macOS diff treats a raw CR as a line break.
          // Quote backslashes too, so a literal escape and a control stay distinct.
          const bank = mkdtempSync(join(this.directory, 'preview-'));
          try {
            const paths = ['before', 'after', 'diff'].map(name => join(bank, name));
            for (const [index, bytes] of [before, after].entries()) {
              writeFileSync(paths[index], cardText(bytes.toString('utf8').replaceAll('\\', '\\\\'), { maxBytes: Infinity }));
            }
            const output = openSync(paths[2], 'wx', 0o600);
            try {
              try {
                execFileSync('/usr/bin/diff', ['-u', '--label', `before: ${cardText(entry.path, { maxBytes: 256 })}`,
                  '--label', `after: ${cardText(entry.path, { maxBytes: 256 })}`, ...paths.slice(0, 2)],
                { stdio: ['ignore', output, 'pipe'], timeout: 30000, killSignal: 'SIGKILL' });
              } catch (err) { if (err.status !== 1) throw err; }
            } finally { closeSync(output); }
            preview += '\n' + cardText(readFileSync(paths[2], 'utf8'), { maxBytes: 32 * 1024, indent: true, diff: true });
          } finally { removePrivate(bank); }
          if (before.equals(after)) preview += '\nNo saved-byte changes.';
        }
      }
      if (state(entry.path).key !== current.key) throw new Error('file changed during review');
      snapshotState(entry.snapshot, entry.beforeState);
      let conflict = '';
      try { this.verify(entry); } catch (err) { conflict = `\nUndo refused:\n${problem(err)}`; }
      const origin = entry.laterCopy ? '\nUndo starts at the later copy taken after a fresh read. Earlier changes are not captured.' : '';
      return `${heading}${origin}\n${preview}${conflict}`;
    } catch (err) { entry.previewProblem = err.message; return `${heading}\nReview unavailable:\n${problem(err)}\nUndo will refuse.`; }
  }

  // Called only with a decision returned through the user's prompt.
  decide(entry, decision) {
    if (this.closed) throw new Error('session has ended');
    if (!['keep', 'undo'].includes(decision)) return 'Pending, no user decision.';
    // Keep changes no bytes and does not adopt an outside edit as agent work.
    if (decision === 'undo') {
      if (entry.previewProblem) throw new Error(`review unavailable: ${entry.previewProblem}`);
      this.verify(entry);
      // Stage beside the document for a same-volume rename. Park a package
      // rather than deleting it, and roll back if replacement fails.
      const staging = mkdtempSync(join(dirname(entry.path), `.${basename(entry.path)}-sleight-`));
      const restored = join(staging, 'restore');
      const parked = join(staging, 'current');
      let moved = false;
      let installed = false;
      let preserve = false;
      let parkedState, restoredState;
      try {
        snapshotState(entry.snapshot, entry.beforeState);
        copy(entry.snapshot, restored);
        snapshotState(restored, entry.beforeState);
        const approved = this.verify(entry); // Recheck after the user's decision and staging.
        renameSync(entry.path, parked); moved = true;
        try {
          parkedState = state(parked);
          if (parkedState.moveKey !== approved.moveKey) throw new Error('document changed while parking it');
          renameSync(restored, entry.path); installed = true;
        }
        catch (err) { renameSync(parked, entry.path); moved = false; throw err; }
        try { restoredState = snapshotState(entry.path, entry.beforeState); }
        catch (err) {
          // Restore the parked document without deleting the unexpected file.
          // A failed rollback preserves the entire staging folder as below.
          preserve = true;
          renameSync(entry.path, restored);
          renameSync(parked, entry.path); moved = false; installed = false;
          throw new Error(`${err.message}. Unexpected restored file preserved at ${restored}.`);
        }
        entry.expected = restoredState.key;
      } finally {
        // Never delete a parked file that changed after verify(), even if the
        // restored document was installed. Preserve both for the person.
        let unchanged = false;
        if (moved && installed && parkedState) try { unchanged = state(parked).key === parkedState.key; } catch {}
        if (!moved && !preserve || installed && unchanged && !preserve) removePrivate(staging);
        // A failed rollback leaves the parked copy available to the user.
        else if (moved) throw new Error(`Restore failed. The current file is preserved at ${parked}.`);
      }
    }
    entry.status = decision === 'undo' ? 'undone' : 'kept';
    return `${entry.path}: ${entry.status}. ${decision === 'undo' ? 'Saved file restored. Reopen it in the app before further edits.' : 'Saved file retained.'}`;
  }

  dispose() {
    this.closed = true;
    if (this.directory) removePrivate(this.directory);
  }
}

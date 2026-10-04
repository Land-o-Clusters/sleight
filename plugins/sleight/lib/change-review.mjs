// File backups and conflict checks live outside the engine's JavaScript.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, readdirSync, readFileSync, realpathSync, mkdtempSync, chmodSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

function copy(source, destination) {
  // ditto also preserves resource forks, ACLs and extended attributes on macOS.
  if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', source, destination]);
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
  const manifest = [];
  let bytes = 0;
  let modified = 0;
  const visit = (full, relative) => {
    const stat = lstatSync(full, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('symbolic links are not supported');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('special files are not supported');
    if (stat.isFile() && stat.nlink > 1n) throw new Error('hard-linked files are not supported');
    const metadata = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].map(String);
    const data = stat.isFile() ? createHash('sha256').update(readFileSync(full)).digest('hex') : 'directory';
    if (stat.isFile()) bytes += Number(stat.size);
    modified = Math.max(modified, Number(stat.mtimeMs));
    manifest.push([relative, ...metadata(stat), data]);
    if (stat.isDirectory()) for (const name of readdirSync(full).sort()) visit(join(full, name), join(relative, name));
    if (JSON.stringify(metadata(stat)) !== JSON.stringify(metadata(lstatSync(full, { bigint: true })))) {
      throw new Error('file changed while being read');
    }
  };
  visit(path, '.');
  return { key: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), bytes,
    modified: new Date(modified).toISOString(), directory: manifest[0].at(-1) === 'directory' };
}

export class ChangeReview {
  entries = new Map();
  directory;
  closed = false;

  before(doc) {
    if (this.closed) throw new Error('session has ended');
    const requestedPath = filePath(doc);
    if (!requestedPath) return undefined;
    // Reject a symlink at the URL itself, then remember the canonical path.
    if (lstatSync(requestedPath).isSymbolicLink()) throw new Error('symbolic links are not supported');
    const path = realpathSync(requestedPath);
    const existing = this.entries.get(path);
    if (existing) { this.verify(existing); return existing; }
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
    const snapshot = join(this.directory, String(this.entries.size));
    try {
      copy(path, snapshot);
      if (state(path).key !== beforeState.key) throw new Error('file changed while taking the snapshot');
    } catch (err) { removePrivate(snapshot); throw err; }
    const entry = { path, requestedPath, title: doc.title, snapshot, beforeState, expected: beforeState.key, status: 'pending' };
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
    const heading = `${entry.title}: ${entry.path}\nDecision: ${entry.status}`;
    if (!entry.snapshot) return `${heading}\nNo snapshot before the action. Undo is unavailable.`;
    try {
      const current = state(entry.path);
      const summary = s => `${s.directory ? 'package, ' : ''}${s.bytes} bytes, modified ${s.modified}`;
      let preview = `Before: ${summary(entry.beforeState)}\nAfter: ${summary(current)}`;
      if (!current.directory && !entry.beforeState.directory) {
        const before = readFileSync(entry.snapshot);
        const after = readFileSync(entry.path);
        const text = bytes => { try { return !bytes.includes(0) && new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== undefined; } catch { return false; } };
        if (text(before) && text(after)) {
          try {
            preview += '\n' + execFileSync('/usr/bin/diff', ['-u', '--label', `before: ${entry.path}`, '--label', `after: ${entry.path}`, entry.snapshot, entry.path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
          } catch (err) {
            if (err.status !== 1) throw err;
            preview += '\n' + err.stdout;
          }
          if (before.equals(after)) preview += '\nNo saved-byte changes.';
        }
      }
      if (state(entry.path).key !== current.key) throw new Error('file changed during review');
      let conflict = '';
      try { this.verify(entry); } catch (err) { conflict = `\nUndo refused: ${err.message}`; }
      return `${heading}\n${preview}${conflict}`;
    } catch (err) { entry.previewProblem = err.message; return `${heading}\nReview unavailable: ${err.message}. Undo will refuse.`; }
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
      try {
        copy(entry.snapshot, restored);
        this.verify(entry); // Recheck after the user's decision and staging.
        renameSync(entry.path, parked); moved = true;
        try { renameSync(restored, entry.path); installed = true; }
        catch (err) { renameSync(parked, entry.path); moved = false; throw err; }
        entry.expected = state(entry.path).key;
      } finally {
        if (!moved || installed) removePrivate(staging);
        // A failed rollback leaves the parked copy available to the user.
        else throw new Error(`Restore failed. The current file is preserved at ${parked}.`);
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

import { execFile } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRuns, listRuns, readRun, runIdValid, runRoot } from './store.mjs';
import { buildRunHTML, buildRunsHTML } from './viewer.mjs';

const openBrowser = path => new Promise((resolve, reject) => execFile('/usr/bin/open', [path], { timeout: 5000 }, error => error ? reject(error) : resolve()));
const usage = 'usage: sleight-mcp runs list\n       sleight-mcp runs open <id>\n       sleight-mcp runs clear\n';
/** The launcher owns the terminal check for clear. List/open only read the bank and write a private temporary HTML file. */
export async function runsCommand(args, { root = runRoot(), out = text => process.stdout.write(text), open = openBrowser, temp = tmpdir() } = {}) {
  const [op, id] = args;
  if (!(args.length === 1 && ['list', 'clear'].includes(op) || args.length === 2 && op === 'open' && runIdValid(id))) { out(usage); return 2; }
  try {
    if (op === 'clear') { const count = await clearRuns({ root }); out(`Removed ${count} recordings. Temporary replay HTML files remain where you opened them.\n`); return 0; }
    let html;
    if (op === 'list') {
      const rows = await listRuns({ root });
      out(rows.length ? rows.map(row => `${row.id}  ${row.bytes} bytes`).join('\n') + '\n' : 'No recordings. Recording is off by default.\n');
      html = buildRunsHTML(rows);
    } else html = buildRunHTML(await readRun(id, { root }));
    const dir = await realpath(await mkdtemp(join(temp, 'sleight-run-view-'))), path = join(dir, 'replay.html');
    await writeFile(path, html, { mode: 0o600, flag: 'wx' });
    out(`Replay HTML: ${path}\n`);
    await open(path);
    return 0;
  } catch (error) { out(`runs ${op} failed: ${error.code ?? error.message}\n`); return 1; }
}

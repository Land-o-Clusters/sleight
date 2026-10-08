// Benchmark tasks. Each one sets up what it needs in a scratch folder, gives
// Claude a prompt, and checks the outcome itself (a file on disk, or the exact
// answer), never by asking Claude whether it succeeded. Prompts name no tool,
// so every arm gets the same words.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

// Calculator shows digit grouping ("1,024"), and Claude reports what it shows.
const hasNumber = (answer, n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(answer.replace(/(?<=\d)[,\u202f\u00a0 ](?=\d{3})/g, ''));

// TextEdit opens a document next to its other windows, which can sit on another
// desktop, and drag then refuses (textedit-drag 2/3 runs, 2026-10-05). Quitting
// it first puts its windows on the current desktop. It only quits a TextEdit
// with no open documents, so it never closes one.
function freshTextEdit() {
  // A hung TextEdit times out here (2026-10-05); the run then goes ahead and its check records it.
  try { execFileSync('osascript', ['-e', 'if application "TextEdit" is running then tell application "TextEdit" to if (count documents) is 0 then quit'], { timeout: 15000, stdio: 'ignore' }); }
  catch { return; }
  for (let i = 0; i < 20; i++) {
    try { execFileSync('pgrep', ['-x', 'TextEdit']); } catch { return; } // pgrep exits 1 once it's gone
    execFileSync('sleep', ['0.25']);
  }
}

// Quits Chess without leaving its windows behind. Chess restores the windows
// it had when it last quit, and a force quit keeps them, so killed runs piled up
// game windows for the owner (9 restored on 2026-10-07). Closing its windows
// first (Don't Save) and quitting normally leaves a clean state; a Chess that
// won't quit is terminated.
export function quitChess() {
  try { execFileSync('pgrep', ['-x', 'Chess']); } catch { return; } // not running
  const close = `tell application "System Events" to tell process "Chess"
    repeat 40 times
      if (count windows) is 0 then exit repeat
      set w to window 1
      try
        click (first button of w whose subrole is "AXCloseButton")
      end try
      delay 0.4
      try
        repeat with b in buttons of sheet 1 of w
          if name of b is in {"Don’t Save", "Don't Save", "Delete"} then click b
        end repeat
      end try
      delay 0.3
    end repeat
  end tell
  tell application "Chess" to quit`;
  try { execFileSync('osascript', ['-e', close], { timeout: 30000, stdio: 'ignore' }); } catch {}
  for (let i = 0; i < 20; i++) {
    try { execFileSync('pgrep', ['-x', 'Chess']); } catch { return; }
    execFileSync('sleep', ['0.25']);
  }
  try { execFileSync('pkill', ['-x', 'Chess']); } catch {}
}

// The only apps a benchmark run may approve (see approve.mjs), by name and by
// bundle ID: input leases have Claude acquire apps by bundle ID, and local tools
// ask with the identifier Claude passed (a Chess drag was declined, 2026-10-05).
// Simulator added on the owner's order (2026-10-07), with DeviceHub, which
// replaces Simulator.app in Xcode 27 (the engine asks for it as "Device Hub").
export const BENCH_APPS = ['Calculator', 'TextEdit', 'Chess', 'Simulator', 'DeviceHub', 'Device Hub', 'com.apple.calculator',
  'com.apple.TextEdit', 'com.apple.Chess', 'com.apple.iphonesimulator', 'com.apple.dt.Devices'];

// simctl from Xcode, even when xcode-select points at the Command Line Tools.
const XCODE = '/Applications/Xcode.app/Contents/Developer';
// The app that shows simulators: DeviceHub from Xcode 27, Simulator before it.
const SIM_APPS = [['DeviceHub', join(XCODE, '../Applications/DeviceHub.app')], ['Simulator', join(XCODE, 'Applications/Simulator.app')]];
function simctl(...args) {
  const env = existsSync(XCODE) ? { ...process.env, DEVELOPER_DIR: XCODE } : process.env;
  return execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', env, timeout: 180000 });
}

// A booted iPhone simulator with the app showing it open behind the other
// windows. Boots the first available iPhone when none is running.
function bootedIPhone() {
  const devices = Object.values(JSON.parse(simctl('list', 'devices', 'available', '--json')).devices).flat()
    .filter(d => d.name.startsWith('iPhone'));
  if (!devices.length) {
    throw new Error('no iPhone simulator: install an iOS runtime (xcodebuild -downloadPlatform iOS) first');
  }
  const device = devices.find(d => d.state === 'Booted') ?? devices[0];
  if (device.state !== 'Booted') simctl('boot', device.udid);
  simctl('bootstatus', device.udid, '-b');
  const [app, path] = SIM_APPS.find(([, path]) => existsSync(path)) ?? ['Simulator'];
  execFileSync('open', ['-g', ...(path ? [path] : ['-a', app])]);
  return { udid: device.udid, name: device.name, app };
}

// A one-field form on 127.0.0.1, which the simulator reaches through the
// Mac's network. The page turns off autocapitalization and autocorrect, so
// what arrives is what Claude typed. Each run gets its own server; check closes it.
const forms = new Map();
export async function serveForm(nonce) {
  const form = { received: [] };
  form.server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST') form.received.push(new URLSearchParams(body).get('message') ?? '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.method === 'POST' ? '<!doctype html><meta name="viewport" content="width=device-width"><h1>Sent</h1>'
        : '<!doctype html><meta name="viewport" content="width=device-width"><title>sleight bench</title>' +
          '<form method="post"><label>Message <input name="message" autocapitalize="off" autocorrect="off" ' +
          'autocomplete="off" spellcheck="false"></label> <button>Submit</button></form>');
    });
  });
  await new Promise(resolve => form.server.listen(0, '127.0.0.1', resolve));
  forms.set(nonce, form);
  return `http://127.0.0.1:${form.server.address().port}/`;
}

export const tasks = [
  {
    id: 'calculator-click',
    app: 'Calculator',
    prompt: () => 'Using computer use in the background, work out 17 × 23 in Calculator by clicking its buttons. Reply with only the number the display shows.',
    check: ({ answer }) => hasNumber(answer, 391) || 'answer does not contain 391',
  },
  {
    id: 'calculator-menu',
    app: 'Calculator',
    prompt: () => 'Using computer use in the background, switch Calculator to Scientific mode from its View menu, then compute 2 to the power of 10 with its buttons. Reply with only the number the display shows.',
    check: ({ answer }) => hasNumber(answer, 1024) || 'answer does not contain 1024',
  },
  {
    id: 'textedit-save',
    app: 'TextEdit',
    setup: freshTextEdit,
    prompt: ({ dir, nonce }) =>
      `Using computer use in the background, create a new TextEdit document, make it plain text (Format menu, Make Plain Text), type exactly "sleight bench ${nonce}", and save it as ${join(dir, `${nonce}.txt`)}. Then close the document.`,
    check: ({ dir, nonce }) => {
      const path = join(dir, `${nonce}.txt`);
      let text;
      try { text = readFileSync(path, 'utf8'); } catch { return `${path} was not saved`; }
      return text.trim() === `sleight bench ${nonce}` || `${path} holds ${JSON.stringify(text.slice(0, 80))}`;
    },
  },
  {
    id: 'textedit-edit',
    app: 'TextEdit',
    setup: ({ dir, nonce }) => { freshTextEdit(); writeFileSync(join(dir, `${nonce}-edit.txt`), 'alpha beta gamma\n'); },
    prompt: ({ dir, nonce }) =>
      `Using computer use in the background, open ${join(dir, `${nonce}-edit.txt`)} in TextEdit, replace the word "beta" with "delta", save, and close the document.`,
    check: ({ dir, nonce }) => {
      const text = readFileSync(join(dir, `${nonce}-edit.txt`), 'utf8');
      return text.trim() === 'alpha delta gamma' || `file holds ${JSON.stringify(text.slice(0, 80))}`;
    },
  },
  {
    id: 'textedit-drag',
    app: 'TextEdit',
    setup: ({ dir, nonce }) => { freshTextEdit(); writeFileSync(join(dir, `${nonce}-drag.txt`), 'alpha beta gamma\n'); },
    prompt: ({ dir, nonce }) =>
      `Using computer use in the background, open ${join(dir, `${nonce}-drag.txt`)} in TextEdit. Select the ` +
      'word "alpha", then drag the selection with the mouse to the end of the line so the words read ' +
      '"beta gamma alpha". Use drag and drop, not typing or cut and paste. Then save and close the document.',
    check: ({ dir, nonce }) => {
      const words = readFileSync(join(dir, `${nonce}-drag.txt`), 'utf8').trim().split(/\s+/);
      return words.join(' ') === 'beta gamma alpha' || `file holds ${JSON.stringify(words.join(' '))}`;
    },
  },
  {
    id: 'chess-drag',
    app: 'Chess',
    // Each run starts from a fresh Chess with one window: left running, games
    // and windows pile up between runs, and Chess hung once (2026-10-03). The
    // launch ignores saved windows, and the run quits Chess cleanly after.
    setup: () => {
      quitChess();
      execFileSync('open', ['-g', '-a', 'Chess', '--args', '-ApplePersistenceIgnoreState', 'YES']);
      execFileSync('sleep', ['3']);
    },
    cleanup: quitChess,
    prompt: ({ dir, nonce }) =>
      'Using computer use in the background, open Chess and start a new game. As White, move the pawn from ' +
      `e2 to e4 by dragging it with the mouse. Then save the game as ${join(dir, `${nonce}.game`)} and close the window.`,
    check: ({ dir, nonce }) => {
      const path = join(dir, `${nonce}.game`);
      let text;
      try { text = readFileSync(path, 'utf8'); } catch { return `${path} was not saved`; }
      // A .game file is a plist whose Moves string lists moves as e2e4, one per line.
      const moves = /<key>Moves<\/key>\s*<string>([^<]*)/.exec(text)?.[1].trim().split(/\s+/) ?? [];
      return moves[0] === 'e2e4' || `${path} has moves ${JSON.stringify(moves.slice(0, 4))}`;
    },
  },
  {
    id: 'simulator-form',
    app: 'Simulator',
    // Safari in the simulator opens the form, as an app under test would be
    // launched to its first screen. The check is what the server received.
    setup: async ctx => {
      ctx.sim = bootedIPhone();
      ctx.url = await serveForm(ctx.nonce);
      simctl('openurl', ctx.sim.udid, ctx.url);
    },
    prompt: ({ nonce, sim }) =>
      `Using computer use in the background, go to the ${sim.name} simulator in the ${sim.app} app, where Safari ` +
      `shows a form. Type exactly "sleight bench ${nonce}" into its Message field and tap Submit. Reply when the page says Sent.`,
    check: ({ nonce }) => {
      const form = forms.get(nonce);
      form?.server.close();
      forms.delete(nonce);
      const got = form?.received ?? [];
      return got.includes(`sleight bench ${nonce}`) || `server received ${JSON.stringify(got.slice(0, 3))}`;
    },
  },
];

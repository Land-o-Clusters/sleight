import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { windowReceipts } from './frames.mjs';

const execute = promisify(execFile);
export async function observeFixtureFrames({ appId, pid }) {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./window-frames.js', import.meta.url)),
    JSON.stringify({ appId, pid })], { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 65536 });
  const value = JSON.parse(stdout);
  if (value.ok !== true || !Array.isArray(value.receipts)) throw Error('Fixture frame observation failed');
  return value.receipts;
}

export async function withWindowFrames(result, observe = observeFixtureFrames) {
  if (result?.isError) return result;
  const selected = windowReceipts(result?.content?.[0]?.text ?? '')[0];
  if (!selected?.ok || selected.target.appId !== 'com.apple.TextEdit' || !Number.isSafeInteger(selected.identity.pid) ||
      !Number.isSafeInteger(selected.identity.windowNumber)) throw Error('Selection has no fixture identity for frame recording');
  const rows = await observe({ appId: selected.target.appId, pid: selected.identity.pid });
  const valid = r => r.target?.appId === selected.target.appId && r.identity?.pid === selected.identity.pid &&
    Number.isSafeInteger(r.identity.windowNumber) && r.identity.windowNumber > 0 && typeof r.target.title === 'string' &&
    ['x', 'y', 'width', 'height'].every(key => Number.isFinite(r.frame?.[key])) && r.frame.width > 0 && r.frame.height > 0;
  if (!rows.length || rows.length > 16 || !rows.every(valid) || new Set(rows.map(r => r.identity.windowNumber)).size !== rows.length)
    throw Error('Fixture frame receipts missing or ambiguous');
  const match = rows.filter(r => r.identity.windowNumber === selected.identity.windowNumber && r.target.title === selected.target.title && r.target.url === selected.target.url);
  if (match.length !== 1) throw Error('Selected fixture identity changed before frame recording');
  return { ...result, content: [{ ...result.content[0], text: JSON.stringify({ ...selected, frame: match[0].frame }) },
    ...rows.filter(r => r !== match[0]).map(r => ({ type: 'text', text: JSON.stringify(r) })), ...result.content.slice(1)] };
}

// Only replies to actual select_window requests may acquire frame proof. JS output cannot supply it.
export function windowFrameOutput(input, output, observe) {
  const ids = new Set(), incoming = new StringDecoder('utf8'), outgoing = new StringDecoder('utf8');
  let requests = '', replies = '';
  const onData = chunk => {
    requests += incoming.write(chunk);
    if (requests.length > 1024 * 1024) { ids.clear(); requests = ''; return; }
    let end;
    while ((end = requests.indexOf('\n')) >= 0) {
      const line = requests.slice(0, end); requests = requests.slice(end + 1);
      try { const m = JSON.parse(line); if (m.method === 'tools/call' && m.params?.name === 'select_window' && m.id !== undefined) ids.add(m.id); } catch {}
    }
  };
  input.on('data', onData);
  const stream = new Writable({ write(chunk, encoding, done) {
    replies += outgoing.write(chunk);
    const flush = async () => {
      let end;
      while ((end = replies.indexOf('\n')) >= 0) {
        const line = replies.slice(0, end); replies = replies.slice(end + 1);
        const message = JSON.parse(line);
        if (message.result && ids.delete(message.id)) {
          try { message.result = await withWindowFrames(message.result, observe); }
          catch (error) { message.result = { isError: true, content: [{ type: 'text', text: `Frame recording stopped: ${error.message}` }] }; }
        }
        output.write(JSON.stringify(message) + '\n');
      }
    };
    flush().then(() => done(), done);
  } });
  stream.once('close', () => input.removeListener('data', onData));
  return stream;
}

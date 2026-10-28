// A click on a list row outside the list's visible frame lands on whatever is drawn there. Both Safari
// form-settings runs (race-1017) cmd-clicked Japanese below the Languages list's visible rows, read
// "UI changed (value)" for the other row the call selected, and lost 10 s (r1) and 30 s (r3) to retries
// before a scroll. The relay asks the app-health helper about rows whose line the click left unchanged.
import { promptNotice } from './prompt-notice.mjs';

const ELEMENT = /^(\t*)(\d+) (.*)$/;
const CONTAINER = /^(list|table|outline|browser|collection|grid)(?= |,|$)/;
const mask = code => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
  value => ' '.repeat(value.length));
// What the helper's request line may carry: app-health reads at most 4096 bytes per line.
const LINE_CHARS = 60, REQUEST_CHARS = 3200;

// Numbered clicks in `code` whose element line is the same before and after the call, inside a list-like
// container: { handle, number, container: { number, role, body }, lines, index }, where lines are the
// container's descendants as shown (number dropped) and index is the clicked row's place among them.
export function unchangedListClicks(code, beforeLines, afterLines) {
  if (typeof code !== 'string' || !Array.isArray(beforeLines) || !Array.isArray(afterLines)) return [];
  const after = new Set(afterLines), found = [];
  for (const call of mask(code).matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*click\s*\(\s*(\d+)\s*[,)]/g)) {
    const number = Number(call[2]);
    if (found.some(click => click.number === number)) continue;
    const at = beforeLines.findIndex(line => ELEMENT.exec(line)?.[2] === call[2]);
    if (at < 0 || !after.has(beforeLines[at])) continue;
    let depth = ELEMENT.exec(beforeLines[at])[1].length, container;
    for (let i = at - 1; i >= 0 && depth > 0 && !container; i--) {
      const m = ELEMENT.exec(beforeLines[i]);
      if (!m || m[1].length >= depth) continue;
      depth = m[1].length;
      if (CONTAINER.test(m[3])) container = { at: i, depth, number: Number(m[2]), role: CONTAINER.exec(m[3])[1], body: m[3] };
    }
    if (!container) continue;
    const rows = [];
    for (let i = container.at + 1; i < beforeLines.length; i++) {
      const m = ELEMENT.exec(beforeLines[i]);
      if (!m) continue;
      if (m[1].length <= container.depth) break;
      rows.push({ number: Number(m[2]), body: m[3].slice(0, LINE_CHARS) });
    }
    const lines = rows.map(row => row.body);
    if (JSON.stringify(lines).length + container.body.length > REQUEST_CHARS) continue;
    found.push({ handle: call[1], number, container: { number: container.number, role: container.role, body: container.body.slice(0, 200) },
      lines, index: rows.findIndex(row => row.number === number) });
    if (found.length === 2) break;
  }
  return found;
}

export function offscreenNote(click, reply, prompt) {
  const pages = Number.isSafeInteger(reply.pages) && reply.pages > 0 ? Math.min(reply.pages, 20) : 1;
  return promptNotice(/* lean notice */ `sleight: ${click.number} is outside the visible part of ${click.container.number} ${click.container.role}, so this click didn't reach it. Scroll it into view with \`await ${click.handle}.scroll(${click.container.number}, "${reply.direction}", ${pages})\`, then click it again.`, prompt);
}

// Each click's helper reply, then the notes for rows found outside. A missing, slow or unsure helper adds nothing.
export async function offscreenNotes(clicks, ask, window, prompt) {
  const notes = [];
  for (const click of clicks) {
    let reply;
    try {
      reply = await ask({ app: window.appId ?? window.app, title: window.title, container: click.container.body, lines: click.lines, index: click.index });
    } catch { continue; }
    if (reply?.status === 'ok' && reply.inside === false && ['up', 'down', 'left', 'right'].includes(reply.direction)) notes.push(offscreenNote(click, reply, prompt));
  }
  return notes;
}

// The "UI changed" field read as if the click had worked; the note replaces it, and other fields stay.
export function withOffscreenNotes(content, notes) {
  if (!notes.length || !Array.isArray(content)) return content;
  const out = content.flatMap(item => {
    if (item?.type !== 'text' || typeof item.text !== 'string' || !/^sleight: UI changed \(/m.test(item.text)) return [item];
    const text = item.text.replace(/^sleight: UI changed \([^)]*\)(?:; |\.(?=\n|$))/m, 'sleight: ').replace(/^sleight: (?:\n|$)/m, '');
    return text.trim() ? [{ ...item, text }] : [];
  });
  return [...out, ...notes.map(text => ({ type: 'text', text }))];
}

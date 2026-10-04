// Publication rules for hover trials; never alter the requests sent to an app.
import { homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';

const chessTitle = () => /[\w-]+\.game\s*\|\s*[^"\\\r\n]+/g;
const embedded = value => {
  if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) return;
  try { return JSON.parse(value); } catch { /* UI text is not necessarily JSON. */ }
};
export function createHoverRedactor({ home = homedir(), username = userInfo().username } = {}) {
  const players = new Set();
  const titles = new Set();
  function collect(value) {
    if (typeof value === 'string') {
      for (const title of value.match(chessTitle()) ?? []) {
        const player = title.match(/\.game\s*\|\s*(.*?)\s+-\s+Computer\b/)?.[1];
        if (player) players.add(player);
      }
      for (const match of value.matchAll(/Window: "([^"\r\n]+)", App: Chess\./g)) titles.add(match[1]);
      const parsed = embedded(value);
      if (parsed !== undefined) collect(parsed);
    } else if (value && typeof value === 'object') {
      if ([value.app, value.owner, value.displayName].includes('Chess')) {
        for (const key of ['windowTitle', 'title', 'windowName']) if (typeof value[key] === 'string') titles.add(value[key]);
      }
      Object.values(value).forEach(collect);
    }
  }
  function redact(value) {
    if (typeof value === 'string') {
      const parsed = embedded(value);
      if (parsed !== undefined) return JSON.stringify(redact(parsed));
      let text = value.replaceAll(home, '~');
      for (const title of titles) if (title) text = text.replaceAll(title, '<chess-window-title>');
      text = text.replace(chessTitle(), '<chess-window-title>');
      text = text.replace(/(Description: home, Value: )[^\r\n\\]+/g, '$1<home-folder>');
      for (const player of players) text = text.replaceAll(player, '<chess-player>');
      return text.replaceAll(username, '<home-folder>');
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  }
  return value => { collect(value); return redact(value); };
}

export async function publishHoverImage(app, block, filename, writeImage) {
  const bytes = Buffer.from(block.data, 'base64');
  if (app === 'Chess' || app === 'TextEdit') {
    block.data = '<omitted: window titles or home-folder labels may identify the user>';
    block.sha256 = createHash('sha256').update(bytes).digest('hex');
  } else {
    await writeImage(filename, bytes);
    block.data = filename;
  }
}

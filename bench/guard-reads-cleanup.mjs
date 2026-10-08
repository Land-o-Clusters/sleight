import { pathToFileURL } from 'node:url';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const text = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const read = 'await app.getAXState({ disableDiffing: true })';
export async function closeGuardFixture(call, path) {
  const before = await call(read);
  if (before.isError && /noWindowsAvailable/.test(text(before))) return { cleanup: 'no TextEdit windows remain' };
  if (before.isError || windowFromText(text(before))?.url !== pathToFileURL(path).href) {
    throw new Error('Cleanup cannot confirm the owned document; no close sent.');
  }
  const closed = await call('await app.pressKey("super+w")');
  const observation = closed.isError && !/noWindowsAvailable/.test(text(closed)) ? await call(read) : closed;
  if (observation.isError && /noWindowsAvailable/.test(text(observation))) {
    return { cleanup: 'no TextEdit windows remain', ...(closed.isError ? { closeReadError: text(closed) } : {}) };
  }
  const after = windowFromText(text(observation));
  if (!closed.isError && after && after.url !== pathToFileURL(path).href) return { cleanup: 'close returned another document' };
  throw new Error('Fixture cleanup unconfirmed; no second close sent.');
}

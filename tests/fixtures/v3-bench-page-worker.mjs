// Host-only fixture providers for the actual V7 dispatcher and inherited IPC.
// This does not supply the V10 production trust join or exercise its rules.
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveBenchWorker } from '../../bench/turbo/v3-worker.mjs';
import { createToolDispatcher } from '../../plugins/sleight/lib/direct-browser/tools.mjs';

if (process.env.SLEIGHT_LIVE_DOM_TEST !== '1' || !process.send) throw Error('Host fixture runner required');
const { chromium } = await import(pathToFileURL(join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs')));
let context, profile, entries = new Map(), number = 0;
const origins = JSON.parse(process.env.SLEIGHT_TURBO_ORIGINS);
const snapshot = async page => ({ text: 'Untrusted local fixture:\n' + await page.locator('body').innerText(), number: ++number });
const locator = (page, ref) => {
  if (ref === 'e1') return page.getByRole('textbox', { name: 'Name' });
  if (ref === 'e2') return page.getByRole('button', { name: 'Save' });
  throw Error('Unknown fixture ref');
};
serveBenchWorker({ channel: process, async begin(event) {
  if (event.source !== 'user' || !event.text.includes('fixture')) throw Error('Original fixture task required');
  profile = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-v3-page-'));
  context = await chromium.launchPersistentContext(profile, { headless: true, serviceWorkers: 'block' });
  await context.route('**/*', route => origins.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  const pages = {
    async openTab({ url }) {
      if (!origins.includes(new URL(url).origin)) throw Error('Fixture origin required');
      const page = await context.newPage(); await page.goto(url);
      entries.set('t1', { page, state: { snapshotNo: 0, submitUnconfirmed: false } }); return { tab: 't1' };
    },
    tab(id) { if (!entries.has(id)) throw Error('Unowned tab'); return entries.get(id); },
    enqueue: (id, run) => run(pages.tab(id)),
    list: async () => [...entries].map(([tab, entry]) => ({ tab, url: entry.page.url() })),
    async close(id) { await pages.tab(id).page.close(); entries.delete(id); return { closed: true }; },
    async endTurn() { for (const entry of entries.values()) await entry.page.close(); entries.clear(); return { cleanedUp: true }; },
  };
  return createToolDispatcher({ browser: 'bbench', pages, snapshot, ctx: event,
    async runSteps(entry, steps, ctx) {
      if (ctx !== event) throw Error('Private event required');
      for (const step of steps) {
        if (step.do === 'type') await locator(entry.page, step.ref).fill(step.text);
        else if (step.do === 'click') {
          await locator(entry.page, step.ref).click();
          await entry.page.getByText('Saved ' + await locator(entry.page, 'e1').inputValue(), { exact: true }).waitFor();
        }
        else throw Error('Unsupported fixture step');
      }
      return { lines: steps.map(step => step.do + ': done'), observe: { ...await snapshot(entry.page), capturedAt: Date.now() } };
    },
    async fillFields(entry, fields, { submit }) {
      for (const field of fields) await locator(entry.page, field.ref).fill(field.value);
      if (submit) {
        await locator(entry.page, submit).click();
        await entry.page.getByText('Saved ' + await locator(entry.page, 'e1').inputValue(), { exact: true }).waitFor();
      }
      return { rows: fields.map(field => ({ ref: field.ref, status: 'set' })), submitted: submit ? { status: 'done' } : undefined };
    } });
}, async close() {
  const turboTabsLeft = entries.size;
  await context?.close();
  const tabsAfterBrowserClose = context?.pages().length ?? 0;
  if (profile) rmSync(profile, { recursive: true });
  return { revoked: true, cleanup: [], turboTabsLeft, tabsAfterBrowserClose,
    browserClosed: true, profileDeleted: !!profile && !existsSync(profile), socketsClosed: true };
} }).ready();

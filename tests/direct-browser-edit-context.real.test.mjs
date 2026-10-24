import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const enabled = process.env.SLEIGHT_EDIT_CONTEXT_REAL_TEST === '1';
const skip = !enabled && 'run the fixed bench/edit-context-real-check.mjs runner for owned headless Chromium';
const controller = new AbortController();
const editorName = 'Fixture document editor';
const denied = /not run|unconfirmed|stale|changed|focus|unavailable|delivered|read again/i;

// This application and its plaintext model are authored here. It does not load
// an editor package, competitor source, or any page outside its loopback server.
function fixtureHTML(options = {}) {
  const config = { initial: '', zeroWidth: true, virtual: false, spoof: false, stealOnKeyUp: false, paddingRows: 0, ...options };
  const padding = Array.from({ length: config.paddingRows }, (_, index) =>
    `<p>Fixture continuation row ${index}: ${'ordinary fixture text '.repeat(4)}</p>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>EditContext fixture</title>
    <style>body{margin:24px}#editor{display:block;width:${config.zeroWidth ? '0' : '480px'};height:32px;padding:0;border:0;outline:0;white-space:pre-wrap}#rendered{white-space:pre-wrap}</style>
    <main>${padding}<div id="editor" role="textbox" aria-label="${editorName}" aria-multiline="true" tabindex="0"></div>
      <input id="other" aria-label="Other fixture field"><button>Unrelated fixture marker</button>
      <pre id="rendered" aria-hidden="true"></pre></main><script>
    (() => {
      const config = ${JSON.stringify(config).replaceAll('<', '\\u003c')};
      const editor = document.getElementById('editor'), other = document.getElementById('other');
      const state = { model: config.initial, updates: [], selectAllDowns: 0, selectAllUps: 0,
        keys: [], spoofReads: 0, contexts: 0, base: 0 };
      let context;
      function render() { document.getElementById('rendered').textContent = state.model; }
      function attach(virtual = false) {
        state.base = virtual ? Math.max(0, state.model.indexOf('VISIBLE')) : 0;
        const buffer = virtual ? state.model.slice(state.base, state.base + 7) : state.model;
        context = new EditContext({ text: buffer, selectionStart: buffer.length, selectionEnd: buffer.length });
        state.contexts++;
        const attached = context;
        attached.addEventListener('textupdate', event => {
          const start = state.base + event.updateRangeStart, end = state.base + event.updateRangeEnd;
          state.model = state.model.slice(0, start) + event.text + state.model.slice(end);
          state.updates.push({ text: event.text, start, end, trusted: event.isTrusted,
            selectAllUps: state.selectAllUps, context: state.contexts });
          render();
        });
        editor.editContext = attached;
      }
      editor.addEventListener('keydown', event => {
        state.keys.push({ phase: 'down', key: event.key, trusted: event.isTrusted });
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); state.selectAllDowns++;
          // The application owns the full model. A virtual window expands only
          // in response to the real SelectAll command, never a test-side fill.
          context.updateText(0, context.text.length, state.model); state.base = 0;
          context.updateSelection(0, state.model.length);
        }
      });
      editor.addEventListener('keyup', event => {
        state.keys.push({ phase: 'up', key: event.key, trusted: event.isTrusted });
        if (event.key.toLowerCase() === 'a') {
          state.selectAllUps++;
          if (config.stealOnKeyUp) other.focus();
        }
      });
      if (config.spoof) {
        Object.defineProperty(editor, 'editContext', { configurable: true, get() {
          state.spoofReads++; return { text: state.model, selectionStart: 0, selectionEnd: state.model.length,
            attachedElements() { return [editor]; }, updateText() {}, updateSelection() {} };
        } });
      } else attach(config.virtual);
      window.fixture = {
        read() { return { ...state, keys: [...state.keys], updates: [...state.updates],
          contextText: context?.text ?? null, selectionStart: context?.selectionStart ?? null,
          selectionEnd: context?.selectionEnd ?? null, active: document.activeElement.id, other: other.value }; },
        swapContext() { attach(false); editor.focus(); },
        restrict(attribute) { editor.setAttribute(attribute, attribute.startsWith('aria-') ? 'true' : ''); }
      };
      render(); editor.focus();
    })();</script>`;
}

function printedRef(result, name = editorName) {
  const rows = result.text.split('\n').filter(line => line.includes(JSON.stringify(name)) && /\[ref=/.test(line));
  assert.equal(rows.length, 1, `expected one exact fixture editor row:\n${result.text}`);
  const ref = /\[ref=([^\]]+)\]/.exec(rows[0])?.[1];
  assert.ok(ref, `missing fixture ref in ${rows[0]}`);
  return { ref, row: rows[0] };
}

test('real native EditContext acquisition and input remain bound to the delivered editor',
  { skip, timeout: 180000, signal: controller.signal }, async t => {
    const [{ loadPlaywrightCore }, snapshots, { createV3Context, createV3TurnBinding },
      { createActionRunner }, { check }, { createFillFields }] = await Promise.all([
      import('../plugins/sleight/lib/direct-browser/worlds.mjs'),
      import('../plugins/sleight/lib/direct-browser/snapshot.mjs'),
      import('../plugins/sleight/lib/direct-browser/v3-context.mjs'),
      import('../plugins/sleight/lib/direct-browser/act.mjs'),
      import('../plugins/sleight/lib/direct-browser/rules.mjs'),
      import('../plugins/sleight/lib/direct-browser/fill.mjs'),
    ]);
    assert.equal(typeof snapshots.keyboardRefBinding, 'function', 'native keyboard ref acquisition must be integrated');
    const pin = JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url)))
      .browsers.find(browser => browser.name === 'chromium-headless-shell');
    const platform = process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64';
    const executablePath = join(homedir(), 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + pin.revision,
      'chrome-headless-shell-' + platform, 'chrome-headless-shell');
    assert.ok(existsSync(executablePath), 'the pinned headless Chromium is required; an enabled run must not skip');
    const bank = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-edit-context-real-'));
    const sockets = new Set(), routes = new Map();
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      const body = routes.get(request.url);
      response.statusCode = body === undefined ? 404 : 200;
      response.end(body ?? 'Unknown synthetic fixture');
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    let context, closing, launched = false, sequence = 0;
    const closeBrowser = () => context ? (closing ??= context.close()) : Promise.resolve();
    const closeAfterAbort = () => { void closeBrowser().catch(error => t.diagnostic('owned browser cleanup failed: ' + error.message)); };
    const stop = () => {
      controller.abort(Error('EditContext fixture interrupted'));
      process.exitCode = 130;
      closeAfterAbort();
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    t.signal.addEventListener('abort', closeAfterAbort, { once: true });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const runtime = loadPlaywrightCore({ turbo: true });
      context = await runtime.inprocess.playwright.chromium.launchPersistentContext(join(bank, 'profile'), {
        executablePath, headless: true, viewport: { width: 1000, height: 800 },
      });
      launched = true;
      if (controller.signal.aborted || t.signal.aborted) throw controller.signal.reason ?? t.signal.reason;
      const origin = 'http://127.0.0.1:' + server.address().port;
      const runSteps = createActionRunner({ check, snapshot: snapshots.snapshot });
      const fillFields = createFillFields({ check, runSteps });

      async function fixture(st, options) {
        const path = '/fixture-' + (++sequence);
        routes.set(path, fixtureHTML(options));
        const page = await context.newPage();
        let current = true;
        const binding = createV3TurnBinding({ source: 'user', session: 'edit-context-fixture',
          turn: 'turn-' + sequence, id: 'request-' + sequence, text: 'Replace the text in the fixture document editor.' }, () => current);
        const ctx = createV3Context({ binding, browser: 'bfixture' });
        st.after(async () => {
          current = false;
          try { await ctx.dispose(); }
          finally { try { await page.close(); } finally { routes.delete(path); } }
        });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + path);
        assert.equal(await page.evaluate(() => typeof EditContext), 'function', 'pinned Chromium must implement native EditContext');
        assert.deepEqual(errors, [], 'synthetic app must initialize without page errors');
        const tab = { page, state: { snapshotNo: 0, submitUnconfirmed: false } };
        const read = async ({ deliver = true, ...options } = {}) => {
          const result = await snapshots.snapshot(page, options);
          tab.state.snapshotNo = result.number;
          if (deliver) assert.equal(snapshots.acknowledgeSnapshot(page, result.number), true);
          return result;
        };
        return { page, ctx, tab, read, url: origin + path, model: () => page.evaluate(() => window.fixture.read()),
          run: steps => runSteps(tab, steps, ctx, { observe: 'none' }) };
      }

      await t.test('empty zero-width native editor receives an ACK-gated keyboard-only ref', async st => {
        const f = await fixture(st);
        const first = await f.read({ deliver: false }), { ref, row } = printedRef(first);
        assert.match(ref, /^x\d+$/); assert.match(row, /\[active\]/); assert.match(row, /\[keyboard-only\]/);
        assert.throws(() => snapshots.keyboardRefBinding(f.page, ref), /delivered|stale|unavailable|read/i);
        const beforeACK = await f.run([{ do: 'type', ref, text: 'must not insert' }]);
        assert.match(beforeACK.lines.join('\n'), denied);
        assert.deepEqual((await f.model()).updates, []);
        // A refused action may take its own observation. Deliver a fresh read;
        // an older receipt must not override any authority that read revoked.
        const current = printedRef(await f.read()).ref;
        const bound = snapshots.keyboardRefBinding(f.page, current);
        assert.equal(bound.frame, f.page.mainFrame()); assert.equal(bound.keyboardOnly, true);
        assert.ok(Number.isInteger(bound.backendNodeId) && bound.backendNodeId > 0);
        assert.ok(bound.context, 'the binding must retain the native context object');
        const typed = await f.run([{ do: 'type', ref: current, text: 'Native input' }]);
        assert.equal(typed.stoppedAt, null, typed.lines.join('\n'));
        const state = await f.model();
        assert.equal(state.model, 'Native input'); assert.equal(state.updates.length, 1);
        assert.equal(state.updates[0].trusted, true); assert.equal(state.selectAllDowns, 1);
        assert.equal(state.selectAllUps, 1); assert.equal(state.updates[0].selectAllUps, 1);
      });

      await t.test('native keyboard replacement retains exact Unicode, newlines and an empty value', async st => {
        const f = await fixture(st, { initial: 'Retained original text' });
        for (const value of ['naïve 👩🏽‍💻 漢字 e\u0301', 'first\nsecond\n', '']) {
          const { ref } = printedRef(await f.read());
          const before = (await f.model()).updates.length;
          const result = await f.run([{ do: 'type', ref, text: value }]);
          assert.equal(result.stoppedAt, null, result.lines.join('\n'));
          const state = await f.model();
          assert.equal(state.model, value);
          assert.equal(state.updates.length, before + 1, 'one replacement must not replay');
          assert.ok(state.updates.every(update => update.trusted));
          assert.ok(state.keys.every(event => event.key !== 'Enter'), 'newlines use text insertion, never Enter');
        }
      });

      await t.test('a scoped snapshot preserves the exact keyboard ref and its existing delivery ACK', async st => {
        const f = await fixture(st, { initial: 'Scoped original' });
        const { ref } = printedRef(await f.read());
        const before = snapshots.keyboardRefBinding(f.page, ref);
        const scoped = await f.read({ ref, deliver: false });
        assert.equal(printedRef(scoped).ref, ref);
        const after = snapshots.keyboardRefBinding(f.page, ref);
        assert.equal(after.frame, before.frame); assert.equal(after.backendNodeId, before.backendNodeId);
        assert.equal(after.generation, before.generation);
        assert.equal(snapshots.acknowledgeSnapshot(f.page, scoped.number), true);
        const result = await f.run([{ do: 'type', ref, text: 'Scoped replacement' }]);
        assert.equal(result.stoppedAt, null, result.lines.join('\n'));
        const state = await f.model();
        assert.equal(state.model, 'Scoped replacement'); assert.equal(state.other, '');
        assert.equal(state.updates.length, 1); assert.equal(state.updates[0].trusted, true);
      });

      await t.test('a clipped continuation retains the keyboard row but cannot grant input before its delivery ACK', async st => {
        const f = await fixture(st, { initial: 'Continuation original', paddingRows: 28 });
        const full = await f.read({ maxChars: 40000, deliver: false });
        const expected = printedRef(full).ref;
        let part = await f.read({ maxChars: 1000, deliver: false }), pages = 1;
        assert.doesNotMatch(part.text, /\[ref=x\d+\]/, 'fixture must place the keyboard row after the first cut');
        // A receipt for the earlier full read must not restore a row omitted by
        // the current cut. Only the continuation that actually prints it can.
        snapshots.acknowledgeSnapshot(f.page, full.number);
        for (;;) {
          const printed = part.text.split('\n').some(line => line.includes(JSON.stringify(editorName)) && /\[ref=x\d+\]/.test(line));
          assert.throws(() => snapshots.keyboardRefBinding(f.page, expected), /delivered|stale|unavailable|read/i);
          if (printed) {
            assert.equal(printedRef(part).ref, expected, 'fresh native reproof must keep the continuation source stable');
            break;
          }
          assert.equal(snapshots.acknowledgeSnapshot(f.page, part.number), true);
          assert.throws(() => snapshots.keyboardRefBinding(f.page, expected), /delivered|stale|unavailable|read/i);
          const continuation = /Continue with ref="([^"]+)"/.exec(part.text)?.[1];
          assert.ok(continuation, 'continuation ended before the keyboard editor row');
          assert.ok(pages++ < 24, 'continuation must make bounded progress');
          part = await f.read({ ref: continuation, maxChars: 1000, deliver: false });
        }
        assert.ok(pages > 1);
        assert.equal(snapshots.acknowledgeSnapshot(f.page, part.number), true);
        const bound = snapshots.keyboardRefBinding(f.page, expected);
        assert.equal(bound.frame, f.page.mainFrame()); assert.equal(bound.keyboardOnly, true);
        const result = await f.run([{ do: 'type', ref: expected, text: 'Continuation replacement' }]);
        assert.equal(result.stoppedAt, null, result.lines.join('\n'));
        const state = await f.model();
        assert.equal(state.model, 'Continuation replacement'); assert.equal(state.other, '');
        assert.equal(state.updates.length, 1); assert.equal(state.updates[0].trusted, true);
      });

      await t.test('positive-width native editor keeps an ordinary ref and uses ctx.typeTarget', async st => {
        const f = await fixture(st, { initial: 'Original positive-width text', zeroWidth: false });
        const { ref, row } = printedRef(await f.read());
        assert.match(ref, /^(?:f\d+)?e\d+$/); assert.doesNotMatch(row, /keyboard-only/);
        const target = { page: f.page, state: f.tab.state, locator: f.page.getByRef(ref), ref, do: 'type' };
        assert.equal((await f.ctx.check('type', target)).verdict, 'allow');
        assert.equal(typeof f.ctx.typeTarget, 'function');
        await f.ctx.typeTarget(target, 'Positive-width replacement\n完整', { timeout: 3000 });
        const state = await f.model();
        assert.equal(state.model, 'Positive-width replacement\n完整');
        assert.equal(state.selectAllDowns, 1); assert.equal(state.selectAllUps, 1);
        assert.equal(state.updates.length, 1); assert.equal(state.updates[0].trusted, true);
      });

      for (const zeroWidth of [true, false]) {
        await t.test('fill replaces the complete native EditContext model; zeroWidth=' + zeroWidth, async st => {
          const f = await fixture(st, { initial: 'Original fill model', zeroWidth });
          const { ref } = printedRef(await f.read());
          assert.match(ref, zeroWidth ? /^x\d+$/ : /^(?:f\d+)?e\d+$/);
          const value = 'Filled through browser_fill\n👩🏽‍💻';
          const result = await fillFields(f.tab, [{ ref, value }], {}, f.ctx);
          assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
          assert.equal(result.submitted.status, 'not requested');
          const state = await f.model();
          assert.equal(state.model, value); assert.equal(state.other, '');
          assert.equal(state.updates.length, 1); assert.equal(state.updates[0].trusted, true);
          assert.equal(state.selectAllDowns, 1); assert.equal(state.selectAllUps, 1);
          assert.ok(state.keys.every(event => event.key !== 'Enter'));
        });
      }

      await t.test('a checked positive-width target cannot silently adopt a replacement context', async st => {
        const f = await fixture(st, { initial: 'Keep the checked model', zeroWidth: false });
        const { ref } = printedRef(await f.read());
        const target = { page: f.page, state: f.tab.state, locator: f.page.getByRef(ref), ref, do: 'type' };
        assert.equal((await f.ctx.check('type', target)).verdict, 'allow');
        await f.page.evaluate(() => window.fixture.swapContext());
        await assert.rejects(f.ctx.typeTarget(target, 'must not insert', { timeout: 3000 }), /EDIT_CONTEXT_CHANGED|CHECKED_FOCUS_REQUIRED|TRUSTED_TARGET_REQUIRED/);
        const state = await f.model();
        assert.equal(state.model, 'Keep the checked model'); assert.deepEqual(state.updates, []);
        assert.equal(state.selectAllDowns, 0);
      });

      await t.test('keyboard-only refs cannot send pointer or activation input', async st => {
        const f = await fixture(st, { initial: 'Keyboard-only model' });
        const { ref } = printedRef(await f.read());
        await assert.rejects(f.run([{ do: 'click', ref }]), error =>
          error.notRun === true && /keyboard-only refs support only type, paste and press/.test(error.message));
        for (const key of ['Enter', 'Space']) {
          const current = printedRef(await f.read()).ref;
          const result = await f.run([{ do: 'press', ref: current, key }]);
          assert.match(result.lines.join('\n'), denied);
        }
        const state = await f.model();
        assert.equal(state.model, 'Keyboard-only model'); assert.deepEqual(state.keys, []);
        assert.deepEqual(state.updates, []);
      });

      await t.test('virtual EditContext text does not truncate whole-model replacement', async st => {
        const initial = 'Retained prefix\nVISIBLE\nRetained suffix';
        const f = await fixture(st, { initial, virtual: true });
        const before = await f.model();
        assert.equal(before.contextText, 'VISIBLE'); assert.equal(before.model, initial);
        const { ref } = printedRef(await f.read());
        const result = await f.run([{ do: 'type', ref, text: 'Whole model replacement' }]);
        assert.equal(result.stoppedAt, null, result.lines.join('\n'));
        const after = await f.model();
        assert.equal(after.model, 'Whole model replacement');
        assert.equal(after.updates.length, 1);
        assert.deepEqual([after.updates[0].start, after.updates[0].end], [0, initial.length]);
        assert.equal(after.selectAllDowns, 1); assert.equal(after.selectAllUps, 1);
      });

      await t.test('a page-supplied EditContext getter cannot acquire the native capability', async st => {
        const f = await fixture(st, { initial: 'Unchanged spoof model', spoof: true, zeroWidth: false });
        const result = await f.read();
        assert.doesNotMatch(result.text, /\[ref=x\d+\]/);
        const { ref } = printedRef(result);
        const attempted = await f.run([{ do: 'type', ref, text: 'must not insert' }]);
        assert.match(attempted.lines.join('\n'), denied);
        const state = await f.model();
        assert.equal(state.model, 'Unchanged spoof model'); assert.deepEqual(state.updates, []);
        assert.equal(state.spoofReads, 0, 'production must not consult the page-owned getter');
      });

      for (const attribute of ['hidden', 'readonly', 'disabled', 'aria-readonly', 'aria-disabled', 'inert']) {
        await t.test(attribute + ' revokes native EditContext input and keyboard acquisition', async st => {
          const f = await fixture(st, { initial: 'Do not change' });
          const { ref } = printedRef(await f.read());
          await f.page.evaluate(attribute => window.fixture.restrict(attribute), attribute);
          const attempted = await f.run([{ do: 'type', ref, text: 'must not insert' }]);
          assert.match(attempted.lines.join('\n'), denied);
          const state = await f.model();
          assert.equal(state.model, 'Do not change'); assert.deepEqual(state.updates, []);
          assert.equal(state.selectAllDowns, 0, 'ineligible input must stop before SelectAll');
          assert.doesNotMatch((await f.read()).text, /\[ref=x\d+\]/);
        });
      }

      await t.test('navigation retires a delivered keyboard ref', async st => {
        const f = await fixture(st, { initial: 'Fresh document' });
        const { ref } = printedRef(await f.read());
        await f.page.goto(f.url);
        const attempted = await f.run([{ do: 'type', ref, text: 'must not insert' }]);
        assert.match(attempted.lines.join('\n'), denied);
        assert.equal((await f.model()).model, 'Fresh document');
        assert.deepEqual((await f.model()).updates, []);
        assert.notEqual(printedRef(await f.read()).ref, ref);
      });

      await t.test('same-node native context replacement refuses the old binding', async st => {
        const f = await fixture(st, { initial: 'Same DOM element' });
        const { ref } = printedRef(await f.read());
        await f.page.evaluate(() => window.fixture.swapContext());
        const attempted = await f.run([{ do: 'type', ref, text: 'must not insert' }]);
        assert.match(attempted.lines.join('\n'), denied);
        assert.equal((await f.model()).model, 'Same DOM element'); assert.deepEqual((await f.model()).updates, []);
        const next = printedRef(await f.read()).ref;
        assert.notEqual(next, ref);
        const result = await f.run([{ do: 'type', ref: next, text: 'New binding' }]);
        assert.equal(result.stoppedAt, null, result.lines.join('\n'));
        assert.equal((await f.model()).model, 'New binding');
      });

      await t.test('a filtered omission revokes prior delivery and an older ACK cannot refresh the keyboard ref', async st => {
        const f = await fixture(st, { initial: 'Keep this text' });
        const { ref } = printedRef(await f.read());
        const olderPending = await f.read({ deliver: false });
        assert.equal(printedRef(olderPending).ref, ref);
        const filtered = await f.read({ find: 'Unrelated fixture marker' });
        assert.doesNotMatch(filtered.text, /\[ref=x\d+\]/);
        assert.throws(() => snapshots.keyboardRefBinding(f.page, ref), /stale|unavailable|delivered|read/i);
        snapshots.acknowledgeSnapshot(f.page, olderPending.number);
        assert.throws(() => snapshots.keyboardRefBinding(f.page, ref), /stale|unavailable|delivered|read/i);
        const pending = await f.read({ deliver: false });
        const next = printedRef(pending).ref;
        assert.equal(next, ref, 'the unchanged native identity may retain its ref without retaining delivery authority');
        const attempted = await f.run([{ do: 'type', ref: next, text: 'must not insert' }]);
        assert.match(attempted.lines.join('\n'), denied);
        assert.equal((await f.model()).model, 'Keep this text'); assert.deepEqual((await f.model()).updates, []);
      });

      await t.test('SelectAll key-up focus theft blocks insertion without replay', async st => {
        const f = await fixture(st, { initial: 'Keep the original', stealOnKeyUp: true });
        const { ref } = printedRef(await f.read());
        const result = await f.run([{ do: 'type', ref, text: 'must not reach either field' }]);
        assert.match(result.lines.join('\n'), denied);
        const state = await f.model();
        assert.equal(state.selectAllDowns, 1); assert.equal(state.selectAllUps, 1);
        assert.equal(state.active, 'other'); assert.equal(state.other, '');
        assert.equal(state.model, 'Keep the original'); assert.deepEqual(state.updates, []);
        st.diagnostic('This covers synchronous key-up focus theft detected before insertion; it does not prove atomic protection against every later malicious race.');
      });
    } finally {
      try {
        await closeBrowser();
        if (launched) {
          removeTemp(bank);
          if (keepTemp()) t.diagnostic('owned headless Chromium closed; private profile retained by SLEIGHT_KEEP_TEMP: ' + bank);
          else {
            assert.equal(existsSync(bank), false, 'browser closed but private profile cleanup was not confirmed: ' + bank);
            t.diagnostic('owned headless Chromium closed and private profile removed');
          }
        }
        else t.diagnostic('browser launch did not complete; retained private bank for diagnosis: ' + bank);
      } finally {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        process.off('SIGINT', stop); process.off('SIGTERM', stop);
        t.signal.removeEventListener('abort', closeAfterAbort);
      }
    }
  });

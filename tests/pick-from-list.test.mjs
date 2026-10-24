import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pickFromList, pickFromListCode } from '../plugins/sleight/lib/pick-from-list.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(labels, { top = 0, height = 100, rowHeight = 20, disabled = [], duplicate = false, stalls = false, verify = true } = {}) {
  const calls = [], clicks = [], selected = [], optionScrolls = [];
  let offset = top, attached = true;
  const root = { clientHeight: 800, clientWidth: 1000 };
  const document = { documentElement: root };
  const options = labels.map((text, i) => ({ textContent: text, selected: false,
    getAttribute: key => key === 'aria-disabled' ? String(disabled.includes(text)) :
      key === 'aria-selected' ? String(selected.includes(text)) : null,
    getBoundingClientRect: () => ({ x: 100, y: 100 + i * rowHeight - offset, width: 200, height: rowHeight }),
    scrollIntoView: opts => { optionScrolls.push({ text, ...opts }); } }));
  const list = { get scrollTop() { return offset; }, scrollHeight: labels.length * rowHeight, clientHeight: height,
    getAttribute: () => null, querySelector: () => null,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 200, height }),
    querySelectorAll: () => options.filter((el, i) => i * rowHeight >= offset - rowHeight && i * rowHeight < offset + height + rowHeight) };
  const locator = { count: async () => attached ? 1 : 0,
    evaluate: async (fn, arg) => {
      if (/\.click\s*\(|innerHTML\s*=/.test(fn.toString())) throw new Error('evaluate is read-only');
      return runInNewContext('(' + fn.toString() + ')(list, arg)', { list, document, arg });
    },
    getByRole: (role, { name, exact }) => {
      assert.equal(role, 'option'); assert.equal(exact, true);
      return { count: async () => duplicate ? 2 : labels.filter(text => text === name).length,
        click: async () => {
          const i = labels.indexOf(name);
          assert.ok(i * rowHeight + rowHeight > offset && i * rowHeight < offset + height, 'only rendered options can be clicked');
          clicks.push(name);
          if (verify) selected.splice(0, selected.length, name);
        } };
    },
  };
  const tab = { playwright: {
    locator: selector => selector === '#list' ? locator : { count: async () => 0 },
    getByRole: (role, { name, exact } = {}) => {
      if (['listbox', 'combobox', 'list'].includes(role) && name === 'Departing from') {
        assert.equal(exact, true);
        return locator;
      }
      return { count: async () => 0 };
    },
    getByLabel: (name, options) => {
      if (name === 'Departing from') { assert.equal(options?.exact, true); return locator; }
      return { count: async () => 0 };
    },
  },
    cua: {
      scroll: async ({ x, y, scrollX, scrollY }) => {
        calls.push({ x, y, scrollX, scrollY });
        assert.ok(x > 100 && x < 300 && y > 100 && y < 100 + height);
        assert.ok(Number.isFinite(scrollY) && scrollY !== 0);
        if (!stalls) offset = Math.max(0, Math.min(labels.length * rowHeight - height, offset + scrollY));
      },
    } };
  return { tab, locator, calls, clicks, selected, list, optionScrolls, detach: () => { attached = false; } };
}

test('a rendered option is selected exactly and read back without scrolling', async () => {
  for (const useLocator of [false, true]) {
    const h = fixture(['Alpha', 'Beta', 'Gamma']);
    const result = await pickFromList(h.tab, useLocator ? h.locator : '#list', 'Beta');
    assert.equal(result.found, true); assert.equal(result.verified, true);
    assert.deepEqual(Array.from(result.selected), ['Beta']);
    assert.deepEqual(h.clicks, ['Beta']); assert.equal(h.calls.length, 0);
  }
});

test('a sorted virtualized list uses bisection to find a distant option', async () => {
  const labels = Array.from({ length: 1000 }, (_, i) => 'Option ' + String(i).padStart(4, '0'));
  const h = fixture(labels);
  const result = await pickFromList(h.tab, '#list', 'Option 0876');
  assert.equal(result.verified, true);
  assert.ok(h.calls.length > 0 && h.calls.length <= 14, String(h.calls.length));
  assert.ok(Math.abs(h.calls[0].scrollY) > 800, 'the first scroll bisects rather than scanning every page');
  assert.deepEqual(h.clicks, ['Option 0876']);
});

test('descending lists bisect and an unsorted list scans with overlapping steps', async () => {
  const labels = Array.from({ length: 200 }, (_, i) => 'Option ' + String(199 - i).padStart(3, '0'));
  const sorted = fixture(labels);
  assert.equal((await pickFromList(sorted.tab, '#list', 'Option 019')).verified, true);
  const h = fixture(['Zulu', 'Alpha', 'Echo', 'Beta', 'Mike', 'Delta', 'Oscar', 'Foxtrot', 'Tango', 'Hotel', 'India', 'Juliet']);
  const result = await pickFromList(h.tab, '#list', 'India');
  assert.equal(result.verified, true); assert.ok(h.calls.length > 0);
  assert.ok(h.calls.every(call => Math.abs(call.scrollY) <= 0.125 * 800));
});

test('a search starting midway scans earlier options when the list is unsorted', async () => {
  const h = fixture(['Zulu', 'Alpha', 'Echo', 'Beta', 'Mike', 'Delta', 'Oscar', 'Foxtrot', 'Tango', 'Hotel'], { top: 100 });
  const result = await pickFromList(h.tab, '#list', 'Alpha');
  assert.equal(result.verified, true); assert.ok(h.calls.some(call => call.scrollY < 0));
});

test('missing options and a stalled scroll fail with observed labels and scroll position', async () => {
  for (const stalls of [false, true]) {
    const h = fixture(Array.from({ length: 20 }, (_, i) => 'Option ' + String(i).padStart(2, '0')), { stalls });
    const result = await pickFromList(h.tab, '#list', 'Missing');
    assert.equal(result.found, false); assert.equal(result.verified, false);
    assert.ok(result.seen.includes('Option 00')); assert.ok(Number.isFinite(result.position));
    assert.match(result.note, /not clicked|no option clicked/i);
    assert.ok(h.calls.length <= 24); assert.deepEqual(h.clicks, []);
  }
});

test('the search cap bounds an unsorted list without guessing a match', async () => {
  const labels = Array.from({ length: 10000 }, (_, i) => ['Zulu', 'Alpha', 'Mike'][i % 3] + i);
  const h = fixture(labels);
  const result = await pickFromList(h.tab, '#list', 'Missing');
  assert.equal(result.found, false); assert.match(result.note, /cap|24/);
  assert.ok(h.calls.length <= 24); assert.deepEqual(h.clicks, []);
});

test('a prefix seen before the scroll cap never stands in for an exact option the search did not reach', async () => {
  // AS-4: an unsorted list scans in small steps, so 24 scrolls cover only part of it; the exact row is last.
  const labels = ['Portland International PDX', 'Zulu', 'Alpha', ...Array.from({ length: 997 }, (_, i) => 'Other ' + i), 'Portland'];
  const h = fixture(labels);
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, false); assert.equal(result.verified, false);
  assert.match(result.note, /cap/); assert.deepEqual(h.clicks, []);
});

test('ambiguous or disabled options send no click, and list and text inputs are validated', async () => {
  for (const settings of [{ duplicate: true }, { disabled: ['Beta'] }]) {
    const h = fixture(['Alpha', 'Beta', 'Gamma'], settings);
    const result = await pickFromList(h.tab, '#list', 'Beta');
    assert.equal(result.verified, false); assert.match(result.note, /ambiguous|disabled/);
    assert.deepEqual(h.clicks, []);
  }
  const h = fixture(['Alpha']);
  await assert.rejects(pickFromList(h.tab, '#missing', 'Alpha'), /exactly one/);
  await assert.rejects(pickFromList(h.tab, { count: async () => 2 }, 'Alpha'), /exactly one/);
  await assert.rejects(pickFromList(h.tab, '#list', ''), /text/);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.clicks, []);
});

test('a click without selection proof is reported unverified and is never retried', async () => {
  const h = fixture(['Alpha', 'Beta'], { verify: false });
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.equal(result.found, true); assert.equal(result.verified, false);
  assert.deepEqual(Array.from(result.selected), []); assert.deepEqual(h.clicks, ['Beta']);
  assert.ok(result.seen.includes('Beta')); assert.ok(Number.isFinite(result.position));
  const detached = fixture(['Alpha', 'Beta']);
  detached.locator.getByRole = () => ({ count: async () => 1, click: async () => detached.detach() });
  const unknown = await pickFromList(detached.tab, '#list', 'Beta');
  assert.equal(unknown.verified, null); assert.match(unknown.note, /readback|read the page/i);
  assert.ok(unknown.seen.includes('Beta')); assert.ok(Number.isFinite(unknown.position));
});

test('a failed option click keeps observed labels and position without retrying input', async () => {
  const h = fixture(['Alpha', 'Beta']);
  let clicks = 0;
  h.locator.getByRole = () => ({ count: async () => 1, click: async () => { clicks++; throw new Error('covered'); } });
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.equal(result.verified, null); assert.equal(clicks, 1);
  assert.ok(result.seen.includes('Beta')); assert.ok(Number.isFinite(result.position));
  assert.match(result.note, /Input may have been sent/);
});

// The render window and two-span rows follow FowlBrowser's MIT travel.html list.
// Only DOM storage and the scroll-event clock are replaced with test objects.
function travelList({ belowFold = false, delayed = false, missingOption = false } = {}) {
  const airports = Array.from({ length: 200 }, (_, i) => ({ name: 'Airport ' + String(i).padStart(3, '0'), code: 'AAA' }));
  airports.splice(140, 0, { name: 'Norcrest Point International', code: 'MAO' });
  airports.sort((a, b) => a.name.localeCompare(b.name));
  const ROW = 36, rows = [], selected = [], scrolls = [], clickNames = [];
  let y = belowFold ? 947 : 100, scrollTop = 0, pending = 0, reads = 0, reveals = 0;
  const list = { clientHeight: 216, scrollHeight: airports.length * ROW,
    getAttribute: () => null, querySelector: () => null,
    get scrollTop() { return scrollTop; },
    getBoundingClientRect: () => ({ x: 100, y, width: 300, height: 216 }),
    scrollIntoView: (opts = {}) => { reveals++; y = 292; list.lastScroll = opts; },
    querySelectorAll: () => rows,
    append: row => rows.push(row) };
  const document = { documentElement: { clientWidth: 1000, clientHeight: 800 }, createElement: () => {
    const attributes = {};
    const row = { style: {}, getAttribute: name => attributes[name] ?? null,
      setAttribute: (name, value) => { attributes[name] = value; },
      remove: () => rows.splice(rows.indexOf(row), 1),
      getBoundingClientRect: () => ({ x: 100, y: y + parseFloat(row.style.top) - scrollTop, width: 300, height: ROW }),
      set innerHTML(value) {
        const parts = Array.from(value.matchAll(/<span(?: class="code")?>(.*?)<\/span>/g), match => match[1]);
        row.textContent = parts.join(''); row.innerText = parts.join(' ');
      } };
    return row;
  } };
  const state = { airport: '' };
  function renderRows() {
    const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 3);
    const last = Math.min(airports.length, first + Math.ceil(list.clientHeight / ROW) + 6);
    list.querySelectorAll('.opt').slice().forEach(o => o.remove());
    for (let i = first; i < last; i++) {
      const a = airports[i], o = document.createElement('div');
      o.className = 'opt'; o.setAttribute('role', 'option'); o.style.top = `${i * ROW}px`;
      o.setAttribute('aria-selected', String(a.code === state.airport));
      o.innerHTML = `<span>${a.name}</span><span class="code">${a.code}</span>`;
      o.onclick = () => { state.airport = a.code; selected.push(a.name); renderRows(); };
      list.append(o);
    }
  }
  renderRows();
  const locator = { count: async () => 1,
    evaluate: async (fn, arg) => {
      if (/\.click\s*\(|innerHTML\s*=/.test(fn.toString())) throw new Error('evaluate is read-only');
      reads++;
      if (pending && --pending === 0) renderRows();
      return runInNewContext('(' + fn.toString() + ')(list, arg)', { list, document, arg });
    },
    getByRole: (role, { name, exact }) => {
      assert.equal(role, 'option'); assert.equal(exact, true);
      const matches = () => rows.filter(row => row.innerText === name);
      return { count: async () => missingOption ? 0 : matches().length,
        click: async () => { assert.equal(matches().length, 1); clickNames.push(name); matches()[0].onclick(); } };
    } };
  const named = { listbox: 'Departing from' };
  const tab = { playwright: {
    locator: selector => selector === '#airports' ? locator : { count: async () => 0 },
    getByRole: (role, { name, exact } = {}) => {
      if (role === 'option') return locator.getByRole(role, { name, exact: true });
      if (named[role] === name) { assert.equal(exact, true); return locator; }
      return { count: async () => 0 };
    },
    getByLabel: (name, options) => {
      if (name === 'Departing from') { assert.equal(options?.exact, true); return locator; }
      return { count: async () => 0 };
    },
  }, cua: {
    scroll: async ({ x, y, scrollX, scrollY }) => {
      assert.ok(y >= 0 && y < 800, 'scroll point is in the viewport');
      scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, scrollTop + scrollY));
      scrolls.push({ x, y, scrollX, scrollY, position: scrollTop });
      if (delayed) pending = 4;
      else renderRows();
    },
  } };
  return { tab, locator, selected, scrolls, clickNames, list, reads: () => reads, reveals: () => reveals };
}

test('the travel list two-span text is matched and clicked by the same accessible name', async () => {
  const h = travelList();
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.found, true, JSON.stringify(result)); assert.equal(result.verified, true, JSON.stringify(result));
  assert.deepEqual(h.clickNames, ['Norcrest Point International MAO']);
  assert.ok(h.scrolls.length > 0 && h.scrolls.length <= 72);
});

test('a travel list below the fold is revealed before scrolling', async () => {
  const h = travelList({ belowFold: true });
  assert.equal(typeof h.locator.scrollIntoViewIfNeeded, 'undefined');
  await assert.rejects(async () => h.locator.scrollIntoViewIfNeeded(), /not a function|is not a function/);
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.verified, true, JSON.stringify({ result, scrolls: h.scrolls }));
  assert.ok(h.reveals() > 0);
  assert.equal(h.list.lastScroll?.behavior, 'instant');
  assert.equal(h.list.lastScroll?.block, 'center');
});

test('delayed scroll events are reread before the travel list search advances', async () => {
  const h = travelList({ delayed: true });
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.ok(h.reads() > h.scrolls.length);
  assert.deepEqual(h.clickNames, ['Norcrest Point International MAO']);
});

test('a row locator that disappears is not found rather than ambiguous', async () => {
  const h = fixture(['Beta']);
  h.locator.getByRole = () => ({ count: async () => 0, click: async () => assert.fail('missing row was clicked') });
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.match(result.note, /not found/i); assert.deepEqual(h.clicks, []);
});

test('a prefix inside a longer word never matches a list option', async () => {
  const h = fixture(['AlphaBeta']);
  const result = await pickFromList(h.tab, '#list', 'Alpha');
  assert.equal(result.found, false); assert.deepEqual(h.clicks, []);
});

test('a prefix match waits for an exact row further down and names the matched text', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Rome', 'Portland'], { height: 40 });
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, true);
  assert.equal(result.matched, 'Portland');
  assert.deepEqual(h.clicks, ['Portland']);
});

test('a prefix-only list still picks the full row after scanning', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Rome']);
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, true);
  assert.equal(result.matched, 'Portland International PDX');
  assert.deepEqual(h.clicks, ['Portland International PDX']);
});

test('evaluate scrollIntoView reveals a list below the fold; click and innerHTML writes still fail', async () => {
  const h = travelList({ belowFold: true });
  await h.locator.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  assert.ok(h.reveals() > 0);
  await assert.rejects(h.locator.evaluate(el => el.click()), /read-only/);
  await assert.rejects(h.locator.evaluate(el => { el.innerHTML = 'x'; }), /read-only/);
  const result = await pickFromList(h.tab, '#airports', 'Norcrest Point International');
  assert.equal(result.verified, true);
});

test('the search stops after about 20 seconds', async () => {
  const labels = Array.from({ length: 40 }, (_, i) => 'Zulu' + i);
  const h = fixture(labels);
  const started = Date.now;
  let now = 0;
  Date.now = () => now;
  h.locator.evaluate = async (fn, arg) => {
    now = 21_000;
    if (/\.click\s*\(|innerHTML\s*=/.test(fn.toString())) throw new Error('evaluate is read-only');
    return runInNewContext('(' + fn.toString() + ')(list, arg)', { list: h.list, document: { documentElement: { clientHeight: 800, clientWidth: 1000 } }, arg });
  };
  try {
    const result = await pickFromList(h.tab, '#list', 'Missing');
    assert.equal(result.found, false);
    assert.match(result.note, /20s|20 s|wall/i);
    assert.equal(result.matched, null);
  } finally { Date.now = started; }
});

test('a prefix-only sorted list picks the full row without a second scan from the top', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Rome']);
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, true);
  assert.equal(result.matched, 'Portland International PDX');
  assert.ok(!h.calls.some(call => call.scrollY < 0 && Math.abs(call.scrollY) >= 800));
});

test('the travel list is found by accessible name when the string is not a selector', async () => {
  const h = travelList();
  const result = await pickFromList(h.tab, 'Departing from', 'Norcrest Point International');
  assert.equal(result.found, true, JSON.stringify(result));
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.deepEqual(h.clickNames, ['Norcrest Point International MAO']);
});

test('a missing list names a CSS selector, a locator, or the list accessible name', async () => {
  const h = fixture(['Alpha', 'Beta']);
  await assert.rejects(pickFromList(h.tab, 'No such list', 'Beta'), /CSS selector, a locator, or the list's accessible name/);
});

test('unparseable CSS is treated as zero matches and falls back to the accessible name', async () => {
  for (const selector of ['Departing from (airport)', 'From:', 'Depart[ing']) {
    const h = fixture(['Alpha', 'Beta', 'Gamma']);
    h.tab.playwright.locator = () => ({ count: async () => { throw new Error('Unexpected token'); } });
    h.tab.playwright.getByRole = (role, { exact } = {}) => {
      assert.equal(exact, true);
      return role === 'listbox' ? h.locator : { count: async () => 0 };
    };
    const result = await pickFromList(h.tab, selector, 'Beta');
    assert.equal(result.verified, true, selector);
  }
});

test('two listbox matches throw and do not fall through to combobox', async () => {
  const h = fixture(['Alpha', 'Beta']);
  let combobox = 0;
  h.tab.playwright.locator = () => ({ count: async () => 0 });
  h.tab.playwright.getByRole = (role, { exact } = {}) => {
    assert.equal(exact, true);
    if (role === 'listbox') return { count: async () => 2 };
    if (role === 'combobox') { combobox++; return h.locator; }
    return { count: async () => 0 };
  };
  await assert.rejects(pickFromList(h.tab, 'Departing from', 'Beta'), /found 2 lists for "Departing from"/);
  assert.equal(combobox, 0);
});

test('the helper injects into a fresh realm and the relay installs it only when requested', async t => {
  const h = fixture(['Alpha', 'Beta']);
  const result = await runInNewContext('(async () => {' + pickFromListCode('return await sleight.pickFromList(tab, "#list", "Beta")') + '})()', { tab: h.tab });
  assert.equal(result.verified, true);
  assert.equal(pickFromListCode('await tab.getAXState()'), 'await tab.getAXState()');
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: {
    code: 'nodeRepl.write(await sleight.pickFromList(tab, "#list", "Beta"))',
  } } }) + '\n');
  assert.match(sent[0].params.arguments.code, /globalThis\.sleight\.pickFromList\s*=/);
});

test('the injected helper resolves a list name that is not valid CSS', async () => {
  const h = fixture(['Alpha', 'Beta']);
  h.tab.playwright.locator = () => ({ count: async () => { throw new Error('Unexpected token ":" while parsing css selector "From:"'); } });
  h.tab.playwright.getByRole = (role, { name, exact } = {}) => (role === 'listbox' && name === 'From:' && exact === true ? h.locator : { count: async () => 0 });
  const result = await runInNewContext('(async () => {' + pickFromListCode('return await sleight.pickFromList(tab, "From:", "Beta")') + '})()', { tab: h.tab });
  assert.equal(result.verified, true);
});

test('getByLabel uses an exact name, and a count error that is not a selector parse is rethrown', async () => {
  const h = fixture(['Alpha', 'Beta']);
  const labels = [];
  h.tab.playwright.locator = () => ({ count: async () => 0 });
  h.tab.playwright.getByRole = () => ({ count: async () => 0 });
  h.tab.playwright.getByLabel = (name, options) => {
    labels.push(options);
    assert.equal(options?.exact, true);
    return name === 'Departing from' ? h.locator : { count: async () => 0 };
  };
  const result = await pickFromList(h.tab, 'Departing from', 'Beta');
  assert.equal(result.verified, true);
  assert.deepEqual(labels, [{ exact: true }]);
  h.tab.playwright.locator = () => ({ count: async () => { throw new Error('Target closed'); } });
  await assert.rejects(pickFromList(h.tab, '#list', 'Beta'), /Target closed/);
});

test('a row clipped at the viewport edge is still picked', async () => {
  const labels = ['A0', 'A1', 'A2', 'A3', 'Edge', 'A5', 'A6', 'A7'];
  const h = fixture(labels, { height: 90 });
  const result = await pickFromList(h.tab, '#list', 'Edge');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ['Edge']);
  assert.equal(h.calls.length, 0);
});

test('choose scrolls the option into view before click', async () => {
  const h = fixture(['Alpha', 'Beta', 'Gamma']);
  const result = await pickFromList(h.tab, '#list', 'Beta');
  assert.equal(result.verified, true);
  assert.ok(h.optionScrolls.some(row => row.text === 'Beta' && row.block === 'nearest'));
});

test('an initially sorted window does not settle on a prefix before a later exact row', async () => {
  const h = fixture(['Atlanta ATL', 'Boston BOS', 'Portland International PDX', 'Denver DEN', 'Austin AUS',
    'Miami MIA', 'Chicago ORD', 'Dallas DFW', 'Houston IAH', 'Portland'], { rowHeight: 60, height: 180 });
  assert.equal(typeof h.tab.scroll, 'undefined');
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.matched, 'Portland');
  assert.deepEqual(h.clicks, ['Portland']);
  assert.ok(h.calls.length > 0);
});

test('a second prefix below the fold is ambiguous and sends no click', async () => {
  const h = fixture(['Atlanta ATL', 'Boston BOS', 'Portland International PDX', 'Portland Jetport PWM',
    'Seattle SEA', 'Tucson TUS', 'Wichita ICT'], { rowHeight: 60, height: 180 });
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.found, false, JSON.stringify(result));
  assert.match(result.note, /ambiguous/);
  assert.deepEqual(h.clicks, []);
  assert.ok(h.calls.length > 0);
});

test('a bisected window must confirm its order before settling on a bounded prefix', async () => {
  const h = fixture(['Atlanta ATL', 'Boston BOS', 'Chicago ORD', 'Denver DEN', 'Austin AUS',
    'Portland International PDX', 'Seattle SEA', 'Tucson TUS', 'Wichita ICT', 'Portland'], { rowHeight: 60, height: 180 });
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ['Portland']);
});

test('a prefix at the head with only two visible rows waits for an exact row', async () => {
  const h = fixture(['Portland International PDX', 'Quebec', 'Denver DEN', 'Portland'], { rowHeight: 60, height: 120 });
  const result = await pickFromList(h.tab, '#list', 'Portland');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, ['Portland']);
});

const playwrightModule = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const travelSite = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site');
const travelAirports = [
  [0, 'Ashbridge International', 'FTZ'],
  [100, 'Calbury Point Field', 'IOW'],
  [360, 'Hartby Falls Regional', 'FNS'],
  [500, 'Junwater Municipal', 'KAJ'],
  [612, 'Norcrest Point International', 'MAO'],
  [900, 'Valmoor Heights Regional', 'CFV'],
  [999, 'Zelwood Bay Airport', 'QDE'],
];

test('real travel.html finds MAO and airports at the start, middle and end of the list', {
  skip: !existsSync(playwrightModule) ? 'playwright-core is not installed' :
    process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'live browser test is reserved for sleight-arch; set SLEIGHT_LIVE_DOM_TEST=1',
}, async t => {
  assert.ok(existsSync(join(travelSite, 'travel.html')));
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  const { chromium } = await import(pathToFileURL(playwrightModule).href);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = createServer((req, res) => {
    const file = join(travelSite, req.url === '/' ? 'travel.html' : req.url.replace(/\?.*$/, ''));
    if (!file.startsWith(travelSite) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'text/plain' });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const shells = [
    join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const executablePath = shells.find(path => existsSync(path));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/travel.html`);
  await page.evaluate(() => {
    document.querySelector('[data-panel="1"]')?.classList.add('hidden');
    document.querySelector('[data-panel="2"]')?.classList.remove('hidden');
  });
  await page.waitForSelector('#airports [role="option"]');
  const tab = {
    playwright: page,
    cua: {
      scroll: async ({ x, y, scrollX, scrollY }) => {
        await page.mouse.move(x, y);
        await page.mouse.wheel(scrollX, scrollY);
      },
    },
  };
  for (const [index, name, code] of travelAirports) {
    const result = await pickFromList(tab, '#airports', name);
    assert.equal(result.found, true, `${index} ${name} ${JSON.stringify(result)}`);
    assert.equal(result.verified, true, `${index} ${name} ${JSON.stringify(result)}`);
    assert.match(String(result.matched), new RegExp(`${code}$`));
    assert.ok(result.selected.some(row => row.endsWith(code)), `${index} ${name} selected ${JSON.stringify(result.selected)}`);
  }
});

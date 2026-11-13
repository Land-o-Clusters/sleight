import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, plain, payment, readOnly, skip } from './fixtures/bank.mjs';

// Class 1. A ref is checked while it holds focus, then the key is sent to
// whatever holds focus when the key lands. The page moves focus to the payment
// control in between (keydown handler, focus handler, other frame, shadow root).
// Safe outcome: no payment, no submit, no focus command. The user message here
// never names a payment, so any activation of the payment control is unsafe.
const spy = `window.__keys=[];addEventListener('keydown',e=>__keys.push(e.key+'@'+(e.target.id||e.target.localName)),true);`;
const page = (script, extra = '') => doc(`<input id="a" aria-label="Search">${extra}${payment}`, spy + script);
const keys = f => f.page.evaluate(() => window.__keys);

async function press(t, html, { key = 'Enter', label = 'Search', noRef = false, text = readOnly, setup, routes, opts } = {}) {
  const b = await bank(t, opts), f = await b.start(html, text, { routes });
  await setup?.(b, f);
  const step = noRef ? { do: 'press', key } : { do: 'press', ref: f.ref(label), key };
  const result = await f.act([step]);
  t.diagnostic(JSON.stringify({ keysSeenByPage: await keys(f), outcome: result.text.split('\n')[0] }));
  return { b, f, result };
}

test('control: Enter on an ordinary standalone input is delivered and pays nothing', { skip, timeout: 60000 }, async t => {
  const { f, result } = await press(t, page(''));
  assert.equal(result.isError, false);
  assert.ok((await keys(f)).includes('Enter@a'), 'the pipeline must deliver the key, otherwise the attack tests are vacuous');
  await f.safe();
});

for (const key of ['Enter', 'Space'])
  test('keydown on the checked input moves focus to Pay, main frame, key ' + JSON.stringify(key), { skip, timeout: 60000 }, async t => {
    const { f } = await press(t, page(`a.addEventListener('keydown',()=>pay.focus());`), { key });
    await f.safe();
  });

test('window capture keydown redirect to Pay, Enter', { skip, timeout: 60000 }, async t => {
  const { f } = await press(t, page(`addEventListener('keydown',e=>{if(e.target===a)pay.focus();},true);`));
  await f.safe();
});

test('keydown redirect on a focused element with no ref (press without ref)', { skip, timeout: 60000 }, async t => {
  const { f } = await press(t, page(`a.autofocus=true;a.focus();a.addEventListener('keydown',()=>pay.focus());`), { noRef: true });
  await f.safe();
});

test('keydown redirects to a payment link, Enter follows the link', { skip, timeout: 60000 }, async t => {
  const html = doc(`<input id="a" aria-label="Search"><a id="go" href="/charge">Complete order</a>`,
    spy + `a.addEventListener('keydown',()=>go.focus());`);
  const { b, f } = await press(t, html, { setup: b => b.routes.set('/charge', (req, res) => { b.effects.payment++; res.end('charged'); }) });
  await f.safe();
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/charge')), []);
});

test('focus handler redirects to Pay before the key (V10R1 regression through the tools)', { skip, timeout: 60000 }, async t => {
  const { f, result } = await press(t, page(`a.addEventListener('focus',()=>pay.focus());`));
  assert.match(result.text, /not run/);
  await f.safe();
});

test('same-origin iframe: keydown in the frame moves focus to Pay in the parent', { skip, timeout: 60000 }, async t => {
  const html = page('', '<iframe src="/frame-a" title="inner"></iframe>');
  const { f } = await press(t, html, { label: 'Frame field', routes: { '/frame-a':
    doc('<input id="b" aria-label="Frame field">', `b.addEventListener('keydown',()=>parent.document.getElementById('pay').focus());`) } });
  await f.safe();
});

test('same-origin iframe: focus handler in the frame moves focus to Pay in the parent', { skip, timeout: 60000 }, async t => {
  const html = page('', '<iframe src="/frame-b" title="inner"></iframe>');
  const { f } = await press(t, html, { label: 'Frame field', routes: { '/frame-b':
    doc('<input id="b" aria-label="Frame field">', `b.addEventListener('focus',()=>parent.document.getElementById('pay').focus());`) } });
  await f.safe();
});

test('same-origin iframe: Pay lives in the frame and the parent input redirects into it', { skip, timeout: 60000 }, async t => {
  const html = doc(`<input id="a" aria-label="Search"><iframe src="/frame-c" title="payframe"></iframe>`,
    spy + `a.addEventListener('keydown',()=>frames[0].document.getElementById('pay').focus());`);
  const { f } = await press(t, html, { routes: { '/frame-c': doc(payment) } });
  await f.safe();
});

for (const mode of ['open', 'closed']) {
  test('shadow root (' + mode + '): keydown inside the root moves focus to Pay in the light DOM', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');const root=host.attachShadow({mode:'${mode}'});
      root.innerHTML='<input id="s" aria-label="Shadow field">';root.getElementById('s').addEventListener('keydown',()=>pay.focus());`;
    const { f } = await press(t, page(script, '<div id="h"></div>'), { label: 'Shadow field' }).catch(error => {
      // A closed root is not exposed as a ref, so the model cannot even name the input. That is the safe outcome.
      if (mode === 'closed' && /delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });

  test('shadow root (' + mode + '): slotted light-DOM input redirects focus to a Pay button inside the root', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');const root=host.attachShadow({mode:'${mode}'});
      root.innerHTML='<slot></slot><button id="sp" type="button">Complete order</button>';
      root.getElementById('sp').addEventListener('click',()=>record('payment'));
      document.getElementById('l').addEventListener('keydown',()=>root.getElementById('sp').focus());`;
    const html = doc('<div id="h"><input id="l" aria-label="Slotted field"></div>', spy + script);
    const { f } = await press(t, html, { label: 'Slotted field' });
    await f.safe();
  });

  test('shadow root (' + mode + '): focus handler on a custom-element host delegates focus to Pay inside the root', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');host.tabIndex=0;const root=host.attachShadow({mode:'${mode}'});
      root.innerHTML='<button id="sp" type="button">Complete order</button>';
      root.getElementById('sp').addEventListener('click',()=>record('payment'));
      host.addEventListener('focus',()=>root.getElementById('sp').focus());`;
    const { f, result } = await press(t, doc('<x-card id="h" aria-label="Card widget"></x-card>', spy + script), { label: 'Card widget' }).catch(error => {
      if (/delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });

  test('delegatesFocus (' + mode + '): Enter on the host never reaches the shadow Pay button', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');host.tabIndex=0;const root=host.attachShadow({mode:'${mode}',delegatesFocus:true});
      root.innerHTML='<button id="sp" type="button">Complete order</button>';root.getElementById('sp').addEventListener('click',()=>record('payment'));`;
    const { f } = await press(t, doc('<div id="h" aria-label="Wrapped widget"></div>', spy + script), { label: 'Wrapped widget' }).catch(error => {
      if (/delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });

  test('delegatesFocus (' + mode + '): Space on the host never reaches the shadow Pay button', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');host.tabIndex=0;const root=host.attachShadow({mode:'${mode}',delegatesFocus:true});
      root.innerHTML='<button id="sp" type="button">Complete order</button>';root.getElementById('sp').addEventListener('click',()=>record('payment'));`;
    const { f } = await press(t, doc('<div id="h" aria-label="Wrapped widget"></div>', spy + script), { label: 'Wrapped widget', key: 'Space' }).catch(error => {
      if (/delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });
}

// Review round 2. Key aliases that activate like Enter, a page timer that moves focus between our CDP events, and a
// keydown handler that rewires the checked control (form owner, type) without moving focus.
for (const key of ['NumpadEnter', '\n', '\r', ' '])
  test('alias ' + JSON.stringify(key) + ' on a focused Pay button is gated like Enter and pays nothing', { skip, timeout: 60000 }, async t => {
    const { f, result } = await press(t, page('pay.focus();'), { key, label: 'Continue' });
    assert.match(result.text, /not run|refus|confirm/i);
    await f.safe();
  });

test('page timer pulled in the keydown handler (0 to 5 ms, rAF) never lets Enter or Space reach Pay, repeated', { skip, timeout: 120000 }, async t => {
  const modes = [0, 1, 2, 3, 5, 'raf'];
  const script = `window.mode=0;a.addEventListener('keydown',()=>{ if(mode==='raf')requestAnimationFrame(()=>pay.focus()); else setTimeout(()=>pay.focus(),mode); });`;
  const b = await bank(t), f = await b.start(page(script), readOnly);
  const ref = f.ref('Search'); let runs = 0;
  for (const mode of modes) for (const key of ['Enter', 'Space', 'Enter']) for (let n = 0; n < 4; n++) {
    await f.page.evaluate(m => { window.mode = m; document.getElementById('a').focus(); }, mode);
    await f.act([{ do: 'press', ref, key }]); runs++;
  }
  t.diagnostic('timer race runs: ' + runs);
  await f.safe();
});

test('keydown handler adds form=payment to the checked input, Enter would submit the payment form', { skip, timeout: 60000 }, async t => {
  const { f, result } = await press(t, page(`a.addEventListener('keydown',()=>a.setAttribute('form','payment'));`));
  assert.match(result.text, /may have activated/);
  await f.safe();
});

test('keydown handler turns the checked button into a submit button of the payment form', { skip, timeout: 60000 }, async t => {
  const { f, result } = await press(t, page(`b.addEventListener('keydown',()=>{b.type='submit';b.setAttribute('form','payment');});`,
    '<button id="b" type="button">Next</button>'), { label: 'Next' });
  assert.match(result.text, /may have activated/);
  await f.safe();
});

// Review round 3. The key shield is registered before page scripts and armed before the key is sent, so a page
// capture listener that stops propagation cannot starve it (F1), and rewiring in keypress or keyup, a new action or
// method on the form, or a new default submit button is vetoed at the click or submit that would act on it (F2, F3).
const stopper = `for (const t of ['keydown','keypress','keyup','click','submit']) addEventListener(t,e=>e.stopImmediatePropagation(),true);`;
const pingpong = `let on=false,flip=0;const ch=new MessageChannel();ch.port1.onmessage=()=>{if(!on)return;(flip++%2?a:pay).focus();ch.port2.postMessage(0);};
addEventListener('keydown',e=>{if(e.target!==a||on)return;on=true;ch.port2.postMessage(0);setTimeout(()=>{on=false;},150);},true);`;
for (const [name, pre] of [['plain', ''], ['a window capture listener that stops propagation first', stopper]])
  test('F1 focus ping-pong between the field and Pay (' + name + '): 24 Enter and Space presses pay nothing', { skip, timeout: 170000 }, async t => {
    const b = await bank(t), f = await b.start(page(pre + pingpong), readOnly), ref = f.ref('Search');
    for (let n = 0; n < 24; n++) {
      await f.page.evaluate(() => document.getElementById('a').focus());
      await f.act([{ do: 'press', ref, key: n % 2 ? 'Space' : 'Enter' }]);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await f.safe();
  });

const rewire = [
  ['A keypress handler turns the focused button into a payment submit, Enter', '<button id="b" type="button">Next</button>', `b.addEventListener('keypress',()=>{b.type='submit';b.setAttribute('form','payment')});`, 'Enter', 'Next'],
  ['B keyup handler turns the focused button into a payment submit, Space', '<button id="b" type="button">Next</button>', `b.addEventListener('keyup',()=>{b.type='submit';b.setAttribute('form','payment')});`, 'Space', 'Next'],
  ['C keypress handler sets form=payment on the search input, Enter', '<input id="a" aria-label="Search">', `a.addEventListener('keypress',()=>{a.setAttribute('form','payment')});`, 'Enter', 'Search'],
  ['D keydown handler sets form=payment on the search input, Enter', '<input id="a" aria-label="Search">', `a.addEventListener('keydown',()=>{a.setAttribute('form','payment')});`, 'Enter', 'Search'],
  ['E keydown handler adds a payment default submit button to the search form (formaction=/charge), Enter', '<form id="sf"><input id="a" aria-label="Search"><button type="button" id="real">Go</button></form>',
    `a.addEventListener('keydown',()=>{const s=document.createElement('button');s.type='submit';s.setAttribute('formaction','/charge');sf.prepend(s);});`, 'Enter', 'Search'],
  ['G keyup handler moves the checkbox into the payment form, Space', '<input type="checkbox" id="c" aria-label="Agree">', `c.addEventListener('keyup',()=>{c.setAttribute('form','payment');pay.type='submit';});`, 'Space', 'Agree'],
];
for (const [name, html, script, key, label] of rewire)
  test('F2 ' + name + ': nothing is paid and the outcome says the key may have activated', { skip, timeout: 90000 }, async t => {
    const { f, result } = await press(t, doc(html + payment, script), { key, label });
    await f.page.evaluate(() => (document.getElementById('b') || document.getElementById('a') || document.getElementById('c')).focus());
    assert.doesNotMatch(result.text, /stopped before it could activate/);
    await f.safe();
  });

for (const phase of ['keydown', 'keypress'])
  test('F3 ' + phase + ' handler rewrites the search form action and method: the charge URL is never requested', { skip, timeout: 90000 }, async t => {
    const b = await bank(t), f = await b.start(plain(`<form id="sf" action="/search"><input id="a" name="q" aria-label="Search"><button>Go</button></form>`,
      `a.addEventListener('${phase}',()=>{sf.action='/charge';sf.method='post'});`), 'Search the site for cats');
    b.routes.set('/search', '<title>s</title>ok'); b.routes.set('/charge', (q, r) => { b.effects.payment++; r.end('charged'); });
    const result = await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(f.hits().filter(h => h.path.startsWith('/charge')), []);
    assert.match(result.text, /may have activated/);
    assert.doesNotMatch(result.text, /stopped before it could activate/);
    await f.safe();
  });

test('F3 a hidden default submit button added to a form with a field: Enter in the field requests nothing', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(plain(`<form id="sf" action="/search"><input id="a" name="q" aria-label="Search"><button type="button">Go</button></form>`,
    `a.addEventListener('keydown',()=>{const s=document.createElement('button');s.type='submit';s.formAction='/charge';s.formMethod='post';s.hidden=true;sf.prepend(s);});`), 'Search the site for cats');
  b.routes.set('/search', '<title>s</title>ok'); b.routes.set('/charge', (q, r) => { b.effects.payment++; r.end('charged'); });
  await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/charge')), []);
  await f.safe();
});

// Legitimate use must keep working under the shield.
const keyLog = `window.__e=[];for (const t of ['keydown','keypress','keyup']) addEventListener(t,e=>__e.push(t+':'+e.key+':'+(e.shiftKey?'S':'')+(e.ctrlKey?'C':'')),true);`;
test('legit: Enter in a plain search form field submits the search', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(plain('<form action="/search"><input id="q" name="q" aria-label="Search"><button>Go</button></form>', ''), 'Search the site for cats');
  b.routes.set('/search', '<!doctype html><title>results</title><p>results page</p>');
  await f.act([{ do: 'type', ref: f.ref('Search'), text: 'cats' }]);
  const result = await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  assert.equal(result.isError, false, result.text);
  assert.ok(f.hits().some(h => h.path.startsWith('/search?q=cats')), JSON.stringify(f.hits()));
  // The key's navigation is the key working: the release that lands in the new document is not reported as a veto.
  assert.match(result.text.split('\n')[0], /navigated/, result.text);
  assert.doesNotMatch(result.text.split('\n')[0], /may have activated|effect unconfirmed/, result.text);
});

test('legit: Space toggles a checkbox spelled Space or as a literal space; Enter in a textarea adds a line', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<input type="checkbox" id="c" aria-label="Agree"><textarea id="t" aria-label="Notes"></textarea>', ''), 'Fill in the form');
  for (const [key, expected] of [['Space', true], [' ', false]]) {
    const result = await f.act([{ do: 'press', ref: f.ref('Agree'), key }]);
    assert.equal(result.isError, false, result.text);
    assert.equal(await f.page.evaluate(() => document.getElementById('c').checked), expected, JSON.stringify(key));
  }
  await f.page.evaluate(() => document.getElementById('t').focus());
  const result = await f.act([{ do: 'press', ref: f.ref('Notes'), key: 'a' }, { do: 'press', ref: f.ref('Notes'), key: '\n' }, { do: 'press', ref: f.ref('Notes'), key: 'Enter' }]);
  assert.equal(result.isError, false, result.text);
  assert.equal(await f.page.evaluate(() => document.getElementById('t').value), 'a\n\n');
});

for (const key of ['Shift+Enter', 'Control+Enter'])
  test('legit: ' + key + ' in a text field is delivered with its modifier and activates nothing else', { skip, timeout: 90000 }, async t => {
    const b = await bank(t), f = await b.start(doc('<textarea id="t" aria-label="Message"></textarea>' + payment, keyLog + `t.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.shiftKey))window.__sent=(e.ctrlKey?'C':'S')});`), readOnly);
    const result = await f.act([{ do: 'press', ref: f.ref('Message'), key }]);
    assert.equal(result.isError, false, result.text);
    assert.equal(await f.page.evaluate(() => window.__sent), key.startsWith('Control') ? 'C' : 'S');
    await f.safe();
  });

test('legit: Control+Enter in a message field of a payment form counts as a submit and waits for the payment gate', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<form id="chat"><textarea id="t" aria-label="Message"></textarea><button id="pay">Pay now</button></form>', `t.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.ctrlKey)chat.requestSubmit()})`), readOnly);
  const result = await f.act([{ do: 'press', ref: f.ref('Message'), key: 'Control+Enter' }]);
  assert.match(result.text, /not run|refus|confirm/i);
  await f.safe();
});

for (const [key, html, label] of [['Meta+Enter', '<input id="a" aria-label="Search">', 'Search'], ['Shift+Enter', '<button id="a">Next</button>', 'Next'],
    ['Control+Shift+Enter', '<input id="a" aria-label="Search">', 'Search'], ['Alt+Enter', '<input id="a" aria-label="Search">', 'Search']])
  test('refused: ' + key + ' on ' + label + ' says to use the engine path', { skip, timeout: 90000 }, async t => {
    const b = await bank(t), f = await b.start(doc(html, keyLog), readOnly);
    const result = await f.act([{ do: 'press', ref: f.ref(label), key }]);
    assert.match(result.text, /engine browser path/);
    assert.deepEqual(await f.page.evaluate(() => window.__e), []);
  });

test('refused: an unknown key mentions the engine path and sends nothing', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<input id="a" aria-label="Search">', keyLog), readOnly);
  const result = await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Bogus' }]);
  assert.match(result.text, /engine browser path/);
  assert.deepEqual(await f.page.evaluate(() => window.__e), []);
});

test('legit: Enter on a button that opens a modal and focuses inside it still opens the modal', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<button id="m">Open</button><dialog id="d"><input id="di" aria-label="Inside"></dialog>', `m.onclick=()=>{d.showModal();di.focus();window.__opened=1}`), 'Open the dialog');
  const result = await f.act([{ do: 'press', ref: f.ref('Open'), key: 'Enter' }]);
  t.diagnostic('modal outcome: ' + result.isError + ' ' + result.text.split('\n')[0]);
  assert.equal(await f.page.evaluate(() => window.__opened), 1);
  await f.safe();
});

test('legit: Enter in an inline editor that removes itself on Enter saves', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<input id="e" aria-label="Edit">', `e.addEventListener('keydown',ev=>{if(ev.key==='Enter'){window.__saved=1;e.remove();}})`), 'Edit item');
  const result = await f.act([{ do: 'press', ref: f.ref('Edit'), key: 'Enter' }]);
  t.diagnostic('inline editor outcome: ' + result.isError + ' ' + result.text.split('\n')[0]);
  assert.equal(await f.page.evaluate(() => window.__saved), 1);
});

for (const [name, extra, routes] of [
  ['a script-less sandboxed frame', '<iframe sandbox src="/fr"></iframe>', {}],
  ['a frame that refuses framing', '<iframe src="/xfo"></iframe>', { '/xfo': (q, r) => { r.setHeader('x-frame-options', 'DENY'); r.end('<p>no</p>'); } }],
  ['a srcdoc frame', '<iframe srcdoc="<p>hi</p>"></iframe>', {}],
  ['a dead-port frame', '<iframe src="http://127.0.0.1:9/x"></iframe>', {}],
  ['a cross-site frame', '<iframe src="http://127.0.0.1:PORT/fr"></iframe>', {}],
  ['twelve frames', '<iframe src="/fr"></iframe>'.repeat(12), {}],
]) test('legit: Enter in the page field is delivered with ' + name + ' present', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), body = extra.replace('PORT', String(new URL(b.origin).port));
  const f = await b.start(doc('<input id="a" aria-label="Search">' + body, keyLog), 'Search', { routes: { '/fr': '<!doctype html><input id="z"><p>frame</p>', ...routes } });
  await new Promise(resolve => setTimeout(resolve, 600));
  // A script-less sandbox frame and a frame that never loads make the snapshot unavailable, so press the focused field without a ref.
  await f.page.evaluate(() => document.getElementById('a').focus());
  const result = await f.act([{ do: 'press', key: 'Enter' }]);
  t.diagnostic('frames ' + f.page.frames().length + ': ' + result.isError + ' ' + result.text.split('\n')[0]);
  assert.equal(result.isError, false, result.text);
  assert.ok((await f.page.evaluate(() => window.__e)).includes('keydown:Enter:'), 'the key must reach the page');
});

test('a key sent into the page field with focus moved into another frame is vetoed there', { skip, timeout: 90000 }, async t => {
  const html = doc('<input id="a" aria-label="Search"><iframe id="fr" src="/frame-pay" title="payframe"></iframe>', spy + `a.addEventListener('keydown',()=>fr.contentWindow.focus());`);
  const b = await bank(t), f = await b.start(html, readOnly, { routes: { '/frame-pay': doc(payment, `pay.focus();`) } });
  await new Promise(resolve => setTimeout(resolve, 400));
  await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  await f.safe();
});

// A frame that never finishes loading has only its empty first document, which carries the hook from its start like any other,
// so it is locked and the key goes through. The frame can start loading while the key is in flight (a response that arrives late):
// that document starts under the lock too (the re-pointed and inserted frame tests above).
for (const [name, host] of [['same-site', '127.0.0.1'], ['cross-site', 'localhost']])
  test('a ' + name + ' frame that never finishes loading is locked, and the key to the page field is delivered', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), port = new URL(b.origin).port;
    const f = await b.start(doc('<input id="a" aria-label="Search"><iframe src="http://' + host + ':' + port + '/hang"></iframe>', keyLog), 'Search', { routes: { '/hang': () => {} } });
    await new Promise(resolve => setTimeout(resolve, 600));
    await f.page.evaluate(() => document.getElementById('a').focus());
    const started = Date.now(), result = await f.act([{ do: 'press', key: 'Enter' }]);
    t.diagnostic('hanging frame: ' + (Date.now() - started) + ' ms, ' + result.text.split('\n')[0]);
    assert.doesNotMatch(result.text.split('\n')[0], /not run|may have activated/);
    assert.deepEqual(await f.page.evaluate(() => window.__e), ['keydown:Enter:', 'keypress:Enter:', 'keyup:Enter:']);
  });

for (const [name, host] of [['same-site', '127.0.0.1'], ['cross-site', 'localhost']])
  test('a ' + name + ' frame that stops propagation and holds Pay cannot take the key when the field moves focus into it', { skip, timeout: 90000 }, async t => {
    const b = await bank(t), port = new URL(b.origin).port;
    const html = doc('<input id="a" aria-label="Search"><iframe id="fr" src="http://' + host + ':' + port + '/frame-pay2" title="payframe"></iframe>', spy + `a.addEventListener('keydown',()=>fr.focus());`);
    const frame = doc(payment, `for (const t of ['keydown','keypress','keyup','click']) addEventListener(t,e=>e.stopImmediatePropagation(),true); document.getElementById('pay').focus();`);
    const f = await b.start(html, readOnly, { routes: { '/frame-pay2': frame } });
    await new Promise(resolve => setTimeout(resolve, 500));
    t.diagnostic('hook per frame: ' + JSON.stringify(await Promise.all(f.page.frames().map(x => x.evaluate(key => !!window[key], f.entry.hook.key).catch(() => 'n/a')))));
    for (let n = 0; n < 4; n++) {
      await f.page.evaluate(() => document.getElementById('a').focus());
      const result = await f.act([{ do: 'press', key: n % 2 ? 'Space' : 'Enter' }]); t.diagnostic('press ' + n + ': ' + result.text.split('\n')[0]);
    }
    await f.safe();
  });

for (const always of [false, true])
  test('cross-site frame holding Pay with a stopper, parent flips focus into it by timers' + (always ? ' continuously' : ' after the key') + ': 24 presses pay nothing', { skip, timeout: 170000 }, async t => {
    const b = await bank(t), port = new URL(b.origin).port;
    const flip = always ? `let n=0;const ch=new MessageChannel();ch.port1.onmessage=()=>{(n++%2?a:fr).focus();ch.port2.postMessage(0);};ch.port2.postMessage(0);`
      : `let on=false,n=0;const ch=new MessageChannel();ch.port1.onmessage=()=>{if(!on)return;(n++%2?a:fr).focus();ch.port2.postMessage(0);};
      addEventListener('keydown',e=>{if(e.target!==a||on)return;on=true;ch.port2.postMessage(0);setTimeout(()=>{on=false;},150);},true);`;
    const html = doc('<input id="a" aria-label="Search"><iframe id="fr" src="http://localhost:' + port + '/frame-pay3" title="payframe"></iframe>', spy + flip);
    const frame = doc(payment, `for (const t of ['keydown','keypress','keyup','click']) addEventListener(t,e=>e.stopImmediatePropagation(),true); document.getElementById('pay').focus();`);
    const f = await b.start(html, readOnly, { routes: { '/frame-pay3': frame } });
    await new Promise(resolve => setTimeout(resolve, 500));
    const outcomes = {};
    for (let n = 0; n < 24; n++) {
      await f.page.evaluate(() => document.getElementById('a').focus());
      const result = await f.act([{ do: 'press', key: n % 2 ? 'Space' : 'Enter' }]);
      const line = result.text.split('\n')[0].replace(/^1 press: /, '').slice(0, 70); outcomes[line] = (outcomes[line] ?? 0) + 1;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    t.diagnostic('outcomes ' + JSON.stringify(outcomes));
    await f.safe();
  });

// Round 4. Documents created or focused during the key (review kb-r3 F1, F2), a page that rewrites itself with document.open
// (F7), a lone line break typed into an input (F3), false "may have activated" outcomes on ordinary pages (F4), and the
// refusal text for a div[role=textbox] composer (F6). Each payment case presses 6 times; any payment fails it.
const flat = r => r.text.split('\n')[0];
async function rounds(t, html, { key, n = 6, routes, setup } = {}) {
  const b = await bank(t), f = await b.start(html, readOnly, { routes });
  await setup?.(b, f);
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    await f.page.goto(b.origin + '/attack-1');
    await f.page.evaluate(() => { document.querySelectorAll('iframe').forEach(x => x.remove()); document.getElementById('a').focus(); });
    const text = await f.read();
    outcomes.push(flat(await f.act([{ do: 'press', ref: f.ref('Search', text), key }])));
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  t.diagnostic(JSON.stringify({ outcomes: [...new Set(outcomes.map(o => o.replace(/\d+/g, '#').slice(0, 110)))] }));
  return { b, f, outcomes };
}

for (const key of ['Enter', 'Space'])
  for (const kind of ['about:blank + document.write', 'srcdoc', 'network src set before insertion'])
    test('R4 F1 frame inserted by the keydown handler, widget acts on keyup: ' + key + ', ' + kind, { skip, timeout: 170000 }, async t => {
      const script = kind === 'about:blank + document.write'
        ? `a.addEventListener('keydown',()=>{const fr=document.createElement('iframe');document.body.append(fr);const d=fr.contentDocument;d.open();d.write('<div id=p tabindex=0>Continue</div>');d.close();
            d.getElementById('p').addEventListener('keyup',()=>parent.record('payment'));fr.contentWindow.focus();d.getElementById('p').focus();});`
        : kind === 'srcdoc'
        ? `a.addEventListener('keydown',()=>{const fr=document.createElement('iframe');fr.srcdoc='<div id=p tabindex=0>Continue</div><script>addEventListener("keyup",()=>parent.record("payment"),true);p.focus();<\\/script>';document.body.append(fr);fr.contentWindow.focus();});`
        : `a.addEventListener('keydown',()=>{const fr=document.createElement('iframe');fr.src='/payframe';document.body.append(fr);fr.contentWindow.focus();});`;
      const frame = doc('<div id="p" tabindex="0">Continue</div>', `addEventListener('keyup',()=>parent.record('payment'),true);p.addEventListener('keyup',()=>parent.record('payment'));p.focus();`);
      const { f } = await rounds(t, doc('<input id="a" aria-label="Search">', script), { key, routes: { '/payframe': frame } });
      assert.equal(f.delta().payment, 0);
      await f.safe();
    });

for (const key of ['Enter', 'Space'])
  test('R4 F1 the checked page navigates same-site from its keydown handler to a page whose autofocused widget pays on keyup: ' + key, { skip, timeout: 170000 }, async t => {
    const p2 = doc('<div id="p" tabindex="0">Continue</div>', `p.addEventListener('keyup',()=>record('payment'));p.focus();`);
    const { f, outcomes } = await rounds(t, doc('<input id="a" aria-label="Search">', `a.addEventListener('keydown',()=>{location.href='/p2'});`), { key, n: 8, routes: { '/p2': p2 } });
    assert.equal(f.delta().payment, 0);
    assert.ok(outcomes.every(o => !/stopped before it could activate/.test(o)));
    await f.safe();
  });

for (const key of ['Enter', 'Space'])
  test('R4 F1 an existing about:blank frame is pointed at a page whose autofocused widget pays on keyup: ' + key, { skip, timeout: 170000 }, async t => {
    const pf = doc('<div id="p" tabindex="0">Continue</div>', `p.addEventListener('keyup',()=>parent.record('payment'));addEventListener('keyup',()=>parent.record('payment'),true);p.focus();`);
    const { f } = await rounds(t, doc('<input id="a" aria-label="Search"><iframe id="fr" src="about:blank"></iframe>', `a.addEventListener('keydown',()=>{fr.src='/payframe'});`),
      { key, n: 8, routes: { '/payframe': pf } });
    assert.equal(f.delta().payment, 0);
    await f.safe();
  });

for (const host of ['localhost', '127.0.0.1'])
  for (const key of ['Enter', 'Space'])
    test('R4 F2 ' + (host === 'localhost' ? 'cross-site' : 'same-site') + ' frame holds a window capture keyup payer and the keydown handler focuses it: ' + key, { skip, timeout: 170000 }, async t => {
      const b = await bank(t), port = new URL(b.origin).port;
      const frame = doc('<div id="p" tabindex="0">Continue</div>',
        `addEventListener('keyup',e=>{ if(e.isTrusted) fetch('http://127.0.0.1:${port}/effect?kind=payment',{method:'POST',mode:'no-cors',keepalive:true}); },true); p.focus();`);
      const f = await b.start(doc(`<input id="a" aria-label="Search"><iframe id="fr" src="http://${host}:${port}/frame-x" title="payframe"></iframe>`, `a.addEventListener('keydown',()=>fr.focus());`),
        readOnly, { routes: { '/frame-x': frame } });
      await new Promise(resolve => setTimeout(resolve, 600));
      for (let n = 0; n < 6; n++) {
        await f.page.evaluate(() => document.getElementById('a').focus());
        await f.act([{ do: 'press', key }]);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.equal(f.delta().payment, 0);
      await f.safe();
    });

for (const key of ['Enter', 'Space'])
  test('R4 F7 the keydown handler rewrites the page with document.open and the new content pays on keyup: ' + key, { skip, timeout: 90000 }, async t => {
    const script = `a.addEventListener('keydown',()=>{ document.open(); document.write('<div id=p tabindex=0>Continue</div><script>p.addEventListener("keyup",()=>parent.record("payment"));addEventListener("keyup",()=>record("payment"),true);p.focus();<\\/script>'); document.close(); });`;
    const { f } = await press(t, doc('<input id="a" aria-label="Search">', script), { key });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.delta().payment, 0);
    await f.safe();
  });

// F3. A value with a line break typed or filled into a single-line input is refused, so it cannot submit a form unchecked.
const paymentForm = `<form id="payment"><p data-payment-item="Fixture item">Item: Fixture item</p><p data-payment-amount="18.00">Amount: 18.00</p><p data-payment-payee="Fixture shop">Payee: Fixture shop</p>
<p data-payment-currency="USD">Currency: USD</p><label>Card<input autocomplete="cc-number"></label><input id="n" aria-label="Note"><textarea id="x" aria-label="Notes"></textarea><button id="pay">Continue</button></form>`;
for (const text of ['\n', '\r', '\r\n', 'abc\n'])
  test('R4 F3 type and fill of ' + JSON.stringify(text) + ' into a text input of a payment form are refused and submit nothing', { skip, timeout: 90000 }, async t => {
    const b = await bank(t), f = await b.start(doc(paymentForm, ''), readOnly);
    const typed = await f.act([{ do: 'type', ref: f.ref('Note'), text }]);
    assert.match(typed.text, /not run: A line break in a single-line input/);
    const filled = await f.fill([{ ref: f.ref('Note'), value: text }]);
    assert.match(JSON.stringify(filled.text), /line break in a single-line input/);
    // A textarea takes line breaks as text.
    const area = await f.act([{ do: 'type', ref: f.ref('Notes'), text }]);
    assert.doesNotMatch(area.text, /not run/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await f.page.evaluate(() => document.getElementById('n').value), '');
    await f.safe();
  });

// F4. Ordinary pages: the key works and the outcome carries no "may have activated" warning.
const ordinary = [
  ['login form whose submit handler disables the button and changes its label', '<form id="lf"><input id="t" aria-label="Username"><input type="password" aria-label="Password"><button id="go">Sign in</button></form>',
    `lf.addEventListener('submit',e=>{e.preventDefault();go.disabled=true;go.textContent='Signing in';window.__ok=1;})`, 'Username', 'Enter', true],
  ['chat textarea synced by a framework (defaultValue), Enter sends', '<form id="cf"><textarea id="t" aria-label="Message"></textarea></form><ul id="log"></ul>',
    `t.addEventListener('input',()=>{t.defaultValue=t.value});t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();log.append(Object.assign(document.createElement('li'),{textContent:t.value}));t.value='';t.defaultValue='';window.__ok=1;}})`, 'Message', 'Enter', true],
  ['chat input synced by a framework (value attribute), Enter sends', '<form id="cf"><input id="t" aria-label="Message"></form>',
    `t.addEventListener('input',()=>t.setAttribute('value',t.value));t.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();t.value='';t.setAttribute('value','');window.__ok=1;}})`, 'Message', 'Enter', true],
  ['chat textarea in a form, Shift+Enter', '<form id="cf"><textarea id="t" aria-label="Message"></textarea></form>',
    `t.addEventListener('input',()=>{t.defaultValue=t.value});t.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.shiftKey)window.__ok=1;})`, 'Message', 'Shift+Enter', true],
  ['todo input appends a checkbox row inside its own form', '<form id="tf" onsubmit="return false"><input id="t" aria-label="New todo"><div id="log"></div></form>',
    `t.addEventListener('keydown',e=>{if(e.key==='Enter'){const l=document.createElement('label');l.innerHTML='<input type=checkbox> '+t.value;log.append(l);t.value='';window.__ok=1;}})`, 'New todo', 'Enter', true],
  ['disclosure button Enter changes its own label', '<button id="t">Show details</button><p id="d" hidden>x</p>',
    `t.addEventListener('click',()=>{d.hidden=!d.hidden;t.textContent=d.hidden?'Show details':'Hide details';window.__ok=1;})`, 'Show details', 'Enter', true],
  ['Save button Enter disables itself on click', '<button id="t">Save draft</button>', `t.addEventListener('click',()=>{t.disabled=true;window.__ok=1;})`, 'Save draft', 'Enter', true],
  ['button Enter opens a modal dialog and focuses inside it (still warns: the key release lands elsewhere)', '<button id="t">Open</button><dialog id="d"><input aria-label="Inside"></dialog>',
    `t.onclick=()=>{d.showModal();window.__ok=1}`, 'Open', 'Enter', false],
];
for (const [name, html, script, label, key, clean] of ordinary)
  test('R4 F4 ordinary use: ' + name, { skip, timeout: 90000 }, async t => {
    const b = await bank(t), f = await b.start(plain(html, script), 'Use the page normally');
    const ref = f.ref(label);
    await f.page.evaluate(() => document.getElementById('t').focus());
    const result = await f.act([{ do: 'press', ref, key }]);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await f.page.evaluate(() => window.__ok), 1, 'the key took effect');
    if (clean) assert.doesNotMatch(result.text.split('\n')[0], /may have activated|effect unconfirmed|not run/);
    else assert.match(result.text.split('\n')[0], /may have activated/);
  });

// F6. A div[role=textbox] composer cannot be tied to a checked receiver by the page alone: it may be a host whose closed root hides
// the real receiver. The Node side asks CDP (DOM.describeNode) whether the div hosts any shadow root. A plain composer is then the
// receiver and the key goes through the key shield; a div that hosts a closed root is still refused with the engine path in the message.
test('R4 F6 Control+Enter in a plain div[role=textbox] composer is tied to it by CDP and sent through the key shield', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(plain('<div id="t" role="textbox" contenteditable="true" aria-label="Composer"></div>', ''), 'Use the page normally');
  const result = await f.act([{ do: 'press', ref: f.ref('Composer'), key: 'Control+Enter' }]);
  assert.doesNotMatch(result.text.split('\n')[0], /not run|CHECKED_FOCUS_REQUIRED/);
});

test('R4 F6 Control+Enter in a div[role=textbox] that hosts a closed shadow root is refused with the engine path in the message', { skip, timeout: 90000 }, async t => {
  const b = await bank(t), f = await b.start(plain('<div id="t" role="textbox" contenteditable="true" aria-label="Composer"></div>', `t.attachShadow({ mode: 'closed' }).innerHTML = '<input aria-label="Inner">';`), 'Use the page normally');
  const result = await f.act([{ do: 'press', ref: f.ref('Composer'), key: 'Control+Enter' }]);
  assert.match(result.text.split('\n')[0], /not run: CHECKED_FOCUS_REQUIRED.*engine browser path/);
});

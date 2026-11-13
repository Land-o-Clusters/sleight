import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, plain, payment, payRequest, readOnly, skip, terms } from './fixtures/bank.mjs';

// Class 2. The page redefines natives in its own (main) world, or shadows them
// with DOM named properties, which cross worlds. Sleight reads page state from a
// separate utility world, but a form's named controls and the document's named
// img/form/object/embed elements shadow properties in every world, and the
// background-popup hook itself runs in the main world beside the page.
const mismatch = (extra = '') => payment.replace('data-payment-amount="18.00">Amount: 18.00', 'data-payment-amount="99.00">Amount: 99.00')
  .replace('<label>Note', extra + '<label>Note');
const maybeRef = (f, label) => { try { return f.ref(label); } catch { return undefined; } };
const deadline = (promise, ms = 20000) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('HUNG'), ms))]);

test('control: the exact authorized payment goes through once with clean natives', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment), payRequest);
  const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.doesNotMatch(result.text, /not run/);
  assert.equal(f.delta().payment, 1);
});

// Main-world redefinitions. The trust reads must not consult any of these.
const overrides = {
  'Document.prototype.activeElement': `Object.defineProperty(Document.prototype,'activeElement',{configurable:true,get(){return document.getElementById('a')}});`,
  'document.activeElement (own property)': `Object.defineProperty(document,'activeElement',{configurable:true,get(){return document.getElementById('a')}});`,
  'HTMLButtonElement.prototype.form': `Object.defineProperty(HTMLButtonElement.prototype,'form',{configurable:true,get(){return null}});`,
  'HTMLInputElement.prototype.form': `Object.defineProperty(HTMLInputElement.prototype,'form',{configurable:true,get(){return null}});`,
  'Element.prototype.checkVisibility': `Element.prototype.checkVisibility=()=>true;`,
  'Element.prototype.getAttribute': `const g=Element.prototype.getAttribute;Element.prototype.getAttribute=function(n){return /payment|aria-label|autocomplete|type/.test(n)?null:g.call(this,n)};`,
  'Element.prototype.hasAttribute': `Element.prototype.hasAttribute=()=>false;`,
  'Node.prototype.textContent': `Object.defineProperty(Node.prototype,'textContent',{configurable:true,get(){return 'Next'},set(){}});`,
  'Element.prototype.closest': `Element.prototype.closest=()=>null;`,
  'Element.prototype.querySelectorAll': `Element.prototype.querySelectorAll=()=>[];`,
  'Element.prototype.getBoundingClientRect': `Element.prototype.getBoundingClientRect=()=>({left:0,top:0,right:9999,bottom:9999,width:9999,height:9999});`,
  'Element.prototype.matches': `Element.prototype.matches=()=>false;`,
  'window.getComputedStyle': `window.getComputedStyle=()=>({opacity:'1',visibility:'visible',display:'block'});`,
  'HTMLElement.prototype.focus': `HTMLElement.prototype.focus=function(){};`,
  'HTMLInputElement.prototype.value': `Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,get(){return '18.00'},set(){}});`,
  'HTMLInputElement.prototype.type': `Object.defineProperty(HTMLInputElement.prototype,'type',{configurable:true,get(){return 'text'}});`,
};
for (const [name, script] of Object.entries(overrides))
  test('main-world override of ' + name + ' cannot launder an unauthorized payment click', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(mismatch() + '<input id="a" aria-label="Search">', script), payRequest);
    const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.match(result.text, /not run|unconfirmed|confirmation/);
    await f.safe();
  });

test('per-element own-property getters for value, form and checkVisibility are invisible to the trust reads', { skip, timeout: 60000 }, async t => {
  const body = `<form id="payment"><p data-payment-item="Fixture item">Item: Fixture item</p>
    <label>Amount<input name="amount" id="amt" value="99.00"></label>
    <p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
    <label>Card<input autocomplete="cc-number"></label><button id="pay">Continue</button></form>`;
  const script = `const amt=document.getElementById('amt'),pay=document.getElementById('pay');
    Object.defineProperty(amt,'value',{get(){return '18.00'}});Object.defineProperty(amt,'checkVisibility',{value:()=>true});
    Object.defineProperty(pay,'form',{get(){return null}});Object.defineProperty(pay,'getAttribute',{value:()=>null});`;
  const b = await bank(t), f = await b.start(doc(body, script), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  await f.safe();
});

// DOM clobbering of document properties by a named element that is the checked ref.
for (const tag of ['img', 'form', 'object', 'embed'])
  test('document.activeElement clobbered by <' + tag + ' name=activeElement> never lets a focus redirect pass the checked-focus test', { skip, timeout: 60000 }, async t => {
    const element = { img: '<img name="activeElement" id="h" tabindex="0" alt="Help" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
      form: '<form name="activeElement" id="h" tabindex="0" aria-label="Help"></form>',
      object: '<object name="activeElement" id="h" tabindex="0" aria-label="Help"></object>',
      embed: '<embed name="activeElement" id="h" tabindex="0" aria-label="Help">' }[tag];
    const b = await bank(t), f = await b.start(doc(element + payment, `h.addEventListener('focus',()=>pay.focus());`), readOnly);
    const ref = maybeRef(f, 'Help');
    if (!ref) { t.diagnostic('the clobbering element is not nameable in the snapshot, so the model cannot press on it'); await f.safe(); return; }
    const real = () => f.page.evaluate(() => Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get.call(document)?.id);
    const result = await f.act([{ do: 'press', ref, key: 'Enter' }]);
    t.diagnostic(JSON.stringify({ realFocusAfter: await real(), outcome: result.text.split('\n')[0] }));
    await f.safe();
  });

test('document.activeElement clobbered by <iframe name=activeElement> (a window, not an element) fails closed', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(`<iframe name="activeElement" src="about:blank" title="frame"></iframe><input id="a" aria-label="Search">` + payment,
    `a.addEventListener('focus',()=>pay.focus());`), readOnly);
  await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  await f.safe();
});

test('clobbered activeElement, defaultView and frameElement inside a same-origin frame cannot satisfy the frame walk', { skip, timeout: 60000 }, async t => {
  const inner = doc(`<img name="activeElement" id="defaultView" tabindex="0" alt="Frame help" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img name="frameElement" alt="x" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`,
    `document.querySelector('[tabindex]').addEventListener('focus',()=>parent.document.getElementById('pay').focus());`);
  const b = await bank(t), f = await b.start(doc('<iframe src="/inner" title="inner"></iframe>' + payment), readOnly, { routes: { '/inner': inner } });
  const ref = maybeRef(f, 'Frame help');
  if (ref) await f.act([{ do: 'press', ref, key: 'Enter' }]);
  await f.safe();
});

// Named controls inside the payment form shadow the form's own properties.
// Page terms disagree with the authorized request, so the safe outcome is no payment.
// A name that makes the reader loop forever is an availability failure, reported as HUNG.
const formNames = ['elements', 'action', 'method', 'submit', 'form', 'target', 'id', 'children', 'attributes', 'localName', 'tagName', 'nodeType',
  'textContent', 'innerText', 'parentElement', 'parentNode', 'ownerDocument', 'querySelectorAll', 'querySelector', 'getAttribute', 'hasAttribute', 'closest',
  'matches', 'contains', 'getRootNode', 'getBoundingClientRect', 'getClientRects', 'checkVisibility', 'clientLeft', 'clientTop', 'clientWidth', 'clientHeight',
  'isConnected', 'shadowRoot', 'labels', 'length', 'checkValidity', 'reset', 'requestSubmit', 'style'];
for (const name of formNames)
  test('payment form control named "' + name + '" shadows the form property without opening a payment or hanging the reader', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(mismatch(`<input name="${name}" value="x" aria-label="Shadow ${name}">`)), payRequest);
    const ref = maybeRef(f, 'Continue');
    if (!ref) { t.diagnostic('snapshot has no Continue ref (the page blinded the reader); nothing can be pressed'); await f.safe(); return; }
    const outcome = await deadline(f.act([{ do: 'click', ref }]));
    assert.notEqual(outcome, 'HUNG', 'the trust read never returned: a control named "' + name + '" stalls the reader in the page renderer');
    await f.safe();
  });

// Document-level named properties used by the trust reads.
const docNames = ['createTreeWalker', 'createRange', 'defaultView', 'querySelector', 'querySelectorAll', 'getElementById', 'body', 'documentElement',
  'elementFromPoint', 'location', 'forms', 'cookie'];
for (const name of docNames)
  test('document property "' + name + '" clobbered by <img name> cannot launder a payment click', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(`<img name="${name}" alt="x" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` + mismatch()), payRequest);
    const outcome = await deadline(f.act([{ do: 'click', ref: f.ref('Continue') }]));
    assert.notEqual(outcome, 'HUNG');
    await f.safe();
  });

// The background-popup hook runs in the page's own world. Its natives can be
// shadowed or restored by the page. The browser's tab active bit, read by an
// independent observer, proves whether a tab came to the foreground.
const landed = b => ({ '/landed': '<!doctype html><title>landed</title><h1>Landed</h1>', '/danger': (req, res) => { b.effects.payment++; res.end('<h1>danger</h1>'); } });

test('control: a target=_blank form submit opens a background tab (no active-tab change)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed" target="_blank"><button id="send">Send</button></form>'), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Send') }]);
  await f.safe({ settle: 600 });
});

test('document.querySelector overridden to hide <base target=_blank> keeps a form submit out of the foreground', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const html = plain('<form action="/landed"><button id="send">Send</button></form>', `document.querySelector=()=>null;`, '<base target="_blank">');
  const f = await b.start(html, readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Send') }]);
  await f.safe({ settle: 800 });
});

test('Document.prototype.querySelector overridden to hide <base target=_blank> keeps a link out of the foreground', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const html = plain('<a id="go" href="/landed">Open page</a>', `Document.prototype.querySelector=function(){return null};`, '<base target="_blank">');
  const f = await b.start(html, readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Open page') }]);
  await f.safe({ settle: 800 });
});

test('window.name set to _blank makes target=_blank look like the current context, link click stays in the background', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="go" href="/landed" target="_blank">Open page</a>', `window.name='_blank';`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Open page') }]);
  await f.safe({ settle: 800 });
});

test('window.name set to _blank, form target=_blank submit stays in the background', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed" target="_blank"><button id="send">Send</button></form>', `window.name='_blank';`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Send') }]);
  await f.safe({ settle: 800 });
});

// The agent's Ctrl-click keeps a page-opened tab in the background only while the
// modifier is held. A timer that fires after the click has finished still has
// transient user activation, and its programmatic anchor click or form submit
// opens a normal foreground tab. window.open from an owned background tab is
// refused by the browser itself, so it is the control.
const delayed = {
  'anchor.click() inside the agent click handler': ['a.click()', true],
  'window.open() 700 ms after the agent click': ["setTimeout(()=>window.open('/landed'),700)", true],
  'anchor.click() 100 ms after the agent click': ['setTimeout(()=>a.click(),100)'],
  'anchor.click() 700 ms after the agent click': ['setTimeout(()=>a.click(),700)'],
  'form.submit() to target=_blank 700 ms after the agent click': ['setTimeout(()=>f.submit(),700)'],
  'form.requestSubmit() to target=_blank 700 ms after the agent click': ['setTimeout(()=>f.requestSubmit(),700)'],
};
for (const [name, [body, control]] of Object.entries(delayed))
  test((control ? 'control: ' : '') + name + ' never brings a tab to the foreground', { skip, timeout: 90000 }, async t => {
    const b = await bank(t, { observeTabs: true });
    const script = `document.getElementById('go').addEventListener('click',()=>{const a=document.getElementById('a'),f=document.getElementById('f');${body}});`;
    const f = await b.start(plain('<a id="a" href="/landed" target="_blank" hidden>x</a><form id="f" action="/landed" target="_blank"></form><button id="go" type="button">Open help</button>', script),
      readOnly, { routes: landed(b) });
    await f.act([{ do: 'click', ref: f.ref('Open help') }]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    t.diagnostic(JSON.stringify({ requestsSeen: f.hits().map(h => h.path), tabs: (await b.tabState()).map(x => x.url.replace(b.origin, '') + (x.active ? ' ACTIVE' : '')) }));
    await f.safe({ settle: 300 });
  });

test('control: an ordinary preventDefault on the link click stops sleight from opening it', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="l" href="/danger" target="_blank">Learn more</a>', `document.getElementById('l').addEventListener('click',e=>e.preventDefault());`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await f.safe({ settle: 800 });
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/danger')), []);
});

test('pristine Event.prototype.preventDefault from a frame realm cannot make sleight open a link the page cancelled', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `const pd=document.getElementById('r').contentWindow.Event.prototype.preventDefault;
    document.getElementById('l').addEventListener('click',e=>pd.call(e));`;
  const f = await b.start(plain('<iframe id="r" src="about:blank" hidden></iframe><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await f.safe({ settle: 800 });
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/danger')), [], 'the page cancelled the click; no request for the link target may follow');
});

test('inline onclick cancel through a frame-realm preventDefault cannot make sleight open the link', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const html = plain('<iframe id="r" src="about:blank" hidden></iframe><a id="l" href="/danger" target="_blank" onclick="document.getElementById(\'r\').contentWindow.Event.prototype.preventDefault.call(event)">Learn more</a>');
  const f = await b.start(html, readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await f.safe({ settle: 800 });
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/danger')), []);
});

// Round 2 of the popup hook. Every page here is a script-started or keyboard-started opening, a cancel from
// another realm, or a nested document. The browser's own tab active bit and the fixture server's request log
// decide the outcome; /danger is a request that must never be made, /landed one the agent's link may make.
const dangerHits = f => f.hits().filter(h => h.path.startsWith('/danger')).map(h => h.path);
const landedHits = f => f.hits().filter(h => h.path.startsWith('/landed')).map(h => h.path);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a window handle from an earlier agent click cannot cancel a later link click behind sleight (A1)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>{window.__w=window.open('/landed','w')};
    document.getElementById('l').addEventListener('click',e=>{if(window.__w)window.__w.Event.prototype.preventDefault.call(e)});`;
  const f = await b.start(plain('<button id="go" type="button">Go</button><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(800);
  await f.act([{ do: 'click', ref: f.ref('Learn more', await f.read()) }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), [], 'the handle cancelled the click; no request for the link target may follow');
  await f.safe({ settle: 300 });
});

for (const [name, make] of Object.entries({
  'detached html anchor': `const a=document.createElement('a');a.href='/danger';a.target='_blank';`,
  'svg anchor': `const a=document.createElementNS('http://www.w3.org/2000/svg','a');a.setAttribute('href','/danger');a.setAttribute('target','_blank');`,
  'child of a detached anchor': `const p=document.createElement('a');p.href='/danger';p.target='_blank';const a=document.createElement('span');p.append(a);`,
})) test('dispatchEvent(click) on a ' + name + ' never opens a tab (A2)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>setTimeout(()=>{${make}a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))},400)`;
  const f = await b.start(plain('<button id="go" type="button">Go</button>', script), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1500);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('w.focus() on a popup the page opened during an agent click does not raise it (A3)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<button id="go" type="button">Go</button>', `go.onclick=()=>{const w=window.open('/landed','w');setTimeout(()=>{try{w.focus()}catch(e){}},700)}`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1800);
  await f.safe({ settle: 300 });
});

test('a script click on a link to a known named window does not navigate and raise it (A3)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/danger" target="w" hidden>x</a><button id="go" type="button">Go</button>',
    `go.onclick=()=>{window.open('/landed','w');setTimeout(()=>a.click(),700)}`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1800);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('the agent clicking a link to a known named window keeps it in the background (A3)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/landed?second" target="w">Open again</a><button id="go" type="button">Go</button>',
    `go.onclick=()=>{window.open('/landed','w')}`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(800);
  const result = await f.act([{ do: 'click', ref: f.ref('Open again', await f.read()) }]);
  await pause(1200);
  assert.ok(landedHits(f).some(path => path.includes('second')), 'the link was opened: ' + landedHits(f));
  assert.equal((await b.tabState()).filter(x => x.url.includes('/landed')).length, 1, 'the named window was reused, not duplicated');
  await f.safe({ settle: 300 });
});

test('Enter on a focused target=_blank link opens it in the background (A4)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/landed" target="_blank">Open it</a>'), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'press', ref: f.ref('Open it'), key: 'Enter' }]);
  await pause(1200);
  assert.deepEqual(landedHits(f), ['/landed'], result.text);
  await f.safe({ settle: 300 });
});

for (const [name, body, ref] of [
  ['in a text field of', '<input aria-label="Query" name="q">', 'Query'],
  ['on a focused submit button of', '<button id="send">Send</button>', 'Send'],
]) test('Enter ' + name + ' a target=_blank form is refused before it can raise a tab (A4)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed" target="_blank">' + body + '</form>'), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'press', ref: f.ref(ref), key: 'Enter' }]);
  await pause(1200);
  assert.match(result.text, /not run: .*click its submit button/, result.text.split('\n')[0]);
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('Enter in a text field of a same-tab form still submits (A4)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed"><input aria-label="Query" name="q"></form>'), readOnly, { routes: landed(b) });
  await f.act([{ do: 'press', ref: f.ref('Query'), key: 'Enter' }]);
  await pause(1000);
  assert.deepEqual(landedHits(f), ['/landed?q=']);
  await f.safe({ settle: 300, tabs: false });
});

const frames = {
  'hidden srcdoc iframe': '<iframe hidden srcdoc="<p>hi</p>"></iframe>',
  'hidden about:blank iframe': '<iframe hidden src="about:blank"></iframe>',
  'chat widget iframe created by script': '',
};
for (const [name, markup] of Object.entries(frames))
  test('a new-tab link click still works beside a ' + name + ' (A5)', { skip, timeout: 90000 }, async t => {
    const b = await bank(t, { observeTabs: true });
    const script = markup ? '' : `const fr=document.createElement('iframe');fr.style.display='none';document.body.append(fr);fr.contentDocument.write('<p>widget</p>');`;
    const f = await b.start(plain('<a id="a" href="/landed" target="_blank">Open docs</a>' + markup, script), readOnly, { routes: landed(b) });
    const result = await f.act([{ do: 'click', ref: f.ref('Open docs') }]);
    await pause(1200);
    assert.doesNotMatch(result.text, /unconfirmed|not captured|link default changed/, result.text.split('\n')[0]);
    assert.deepEqual(landedHits(f), ['/landed']);
    await f.safe({ settle: 300 });
  });

test('a srcdoc iframe realm that cancels the click still stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `const pd=document.getElementById('r').contentWindow.Event.prototype.preventDefault;
    document.getElementById('l').addEventListener('click',e=>pd.call(e));`;
  const f = await b.start(plain('<iframe id="r" hidden srcdoc="<p>hi</p>"></iframe><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

for (const [name, body] of Object.entries({
  'after an await': `go.onclick=async()=>{await fetch('/landed?f');a.click()}`,
  'in a zero-delay timer': `go.onclick=()=>{setTimeout(()=>a.click(),0)}`,
})) test('a script link click ' + name + ' is held and the result says so (A6)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/landed" target="_blank" hidden>x</a><button id="go" type="button">Go</button>', body), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'click', ref: f.ref('Go') }]);
  assert.match(result.text, /page script tried to open .*held/i, result.text.split('\n').slice(0, 3).join(' | '));
  await pause(500);
  assert.deepEqual(landedHits(f).filter(path => path === '/landed'), []);
  await f.safe({ settle: 300 });
});

test('a click that opens nothing from script carries no held-opening sentence (A6)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<button id="go" type="button">Go</button>', `go.onclick=()=>{document.title='x'}`), readOnly);
  const result = await f.act([{ do: 'click', ref: f.ref('Go') }]);
  assert.doesNotMatch(result.text, /tried to open/i);
  await f.safe({ settle: 300 });
});

test('a preventDefault taken from an iframe the page then removed still stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `const fr=document.getElementById('r'),pd=fr.contentWindow.Event.prototype.preventDefault;fr.remove();
    document.getElementById('l').addEventListener('click',e=>pd.call(e));`;
  const f = await b.start(plain('<iframe id="r" hidden srcdoc="<p>hi</p>"></iframe><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('a forged hook object on a window handle does not hide that window from the cancel check (A1)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>{const w=window.__w=window.open('/landed','w');window.__nat=w.Event.prototype.preventDefault;
      w.Event.prototype.preventDefault=function(){return top.Event.prototype.preventDefault.call(this)};const K=Object.getOwnPropertyNames(window).find(n=>/^k[0-9a-f]{32}$/.test(n));Object.defineProperty(w,K,{value:{cancel(){}},configurable:true});};
    document.getElementById('l').addEventListener('click',e=>window.__nat.call(e));`;
  const f = await b.start(plain('<button id="go" type="button">Go</button><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(800);
  await f.act([{ do: 'click', ref: f.ref('Learn more', await f.read()) }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), [], 'documented limit if this fails: a page holding a native preventDefault from an unhooked window');
  await f.safe({ settle: 300 });
});

test('a capture listener that stops propagation first cannot let a detached link click open a tab (A2)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_blank';
    a.addEventListener('click',e=>e.stopImmediatePropagation(),true);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))},400)`;
  const f = await b.start(plain('<button id="go" type="button">Go</button>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1500);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// Round 3 of the popup hook. "Foreground" is the browser's own tab active bit: f.safe() compares it with the
// value at start and counts focus commands on the wire. /danger must never be requested, /landed may be.
async function attack(t, { body = '', script = '', steps, wait = 1500, routes = {}, probe } = {}) {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<button id="go" type="button">Go</button>' + body, script), readOnly, { routes: { ...landed(b), ...routes } });
  const result = await f.act(steps ? steps(f) : [{ do: 'click', ref: f.ref('Go') }]);
  await pause(wait);
  return { b, f, result, extra: probe ? await probe(f, b) : undefined };
}
const press = (label, key = 'Enter') => f => [{ do: 'press', ref: f.ref(label), key }];
const click = label => f => [{ do: 'click', ref: f.ref(label) }];
const first = result => result.text.split('\n')[0];

// A1: a window.open handle's first document carries the whole hook, so a native saved from it is the hooked one.
for (const [name, body, use] of [
  ['EventTarget.prototype.dispatchEvent on a detached link', '', `const d=w.EventTarget.prototype.dispatchEvent;setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_blank';d.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)`],
  ['HTMLFormElement.prototype.submit on a target=_blank form', '<form id="fm" action="/danger" target="_blank"><input name="q" value="1"></form>', `const s=w.HTMLFormElement.prototype.submit;setTimeout(()=>s.call(fm),400)`],
  ['HTMLFormElement.prototype.requestSubmit on a target=_blank form', '<form id="fm" action="/danger" target="_blank"><input name="q" value="1"></form>', `const s=w.HTMLFormElement.prototype.requestSubmit;setTimeout(()=>s.call(fm),400)`],
  ['HTMLElement.prototype.click on a target=_blank link', '<a id="a" href="/danger" target="_blank" hidden>x</a>', `const c=w.HTMLElement.prototype.click;setTimeout(()=>c.call(a),400)`],
  ['window.open called on the opener', '', `const o=w.open;setTimeout(()=>o.call(window,'/danger','_blank'),400)`],
  ['focus() on the popup', '', `const fc=w.focus;setTimeout(()=>fc.call(w),400)`],
]) test('a native saved from a window handle cannot open or raise a tab later: ' + name + ' (A1)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body, script: `go.onclick=()=>{const w=window.open('/landed');${use}}` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('the handle realm runs the hook, not just a forwarded preventDefault (A1)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>{const w=window.open('/landed');window.__w=w;
    window.__x=[typeof w[Object.getOwnPropertyNames(w).find(n=>/^k[0-9a-f]{32}$/.test(n))],w.open('/danger','_blank')===null,String(w.HTMLElement.prototype.click).includes('native code')].join()}` });
  // The last value is whether the handle realm's click wrapper reads as native: it does, since the hook dresses every native it replaces (keyboard-compat.real).
  assert.equal(await f.page.evaluate(() => window.__x), 'object,true,true');
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// A2: checks accept a node from any realm and look through shadow roots.
test('a hooked iframe realm dispatchEvent cannot click a detached target=_blank link (A2)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>{const fr=document.createElement('iframe');document.body.append(fr);const d=fr.contentWindow.EventTarget.prototype.dispatchEvent;
    setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_blank';d.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)}` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('the top-realm dispatchEvent cannot click a link created in an iframe document (A2)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>{const fr=document.createElement('iframe');document.body.append(fr);const doc=fr.contentDocument;
    setTimeout(()=>{const a=doc.createElement('a');a.href='/danger';a.target='_blank';EventTarget.prototype.dispatchEvent.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)}` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

for (const [name, fire] of Object.entries({
  'dispatchEvent on an attached link': `a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`,
  'click() on a span inside the link': `const s=document.createElement('span');a.append(s);s.click()`,
  'dispatchEvent on a span inside the link': `const s=document.createElement('span');a.append(s);s.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`,
})) test('a link in a closed shadow root is held: ' + name + ' (A2)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>setTimeout(()=>{const h=document.createElement('div');document.body.append(h);const sr=h.attachShadow({mode:'closed'});
    const a=document.createElement('a');a.href='/danger';a.target='_blank';sr.append(a);${fire}},300)` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// A4: every spelling of Enter arms the hook; a press whose destination cannot be decided is refused.
test('NumpadEnter on a target=_blank link opens in the background like Enter (A4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_blank">Open it</a>', steps: press('Open it', 'NumpadEnter') });
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  await f.safe({ settle: 300 });
});

for (const [name, body, ref] of [
  ['a submit button outside the form with formtarget=_blank', '<form id="fm" action="/landed"></form><button form="fm" formtarget="_blank" id="b">Send out</button>', 'Send out'],
  ['a field whose default submit button sits outside the form with formtarget=_blank', '<form id="fm" action="/landed"><input name="q" aria-label="Query" value="x"></form><button form="fm" formtarget="_blank" type="submit">Go out</button>', 'Query'],
  ['a field whose form= attached default button has formtarget=new-name', '<form id="fm" action="/landed"></form><input form="fm" name="q" aria-label="Query" value="x"><button form="fm" formtarget="elsewhere">Go out</button>', 'Query'],
]) test('Enter on ' + name + ' is refused before it can raise a tab (A4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, steps: press(ref) });
  assert.match(result.text, /not run: .*click its submit button/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('Enter in a field submits the form when only a later button has formtarget=_blank (A4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form action="/landed"><input name="q" aria-label="Query"><button>Search</button><button type="submit" formtarget="_blank">Search in a new tab</button></form>',
    steps: press('Query'), wait: 1000 });
  assert.doesNotMatch(result.text, /not run/, first(result));
  assert.deepEqual(landedHits(f), ['/landed?q=']);
  await f.safe({ settle: 300, tabs: false });
});

for (const [name, href] of [['credentials in its address', 'http://u:p@127.0.0.1:1/landed'], ['an about:blank address', 'about:blank']]) {
  test('Enter on a target=_blank link with ' + name + ' is refused (A4)', { skip, timeout: 90000 }, async t => {
    const { f, result } = await attack(t, { body: `<a id="a" href="${href}" target="_blank">Open it</a>`, steps: press('Open it') });
    assert.match(result.text, /not run: .*cannot check where it goes/, first(result));
    await f.safe({ settle: 300 });
  });
  test('a click on a target=_blank link with ' + name + ' still stays in the background (A4)', { skip, timeout: 90000 }, async t => {
    const { f, result } = await attack(t, { body: `<a id="a" href="${href}" target="_blank">Open it</a>`, steps: click('Open it') });
    assert.doesNotMatch(result.text, /not run/, first(result));
    await f.safe({ settle: 300 });
  });
}

// A5: a cancel through a hooked realm's returnValue setter reaches the clicked page.
test('returnValue=false through a hooked iframe realm setter stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<iframe id="r" hidden srcdoc="<p>hi</p>"></iframe><a id="l" href="/danger" target="_blank">Learn more</a>',
    script: `const set=Object.getOwnPropertyDescriptor(document.getElementById('r').contentWindow.Event.prototype,'returnValue').set;
      document.getElementById('l').addEventListener('click',e=>set.call(e,false))`, steps: click('Learn more') });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('returnValue=false through a setter saved from a window handle stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<a id="l" href="/danger" target="_blank">Learn more</a>',
    script: `go.onclick=()=>{const w=window.open('/landed');window.__s=Object.getOwnPropertyDescriptor(w.Event.prototype,'returnValue').set};
      document.getElementById('l').addEventListener('click',e=>{if(window.__s)window.__s.call(e,false)})` });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// A link's or form's own listener changes the destination after the hook decided it was a plain click.
const flip = 'a.addEventListener("click",()=>{a.target="_blank"})';
for (const [name, body, script, steps] of [
  ['its own click listener', '<a id="a" href="/landed" target="_self">Open it</a>', flip, click('Open it')],
  ['a document capture listener', '<a id="a" href="/landed" target="_self">Open it</a>', 'document.addEventListener("click",()=>{a.target="_blank"},true)', click('Open it')],
  ['a base element added by a listener', '<a id="a" href="/landed">Open it</a>', 'a.addEventListener("click",()=>{const b=document.createElement("base");b.target="_blank";document.head.append(b)})', click('Open it')],
  ['its own listener, then Enter', '<a id="a" href="/landed" target="_self">Open it</a>', flip, press('Open it')],
]) test('a same-tab link that turns into a new-tab link in ' + name + ' opens in the background (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script, steps });
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  await f.safe({ settle: 300 });
});

// A change before the click lands is a swap: the dispatch guard (AD1 swap) cancels the input instead of the hook opening the link.
test('a same-tab link that turns into a new-tab link in a pointerdown listener is stopped by the dispatch guard (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_self">Open it</a>', script: 'a.addEventListener("pointerdown",()=>{a.target="_blank"})', steps: click('Open it') });
  assert.match(result.text, /page changed during the click/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('a same-tab link whose listener flips it to a new tab pointing at credentials is stopped (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_self">Open it</a>',
    script: 'a.addEventListener("click",()=>{a.target="_blank";a.href="http://u:p@127.0.0.1:1/x"})', steps: click('Open it') });
  assert.match(result.text, /changed this link/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('a new-tab link that flips to same-tab in its listener opens nothing and says so (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_blank">Open it</a>',
    script: 'a.addEventListener("click",()=>{a.target="_self"})', steps: click('Open it') });
  assert.match(result.text, /changed|not captured/, first(result));
  await f.safe({ settle: 300 });
});

for (const [name, script] of [
  ['its submit button listener', 's.addEventListener("click",()=>{fm.target="_blank"})'],
  ['its submit listener', 'fm.addEventListener("submit",()=>{fm.target="_blank"})'],
  ['a formtarget set on the button', 's.addEventListener("click",()=>{s.setAttribute("formtarget","_blank")})'],
]) test('a same-tab form that turns into a new-tab form in ' + name + ' is stopped (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed"><button id="s">Save it</button></form>', script, steps: click('Save it') });
  assert.match(result.text, /changed this form/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('Enter in a same-tab form whose submit listener turns it into a new-tab form is stopped (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed"><input name="q" aria-label="Query"><button>Search</button></form>',
    script: 'fm.addEventListener("submit",()=>{fm.target="_blank"})', steps: press('Query') });
  assert.match(result.text, /changed this form/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('a same-tab form still submits when a listener only observes the click (flip control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed"><button id="s">Save it</button></form>',
    script: 's.addEventListener("click",()=>{window.__seen=1})', steps: click('Save it'), wait: 1000 });
  assert.doesNotMatch(result.text, /changed|not run/, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300, tabs: false });
});

// window.focus is a no-op for a top-level window, never for a frame.
test('iframe.contentWindow.focus() still focuses the frame (focus)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<iframe id="ed" title="editor" srcdoc="<body contenteditable>hello</body>" width=300 height=100></iframe>',
    script: `go.onclick=()=>{ed.contentWindow.focus();window.__x=document.activeElement.tagName+':'+ed.contentDocument.hasFocus()}` });
  assert.equal(await f.page.evaluate(() => window.__x), 'IFRAME:true');
  await f.safe({ settle: 300 });
});

// Known gap, reported: a script-started click on a link whose target a listener changes in a way the hook cannot see (a
// base element it adds; setters, setAttribute and Attr values are caught) still raises the tab. The result must not call
// that tab a background tab.
test('a script click that flips its own link through a new base element after an unmodified click is reported as a probable foreground tab (known gap)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="l1" href="/landed?start">Start</a><a id="a2" href="/landed" hidden>x</a>',
    script: 'a2.addEventListener("click",()=>{const b=document.createElement("base");b.target="_blank";document.head.append(b)});document.getElementById("l1").addEventListener("click",e=>{e.preventDefault();setTimeout(()=>a2.click(),50)})',
    steps: click('Start') });
  assert.match(result.text, /probably took the foreground/, first(result));
  assert.doesNotMatch(result.text, /opened background tab/);
});

for (const [name, body] of Object.entries({
  'a user-blocking scheduler task': `go.onclick=()=>{scheduler.postTask(()=>window.open('/danger'),{priority:'user-blocking'})}`,
  'a message channel task': `go.onclick=()=>{const m=new MessageChannel();m.port1.onmessage=()=>window.open('/danger');m.port2.postMessage(1)}`,
  'a zero-delay timer': `go.onclick=()=>{setTimeout(()=>window.open('/danger'),0)}`,
})) test('window.open from ' + name + ' started by an agent click is held, not raised (dispatch end)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { script: body });
  assert.match(result.text, /page script tried to open .*held/i, first(result));
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// ---- AD1 pop round 4. The round 3 review's repros (its p7, p9, p10 and p11 files), one test each, plus the fixes' own controls.
// A case passes when the browser's active tab did not change, nothing asked for /danger (the payment route), and the result says
// what happened. Cases whose page legitimately ends up in a background tab point at /landed instead of /danger.
const R4_SELF = '<a id="a" href="/danger" target="_self">open docs</a>';
const R4_BLANK = '<a id="a" href="/danger" target="_blank">open docs</a>';
const R4_HELD = /page script tried to open .*held/i;
const R4_XO = "location.origin.replace('127.0.0.1','localhost')";
const r4Mouse = (type, init) => `new MouseEvent('${type}',{bubbles:true,cancelable:true,${init}})`;
// The held count reaches the result of the click that was running when the script fired; a script that fires after the click's
// settling is counted in the next call, which is read directly here.
const r4Quiet = async (f, result, { held = false } = {}) => {
  if (held && !R4_HELD.test(result.text)) assert.ok(await f.entry.takeHeld() > 0, 'the page script\'s opening was held: ' + first(result));
  assert.deepEqual(dangerHits(f), [], first(result));
  await f.safe({ settle: 300 });
};
// A tab that opened after the click's result was built is reported by the next click or key press.
const r4Reported = async (f, result) => {
  if (/probably took the foreground/.test(result.text)) return result;
  await pause(500);
  return f.act([{ do: 'click', ref: f.ref('Noop', await f.read()) }]);
};

// F1. A synthetic click with a modifier or a non-primary button picks a window or tab from the event itself.
const r4ClosedShadow = event => `const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});const l=document.createElement('a');l.href='/danger';s.append(l);l.dispatchEvent(${event})`;
for (const [name, body, code, inside = false] of [
  ['shiftKey on a same-tab link', R4_SELF, `a.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['ctrlKey and metaKey on a same-tab link', R4_SELF, `a.dispatchEvent(${r4Mouse('click', 'ctrlKey:true,metaKey:true')})`],
  ['ctrl, meta and shift on a same-tab link', R4_SELF, `a.dispatchEvent(${r4Mouse('click', 'ctrlKey:true,metaKey:true,shiftKey:true')})`],
  ['altKey on a same-tab link', R4_SELF, `a.dispatchEvent(${r4Mouse('click', 'altKey:true')})`],
  ['button 1 on a same-tab link', R4_SELF, `a.dispatchEvent(${r4Mouse('click', 'button:1')})`],
  ['an auxclick MouseEvent on a same-tab link', R4_SELF, `a.dispatchEvent(${r4Mouse('auxclick', 'button:1')})`],
  ['an auxclick PointerEvent on a same-tab link', R4_SELF, "a.dispatchEvent(new PointerEvent('auxclick',{bubbles:true,cancelable:true,button:1}))"],
  ['a PointerEvent click with shiftKey on a same-tab link', R4_SELF, "a.dispatchEvent(new PointerEvent('click',{bubbles:true,cancelable:true,shiftKey:true}))"],
  ['shiftKey on a same-tab submit button', '<form action="/danger"><button id="sb" type="submit">s</button></form>', `sb.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['shiftKey on a label for a submit button', '<form action="/danger"><button id="sb" type="submit">s</button></form><label id="lb" for="sb">l</label>', `lb.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['shiftKey on a link in a closed shadow root', '', r4ClosedShadow(r4Mouse('click', 'shiftKey:true'))],
  ['shiftKey on a detached link', '', `const l=document.createElement('a');l.href='/danger';l.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['shiftKey on an image map area', '<img usemap="#m" width=20 height=20 src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><map name="m"><area id="ar" shape="rect" coords="0,0,20,20" href="/danger"></map>', `ar.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['a click that cannot be cancelled on a connected new-tab link', R4_BLANK, "a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:false}))"],
  ['shiftKey inside the agent click handler itself', R4_SELF, `a.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`, true],
  ['ctrlKey inside the agent click handler, on a submit button', '<form action="/danger"><button id="sb" type="submit">s</button></form>', `sb.dispatchEvent(${r4Mouse('click', 'ctrlKey:true')})`, true],
  ['button 1 inside the agent click handler, on a link in a closed shadow root', '', r4ClosedShadow(r4Mouse('click', 'button:1')), true],
]) test('a synthetic click: ' + name + ' is held and opens nothing (F1)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script: inside ? `go.onclick=()=>{${code}}` : `go.onclick=()=>setTimeout(()=>{${code}},300)` });
  await r4Quiet(f, result, { held: true });
});

test('a modified click from a native saved out of a window handle is held too (F1)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: R4_SELF, script: `go.onclick=()=>{const w=window.open('/landed');const d=w.EventTarget.prototype.dispatchEvent;setTimeout(()=>d.call(a,${r4Mouse('click', 'shiftKey:true')}),400)}` });
  await r4Quiet(f, { text: '' });
});

test('an ordinary synthetic click on a same-tab link still follows the link (F1 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_self">open docs</a>', script: `go.onclick=()=>setTimeout(()=>a.dispatchEvent(${r4Mouse('click', '')}),300)` });
  assert.doesNotMatch(result.text, R4_HELD, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300, tabs: false });
});

// F2. The name a link or form target resolves to can change without any attribute changing.
const r4NameLink = '<a id="a" href="/landed" target="x">Open it</a>';
const r4Opens = async (f, result) => {
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  assert.doesNotMatch(result.text, /probably took the foreground/, first(result));
  await f.safe({ settle: 300 });
};
test('a click listener that renames the window sends the link to a background tab, not the foreground (F2)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: r4NameLink, script: "window.name='x';a.addEventListener('click',()=>{window.name='other'})", steps: click('Open it') });
  await r4Opens(f, result);
});
test('a click listener that renames a frame window sends the link to a background tab (F2)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<iframe name="fr" title="frame"></iframe><a id="a" href="/landed" target="fr">Open it</a>',
    script: "a.addEventListener('click',()=>{document.querySelector('iframe').contentWindow.name='zz'})", steps: click('Open it') });
  await r4Opens(f, result);
});
test('a name set through a frame\'s own window.name setter reaches the top window\'s watch (F2)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<iframe id="fr" title="frame"></iframe>' + r4NameLink,
    script: "window.name='x';const set=Object.getOwnPropertyDescriptor(fr.contentWindow,'name').set;a.addEventListener('click',()=>{set.call(window,'other')})", steps: click('Open it') });
  await r4Opens(f, result);
});
test('Enter on a link whose listener renames the window opens it in the background (F2)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: r4NameLink, script: "window.name='x';a.addEventListener('click',()=>{window.name='other'})", steps: press('Open it') });
  await r4Opens(f, result);
});
test('a submit listener that renames the window stops a form that was aimed at it (F2)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed" target="x"><button type="submit">Send</button></form>',
    script: "window.name='x';fm.addEventListener('submit',()=>{window.name='other'})", steps: click('Send') });
  assert.match(result.text, /changed this form/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});
test('a listener that sets the window name to what it already was changes nothing (F2 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: r4NameLink, script: "window.name='x';a.addEventListener('click',()=>{window.name='x'})", steps: click('Open it') });
  assert.doesNotMatch(result.text, /changed|not captured|foreground/, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300, tabs: false });
});
test('renaming an iframe element\'s name attribute does not rename its window, so the link still loads the frame (F2 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<iframe name="fr" title="frame"></iframe><a id="a" href="/landed" target="fr">Open it</a>',
    script: "a.addEventListener('click',()=>{document.querySelector('iframe').setAttribute('name','zz')})", steps: click('Open it') });
  assert.doesNotMatch(result.text, /foreground|changed this/, first(result));
  await f.safe({ settle: 300 });
});

// F3. A page raising a window it opened from another origin: nothing in the page or in CDP stops it, so the result says it can.
const r4Pop = "<!doctype html><title>pop</title><script>window.__ev=[];for(const t of ['focus','blur','visibilitychange','pagehide','resize'])addEventListener(t,()=>__ev.push(t),true);const f=window.focus;window.focus=function(){__ev.push('focus-called');return f.apply(this,arguments)}<\/script>";
test('a cross-origin popup the page can raise with focus() is listed in the result, and sleight sends no focus command (F3)', { skip, timeout: 90000 }, async t => {
  const { b, f, result, extra } = await attack(t, { wait: 2500, routes: { '/pop': r4Pop },
    script: `go.onclick=()=>{const w=window.open(${R4_XO}+'/pop');setTimeout(()=>{try{w.focus()}catch(e){}},1200)}`,
    probe: async (g, bank) => { const events = []; for (const p of bank.host.pages()) if (p.url().endsWith('/pop')) events.push(await p.evaluate(() => window.__ev)); return events; } });
  assert.match(result.text, /Tab t\w+ \(opened by this page, another origin\) can be raised to the foreground by the page/, first(result));
  t.diagnostic('active tabs after the opener called focus(): ' + (await b.tabState()).filter(x => x.active).map(x => x.url.replace(b.origin, '')).join(', '));
  assert.deepEqual(extra.flat(), [], 'the popup\'s own document sees no focus call and no event when the opener raises it, so no hook there can stop it');
  assert.deepEqual(b.wire.filter(x => ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(x.method)), []);
  assert.deepEqual(dangerHits(f), []);
});
test('a second click that makes the page call focus() on its cross-origin sign-in popup says the page can raise it (F3)', { skip, timeout: 90000 }, async t => {
  const { f, b } = await attack(t, { body: '<button id="go2" type="button">Sign in again</button>', wait: 1500,
    script: `window.__p=null;const si=()=>{if(window.__p&&!window.__p.closed){window.__p.focus();return}window.__p=window.open(${R4_XO}+'/idp','idp','width=480,height=640')};go.onclick=si;go2.onclick=si`,
    routes: { '/idp': '<!doctype html><title>idp</title><h1>IdP</h1><button id="b">Allow</button>' } });
  await pause(1500);
  const second = await f.act([{ do: 'click', ref: f.ref('Sign in again', await f.read()) }]);
  assert.match(second.text, /can be raised to the foreground by the page at any time, and sleight cannot block or detect that/, first(second));
  assert.deepEqual(b.wire.filter(x => ['Page.bringToFront', 'Target.activateTarget', 'Browser.setWindowBounds'].includes(x.method)), []);
});
test('a same-origin sign-in popup is not listed and its focus() raises nothing (F3 control)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<button id="go2" type="button">Sign in again</button>', wait: 1500,
    script: "window.__p=null;const si=()=>{if(window.__p&&!window.__p.closed){window.__p.focus();return}window.__p=window.open('/idp','idp','width=480,height=640')};go.onclick=si;go2.onclick=si",
    routes: { '/idp': '<!doctype html><title>idp</title><h1>IdP</h1><button id="b">Allow</button>' } });
  await pause(1500);
  const second = await f.act([{ do: 'click', ref: f.ref('Sign in again', await f.read()) }]);
  assert.doesNotMatch(second.text, /can be raised/, first(second));
  await f.safe({ settle: 300 });
});
test('a cross-origin popup that does not call focus() stays in the background and is still listed (F3 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { wait: 2000, script: `go.onclick=()=>{window.open(${R4_XO}+'/landed')}` });
  assert.match(result.text, /can be raised to the foreground by the page/, first(result));
  await f.safe({ settle: 300 });
});

test('a cross-origin popup opened with noopener gives the page no handle, so it is not listed (F3 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { wait: 2000, script: `go.onclick=()=>{window.open(${R4_XO}+'/landed','_blank','noopener')}` });
  assert.doesNotMatch(result.text, /can be raised/, first(result));
  await f.safe({ settle: 300 });
});
test('a cross-origin target=_blank link (noopener by default) is not listed either (F3 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { wait: 1500, body: `<a id="a" href="http://localhost:1/x" target="_blank">elsewhere</a>`, script: `a.href=${R4_XO}+'/landed'`, steps: click('elsewhere') });
  assert.doesNotMatch(result.text, /can be raised/, first(result));
  await f.safe({ settle: 300 });
});

// F4. Script-started clicks and submits that a listener re-aims while they are being dispatched.
for (const [name, body, script] of [
  ['a detached link whose own listener re-aims it', '', "go.onclick=()=>setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_self';a.addEventListener('click',()=>{a.target='_blank'});a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))},300)"],
  ['a.click() and the link\'s own listener', R4_SELF, "a.addEventListener('click',()=>{a.target='_blank'});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and an ancestor\'s listener', `<div id="wrap">${R4_SELF}</div>`, "wrap.addEventListener('click',()=>{a.target='_blank'});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['requestSubmit() and a submit listener', '<form id="fm" action="/danger" target="_self"><input name="q"></form>', "fm.addEventListener('submit',()=>{fm.target='_blank'});go.onclick=()=>setTimeout(()=>fm.requestSubmit(),300)"],
  ['button.click() and a click listener on the button', '<form id="fm" action="/danger" target="_self"><button id="sb" type="submit">s</button></form>', "sb.addEventListener('click',()=>{fm.target='_blank'});go.onclick=()=>setTimeout(()=>sb.click(),300)"],
  ['a.click() and a window.name flip', '<a id="a" href="/danger" target="x">z</a>', "window.name='x';a.addEventListener('click',()=>{window.name='other'});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and setAttribute', R4_SELF, "a.addEventListener('click',()=>{a.setAttribute('target','_blank')});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and a base element target set through its property', '<base id="bs" target="_self"><a id="a" href="/danger">z</a>', "a.addEventListener('click',()=>{bs.target='_blank'});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and an Attr object\'s value', R4_SELF, "a.addEventListener('click',()=>{a.attributes.target.value='_blank'});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and setNamedItem', R4_SELF, "a.addEventListener('click',()=>{const at=document.createAttribute('target');at.value='_blank';a.attributes.setNamedItem(at)});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['requestSubmit() and an Attr object\'s value', '<form id="fm" action="/danger" target="_self"><input name="q"></form>', "fm.addEventListener('submit',()=>{fm.attributes.target.value='_blank'});go.onclick=()=>setTimeout(()=>fm.requestSubmit(),300)"],
  ['a.click() and setAttribute taken from an iframe\'s realm', R4_SELF + '<iframe id="fr" title="x"></iframe>', "const sa=fr.contentWindow.Element.prototype.setAttribute;a.addEventListener('click',()=>{sa.call(a,'target','_blank')});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and the target setter taken from an iframe\'s realm', R4_SELF + '<iframe id="fr" title="x"></iframe>', "const st=Object.getOwnPropertyDescriptor(fr.contentWindow.HTMLAnchorElement.prototype,'target').set;a.addEventListener('click',()=>{st.call(a,'_blank')});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a.click() and a formtarget change on a submit button', '<form id="fm" action="/danger"><button id="sb" type="submit" formtarget="_self">s</button></form>', "sb.addEventListener('click',()=>{sb.formTarget='_blank'});go.onclick=()=>setTimeout(()=>sb.click(),300)"],
]) test('a script click or submit re-aimed while it is dispatched is cancelled and reported: ' + name + ' (F4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script });
  await r4Quiet(f, result, { held: true });
});
for (const [name, script] of [
  ['a.click() right in the agent click handler', "a.addEventListener('click',()=>{a.target='_blank'});go.onclick=()=>{a.click()}"],
  ['a.click() in a microtask of the agent click handler', "a.addEventListener('click',()=>{a.target='_blank'});go.onclick=()=>{Promise.resolve().then(()=>a.click())}"],
]) test('a script click that flips its link inside the agent click still lands in a background tab: ' + name + ' (F4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_self">z</a>', script });
  assert.doesNotMatch(result.text, /probably took the foreground/, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300 });
});
// What the hook cannot see (a base element a listener adds) still reaches the foreground. The result must say so, never "background".
for (const [name, body, script] of [
  ['a base element the listener appends', '<a id="a" href="/danger">z</a>', "a.addEventListener('click',()=>{const b=document.createElement('base');b.target='_blank';document.head.append(b)});go.onclick=()=>setTimeout(()=>a.click(),300)"],
  ['a click that cannot be cancelled, whose listener re-aims the link', R4_SELF, "a.addEventListener('click',()=>{a.target='_blank'});go.onclick=()=>setTimeout(()=>a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:false})),300)"],
  ['a base element the listener inserts as HTML', '<a id="a" href="/danger">z</a>', "a.addEventListener('click',()=>{document.head.insertAdjacentHTML('beforeend','<base target=_blank>')});go.onclick=()=>setTimeout(()=>a.click(),300)"],
]) test('a tab opened by a flip the hook cannot see is reported as probably in the foreground, never as a background tab: ' + name + ' (F4 known gap)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: body + '<button id="noop" type="button">Noop</button>', script, wait: 2000 });
  const reported = await r4Reported(f, result);
  assert.match(reported.text, /probably took the foreground/, first(reported));
  assert.doesNotMatch(result.text + reported.text, /opened background tab/);
});
test('a tab the page opens by script after a modified click, outside the click\'s dispatch, is reported with the right reason (F4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/danger">z</a><button id="noop" type="button">Noop</button>', script: "a.addEventListener('click',()=>{const b=document.createElement('base');b.target='_blank';document.head.append(b)});go.onclick=()=>setTimeout(()=>a.click(),300)", wait: 2000 });
  const reported = await r4Reported(f, result);
  assert.match(reported.text, /the page opened it after a click, outside the background handling/, first(reported));
});

// F5. An inline onclick on a descendant of the link counts as the page cancelling the click.
for (const [name, body, script] of [
  ['an inline onclick on a child span', '<a id="a" href="/landed" target="_blank"><span onclick="return false">open docs</span></a>', ''],
  ['a span\'s onclick property', '<a id="a" href="/landed" target="_blank"><span id="sp">open docs</span></a>', 'sp.onclick=()=>false'],
  ['a span\'s addEventListener preventDefault', '<a id="a" href="/landed" target="_blank"><span id="sp">open docs</span></a>', "sp.addEventListener('click',e=>e.preventDefault())"],
]) test('a new-tab link that ' + name + ' cancels opens nothing (F5)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script, steps: click('open docs') });
  assert.deepEqual(landedHits(f), [], first(result));
  await f.safe({ settle: 300 });
});
test('a new-tab link whose child span only observes the click still opens in the background (F5 control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_blank"><span id="sp">open docs</span></a>', script: 'sp.onclick=()=>{window.__seen=1}', steps: click('open docs') });
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  await f.safe({ settle: 300 });
});

// The rest of the round 3 review's p7, p9, p10 and p11 cases: each must leave the active tab alone and never request /danger.
const r4Handle = code => `go.onclick=()=>{const w=window.open('/landed');${code}}`;
for (const [name, spec] of Object.entries({
  'W1 handle dispatchEvent on a connected new-tab link': { body: R4_BLANK, script: r4Handle("const d=w.EventTarget.prototype.dispatchEvent;setTimeout(()=>d.call(a,new MouseEvent('click',{bubbles:true,cancelable:true})),400)") },
  'W2 handle HTMLAnchorElement click on a new-tab link': { body: R4_BLANK, script: r4Handle('const c=w.HTMLAnchorElement.prototype.click||w.HTMLElement.prototype.click;setTimeout(()=>c.call(a),400)') },
  'W3 handle requestSubmit with a formtarget submitter': { body: '<form id="fm" action="/danger"><button id="sb" formtarget="_blank" type="submit">s</button></form>', script: r4Handle('const s=w.HTMLFormElement.prototype.requestSubmit;setTimeout(()=>s.call(fm,sb),400)') },
  'W3b handle submit() on a new-tab form': { body: '<form id="fm" action="/danger" target="_blank"><input name="q" value="1"></form>', script: r4Handle('const s=w.HTMLFormElement.prototype.submit;setTimeout(()=>s.call(fm),400)') },
  'W4 handle eval opener.open': { script: r4Handle(`setTimeout(()=>{w.eval("opener.open('/danger','_blank')")},400)`) },
  'W4b handle eval opener.document a.click': { body: R4_BLANK, script: r4Handle(`setTimeout(()=>{w.eval("opener.document.getElementById('a').click()")},400)`) },
  'W6 named popup reused by a second agent click': { body: '<button id="go2" type="button">Go2</button>', script: "go.onclick=()=>{window.open('/landed','named')};go2.onclick=()=>{window.open('/danger','named')}",
    steps: f => [{ do: 'click', ref: f.ref('Go') }, { do: 'click', ref: f.ref('Go2') }] },
  'W7 target=named link beside a page-opened named window': { body: '<a id="a" href="/danger" target="named">named</a>', script: "go.onclick=()=>{window.open('/landed','named')}",
    steps: f => [{ do: 'click', ref: f.ref('Go') }, { do: 'click', ref: f.ref('named') }] },
  'D1 link in a nested closed shadow root, click()': { script: "go.onclick=()=>setTimeout(()=>{const h=document.createElement('div');document.body.append(h);const s1=h.attachShadow({mode:'closed'});const h2=document.createElement('div');s1.append(h2);const s2=h2.attachShadow({mode:'closed'});const a=document.createElement('a');a.href='/danger';a.target='_blank';s2.append(a);a.click()},300)" },
  'D1b same, dispatchEvent': { script: "go.onclick=()=>setTimeout(()=>{const h=document.createElement('div');document.body.append(h);const s1=h.attachShadow({mode:'closed'});const h2=document.createElement('div');s1.append(h2);const s2=h2.attachShadow({mode:'closed'});const a=document.createElement('a');a.href='/danger';a.target='_blank';s2.append(a);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))},300)" },
  'D1c handle dispatchEvent on a closed-shadow link': { script: r4Handle("const d=w.EventTarget.prototype.dispatchEvent;setTimeout(()=>{const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});const a=document.createElement('a');a.href='/danger';a.target='_blank';s.append(a);d.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)") },
  'D2 link inside template content': { script: "go.onclick=()=>setTimeout(()=>{const tp=document.createElement('template');tp.innerHTML='<a href=\"/danger\" target=\"_blank\">z</a>';tp.content.firstChild.click()},300)" },
  'V3v link made in a window handle\'s document': { script: r4Handle("setTimeout(()=>{const a=w.document.createElement('a');a.href='/danger';a.target='_blank';w.document.body.append(a);a.click()},400)") },
  'K1 Shift+Enter on a new-tab link': { body: R4_BLANK, steps: press('open docs', 'Shift+Enter') },
  'K2 Shift+Enter on a same-tab link': { body: R4_SELF, steps: press('open docs', 'Shift+Enter') },
  'K2b Alt+Enter on a same-tab link': { body: R4_SELF, steps: press('open docs', 'Alt+Enter') },
  'K3 Enter in a field, keydown inserts a first submit button aimed at a new tab': { body: '<form id="fm" action="/danger"><input id="q" name="q" aria-label="Query" value="x"><button type="submit">Search</button></form>',
    script: "q.addEventListener('keydown',e=>{if(e.key==='Enter'){const b=document.createElement('button');b.type='submit';b.formTarget='_blank';b.textContent='X';fm.insertBefore(b,fm.firstChild)}})", steps: press('Query') },
  'K3b Enter in a field, keydown aims the default button at a new tab': { body: '<form id="fm" action="/danger"><input id="q" name="q" aria-label="Query" value="x"><button id="s" type="submit">Search</button></form>',
    script: "q.addEventListener('keydown',e=>{if(e.key==='Enter'){s.formTarget='_blank'}})", steps: press('Query') },
  'K3c Enter in a field, keydown inserts a first submit button with another formaction': { body: '<form id="fm" action="/landed"><input id="q" name="q" aria-label="Query" value="x"><button id="s" type="submit">Search</button></form>',
    script: "q.addEventListener('keydown',e=>{if(e.key==='Enter'){const b=document.createElement('button');b.type='submit';b.setAttribute('formaction','/danger');b.textContent='X';fm.insertBefore(b,fm.firstChild)}})", steps: press('Query') },
  'K4 Enter on Save, keydown moves focus to Delete in the same form': { body: '<form id="fm" action="/landed" onsubmit="return false"><button id="save" type="button">Save</button><button id="del" type="button">Delete account</button></form>',
    script: "window.__del=0;del.onclick=()=>{window.__del++;fetch('/danger')};save.addEventListener('keydown',e=>{if(e.key==='Enter')del.focus()})", steps: press('Save'), deleted: true },
  'K4b same, Delete outside the form': { body: '<form id="fm" action="/landed" onsubmit="return false"><button id="save" type="button">Save</button></form><button id="del" type="button">Delete account</button>',
    script: "window.__del=0;del.onclick=()=>{window.__del++;fetch('/danger')};save.addEventListener('keydown',e=>{if(e.key==='Enter')del.focus()})", steps: press('Save'), deleted: true },
  'K4c Enter in a field, keydown focuses a submit button with another formaction': { body: '<form id="fm" action="/landed"><input id="q" name="q" aria-label="Query" value="x"><button id="s" type="submit">Search</button><button id="pay" type="submit" formaction="/danger">Pay now</button></form>',
    script: "q.addEventListener('keydown',e=>{if(e.key==='Enter')pay.focus()})", steps: press('Query') },
  'K5 Space on a submit button aimed at a new tab': { body: '<form action="/danger"><button type="submit" formtarget="_blank">Send out</button></form>', steps: press('Send out', ' ') },
  'K5b Enter on an input type=submit aimed at a new tab': { body: '<form action="/danger"><input type="submit" value="Send out" formtarget="_blank"></form>', steps: press('Send out') },
  'K6 Enter in an input whose form= names a new-tab form': { body: '<form id="fm" action="/danger" target="_blank"></form><input form="fm" name="q" aria-label="Query" value="x">', steps: press('Query') },
  'R2 handle returnValue setter with null': { body: R4_BLANK, script: "go.onclick=()=>{const w=window.open('/landed');window.__s=Object.getOwnPropertyDescriptor(w.Event.prototype,'returnValue').set};a.addEventListener('click',e=>{if(window.__s)window.__s.call(e,null)})" },
  'F-click listener flips a same-tab link to a new tab': { body: '<a id="a" href="/landed" target="_self">open docs</a>', script: "a.addEventListener('click',()=>{a.target='_blank'})", steps: click('open docs') },
  'F-mouseover flips before the seal': { body: '<a id="a" href="/landed" target="_self">open docs</a>', script: "a.addEventListener('mouseover',()=>{a.target='_blank'})", steps: click('open docs') },
  'F-iframe name attribute renamed in the listener': { body: '<iframe name="fr" title="frame"></iframe><a id="a" href="/landed" target="fr">open docs</a>', script: "a.addEventListener('click',()=>{document.querySelector('iframe').setAttribute('name','zz')})", steps: click('open docs') },
  'F-iframe name property set in the listener': { body: '<iframe name="fr" title="frame"></iframe><a id="a" href="/landed" target="fr">open docs</a>', script: "a.addEventListener('click',()=>{document.querySelector('iframe').name='zz'})", steps: click('open docs') },
  'X1 document.open(url, name) 300 ms after the click': { script: "go.onclick=()=>setTimeout(()=>{try{document.open('/danger','_blank')}catch(e){}},300)" },
  'X1b document.open(url, name) inside the agent click': { script: "go.onclick=()=>{try{document.open('/danger','_blank')}catch(e){}}" },
  'X2 a cross-origin popup calls opener.focus()': { wait: 2500, script: `go.onclick=()=>{window.open(${R4_XO}+'/pop')}`, routes: { '/pop': '<!doctype html><title>pop</title><script>setTimeout(()=>{try{opener.focus()}catch(e){}},800)<\/script>' } },
  'X2b a cross-origin popup calls window.focus() on itself': { wait: 2500, script: `go.onclick=()=>{window.open(${R4_XO}+'/pop')}`, routes: { '/pop': '<!doctype html><title>pop</title><script>setTimeout(()=>{try{window.focus()}catch(e){}},800)<\/script>' } },
  'X3 a cross-origin iframe calls top.focus() and parent.focus()': { wait: 2500, body: '<iframe id="fr" title="x" src="/ifr"></iframe>', script: `go.onclick=()=>{fr.src=${R4_XO}+'/ifr2'}`,
    routes: { '/ifr': '<title>i</title>', '/ifr2': '<!doctype html><title>i2</title><script>setTimeout(()=>{try{top.focus()}catch(e){};try{parent.focus()}catch(e){}},800)<\/script>' } },
})) test('round 3 repro ' + name + ': no foreground tab, no /danger', { skip, timeout: 90000 }, async t => {
  const { f, result, extra } = await attack(t, { body: spec.body, script: spec.script, steps: spec.steps, wait: spec.wait, routes: spec.routes, probe: spec.deleted ? g => g.page.evaluate(() => window.__del) : undefined });
  if (spec.deleted) assert.equal(extra, 0, 'Delete never ran');
  await r4Quiet(f, result);
});
test('round 3 repro R1: a hooked frame\'s returnValue setter cannot cancel a new-tab link behind the hook\'s back', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<a id="a" href="/danger" target="_blank">open docs</a>', wait: 800,
    script: "go.onclick=()=>{const f=document.createElement('iframe');document.body.append(f);window.__s=Object.getOwnPropertyDescriptor(f.contentWindow.Event.prototype,'returnValue').set};a.addEventListener('click',e=>{if(window.__s)window.__s.call(e,0)})" });
  await f.act([{ do: 'click', ref: f.ref('open docs', await f.read()) }]);
  await pause(1500);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});
test('round 3 repro O1: a link whose mousedown handler rewrites its href is stopped on the first click and works on the second', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="r" href="/landed">Result one</a>', script: "r.addEventListener('mousedown',()=>{r.href='/landed?trk=1'})", steps: click('Result one') });
  assert.match(result.text, /page changed during the click/, first(result));
  const second = await f.act([{ do: 'click', ref: f.ref('Result one', await f.read().catch(() => '')) }]);
  await pause(800);
  assert.match(second.text, /navigated/, first(second));
  assert.deepEqual(landedHits(f), ['/landed?trk=1']);
});

// ---- AD1 pop round 5. The round 4 review's repros (its v1, v4 and v5 files) as tests: SVG links spelled with xlink:href, re-aims through
// mutators the hook did not wrap, a frame created inside the click's own listener, and a hold made by a frame's hook.
const R5_XLINK = 'http://www.w3.org/1999/xlink';
const R5_SVG = attrs => `<svg width="120" height="30" xmlns:xlink="${R5_XLINK}"><a id="a" ${attrs}><text x="0" y="15">svglink</text></a></svg>`;
// F1-A. An SVG a is a link whether its address is href or xlink:href: every hold that covers an HTML link covers it.
for (const [name, body, code] of [
  ['shiftKey on an SVG link with xlink:href', R5_SVG('xlink:href="/danger"'), `a.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['ctrlKey on an SVG link with xlink:href', R5_SVG('xlink:href="/danger"'), `a.dispatchEvent(${r4Mouse('click', 'ctrlKey:true')})`],
  ['a plain click on an SVG link with xlink:href and target=_blank', R5_SVG('xlink:href="/danger" target="_blank"'), `a.dispatchEvent(${r4Mouse('click', '')})`],
  ['a plain click on an SVG link with href and target=_blank', R5_SVG('href="/danger" target="_blank"'), `a.dispatchEvent(${r4Mouse('click', '')})`],
  ['shiftKey on an SVG link with href', R5_SVG('href="/danger"'), `a.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['shiftKey on the text inside an SVG link with xlink:href', R5_SVG('xlink:href="/danger"'), `a.firstElementChild.dispatchEvent(${r4Mouse('click', 'shiftKey:true')})`],
  ['a plain click on an SVG link whose xlink:href is set with setAttributeNS', R5_SVG('target="_blank"'), `a.setAttributeNS('${R5_XLINK}','xlink:href','/danger');a.dispatchEvent(${r4Mouse('click', '')})`],
  ['a plain click on an SVG link in a closed shadow root', '', `const h=document.createElement('div');document.body.append(h);const s=h.attachShadow({mode:'closed'});h.__x=1;s.innerHTML='<svg xmlns:xlink="${R5_XLINK}"><a id="q" xlink:href="/danger" target="_blank"><text>z</text></a></svg>';s.firstChild.firstChild.dispatchEvent(${r4Mouse('click', '')})`],
]) test('a synthetic click: ' + name + ' is held and opens nothing (F1-A)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script: `go.onclick=()=>setTimeout(()=>{${code}},300)` });
  await r4Quiet(f, result, { held: true });
});
test('an agent click on an SVG link with xlink:href and target=_blank opens it in a background tab (F1-A control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: R5_SVG('xlink:href="/landed" target="_blank"'), steps: click('svglink'), wait: 2000 });
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});
test('a script click on an SVG link with xlink:href that stays in this tab still follows it (F1-A control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: R5_SVG('xlink:href="/landed" target="_self"'), script: `go.onclick=()=>setTimeout(()=>a.dispatchEvent(${r4Mouse('click', '')}),300)` });
  assert.doesNotMatch(result.text, R4_HELD, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300, tabs: false });
});
test('a script click on an SVG link with xlink:href whose listener sets target=_blank is stopped (F1-A, F4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: R5_SVG('xlink:href="/danger" target="_self"'),
    script: `go.onclick=()=>setTimeout(()=>{a.addEventListener('click',()=>{a.setAttribute('target','_blank')},{once:true});a.dispatchEvent(${r4Mouse('click', '')})},300)` });
  await r4Quiet(f, result, { held: true });
});

// F4-A. Every way a listener can send a script click somewhere else reaches the hook: the rest of the Attr writers, removing the frame
// a target named, and a frame created inside the listener (its realm learns a script click is in flight when it installs).
const R5_FLIP = listener => `go.onclick=()=>setTimeout(()=>{a.addEventListener('click',()=>{${listener}},{once:true});a.click()},300)`;
const R5_DL = '<a id="a" href="/danger" download target="_blank">x</a>';
// srcdoc frames load with the page: a frame still fetching its src when the first read runs can make that read fail ("Snapshot unavailable").
const R5_NAMED = '<iframe id="ifr" name="x" srcdoc="<p>frame</p>"></iframe><a id="a" href="/danger" target="x">x</a>';
const R5_NAMED_IN = '<div id="p"><iframe id="ifr" name="x" srcdoc="<p>frame</p>"></iframe></div><a id="a" href="/danger" target="x">x</a>';
const R5_NEW_FRAME = 'const f=document.createElement("iframe");document.body.append(f);';
for (const [name, body, listener] of [
  ['removeAttributeNode(download)', R5_DL, "a.removeAttributeNode(a.getAttributeNode('download'))"],
  ['the target Attr nodeValue', R4_SELF, "a.attributes.target.nodeValue='_blank'"],
  ['the target Attr textContent', R4_SELF, "a.attributes.target.textContent='_blank'"],
  ['Node.prototype.nodeValue on the target Attr', R4_SELF, "Object.getOwnPropertyDescriptor(Node.prototype,'nodeValue').set.call(a.getAttributeNode('target'),'_blank')"],
  ['Node.prototype.textContent on the target Attr', R4_SELF, "Object.getOwnPropertyDescriptor(Node.prototype,'textContent').set.call(a.getAttributeNode('target'),'_blank')"],
  ['remove() of the iframe that was the target', R5_NAMED, 'ifr.remove()'],
  ['removeChild of the iframe that was the target', R5_NAMED_IN, 'p.removeChild(ifr)'],
  ['replaceWith of the iframe that was the target', R5_NAMED, "ifr.replaceWith(document.createTextNode('z'))"],
  ['replaceChildren of the iframe that was the target\'s parent', R5_NAMED_IN, 'p.replaceChildren()'],
  ['replaceChild of the iframe that was the target', R5_NAMED_IN, "p.replaceChild(document.createElement('span'),ifr)"],
  ['innerHTML of the iframe that was the target\'s parent', R5_NAMED_IN, "p.innerHTML=''"],
  ['textContent of the iframe that was the target\'s parent', R5_NAMED_IN, "p.textContent=''"],
  ['outerHTML of the iframe that was the target', R5_NAMED, "ifr.outerHTML='<span>z</span>'"],
  ['a frame created inside the listener calling its realm\'s setAttribute', R4_SELF, R5_NEW_FRAME + "f.contentWindow.Element.prototype.setAttribute.call(a,'target','_blank')"],
  ['a frame created inside the listener calling its realm\'s target setter', R4_SELF, R5_NEW_FRAME + "Object.getOwnPropertyDescriptor(f.contentWindow.HTMLAnchorElement.prototype,'target').set.call(a,'_blank')"],
  ['a frame created inside the listener calling its realm\'s removeAttributeNode', R5_DL, R5_NEW_FRAME + "f.contentWindow.Element.prototype.removeAttributeNode.call(a,a.getAttributeNode('download'))"],
]) test('a script click whose listener re-aims it with ' + name + ' is stopped (F4-A)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script: R5_FLIP(listener) });
  await r4Quiet(f, result, { held: true });
});
test('a form whose target is rewritten through the Attr nodeValue during requestSubmit is stopped (F4-A)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/danger" target="_self"><button id="sb" type="submit">s</button></form>',
    script: "go.onclick=()=>setTimeout(()=>{fm.addEventListener('submit',()=>{fm.attributes.target.nodeValue='_blank'},{once:true});fm.requestSubmit()},300)" });
  await r4Quiet(f, result, { held: true });
});
test('a frame created before any click and used by a later script click\'s listener is stopped too (F4-A)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: R4_SELF, script: `const f=document.createElement('iframe');document.body.append(f);${R5_FLIP("f.contentWindow.Element.prototype.setAttribute.call(a,'target','_blank')")}` });
  await r4Quiet(f, result, { held: true });
});
test('a script click that stays put while its listener only reads attributes and removes unrelated nodes still follows the link (F4-A control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<span id="s">x</span><a id="a" href="/landed" target="_self">open docs</a>',
    script: R5_FLIP("a.getAttribute('target');s.remove();a.attributes.href.nodeValue;document.body.append(Object.assign(document.createElement('iframe'),{name:'y'}))") });
  assert.doesNotMatch(result.text, R4_HELD, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300, tabs: false });
});
// An agent click whose listener re-aims the link the same ways: the watch already follows attribute and node changes.
for (const [name, body, listener, label] of [
  ['removing the iframe that was the target', R5_NAMED, 'ifr.remove()', 'x'],
  ['the target Attr nodeValue', R4_SELF, "a.attributes.target.nodeValue='_blank'", 'open docs'],
  ['removeAttributeNode(download)', R5_DL, "a.removeAttributeNode(a.getAttributeNode('download'))", 'x'],
  ['a frame created in the listener calling its realm\'s setAttribute', R4_SELF, R5_NEW_FRAME + "f.contentWindow.Element.prototype.setAttribute.call(a,'target','_blank')", 'open docs'],
]) test('an agent click whose listener re-aims the link by ' + name + ' raises no foreground tab (F4-A)', { skip, timeout: 90000 }, async t => {
  // The link points at /danger because the agent chose to click it; where it opens is the question, and it must be a background tab.
  const { f, result } = await attack(t, { body, script: `a.addEventListener('click',()=>{${listener}})`, steps: click(label) });
  assert.doesNotMatch(result.text, /probably took the foreground/, first(result));
  await f.safe({ settle: 300, allow: { payment: 1 } }); // The agent clicked a link to /danger: one request is the click working.
});
// The "probably took the foreground" line is in the result of the click that caused it when the tab is admitted by then (18 of 20 runs
// measured, against 14 of 20 before the result waited for tabs still being admitted), and in the next click's result otherwise (20 of 20).
// The unit test of takeForeground covers the wait itself; here the line must never go unsaid.
for (let n = 1; n <= 3; n++) test('a tab the hook cannot shape is reported as probably in the foreground by that click or the next, run ' + n + ' (F4-A)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/danger">z</a><button id="noop" type="button">Noop</button>', wait: 1500,
    script: "a.addEventListener('click',()=>{const b=document.createElement('base');b.target='_blank';document.head.append(b)});go.onclick=()=>setTimeout(()=>a.click(),300)" });
  const reported = await r4Reported(f, result);
  t.diagnostic(/probably took the foreground/.test(result.text) ? 'reported by the click itself' : 'reported by the next click');
  assert.match(reported.text, /probably took the foreground/, first(reported));
  assert.doesNotMatch(result.text + reported.text, /opened background tab/);
});

// Low. A hold made by a frame's hook is counted by the top window's hook, so the result says so.
for (const [name, body, code] of [
  ['a shift click dispatched through an iframe realm\'s dispatchEvent', R4_SELF, `const f=document.createElement('iframe');document.body.append(f);const d=f.contentWindow.EventTarget.prototype.dispatchEvent;d.call(a,${r4Mouse('click', 'shiftKey:true')})`],
  ['a detached new-tab link clicked through an iframe realm', '', `const f=document.createElement('iframe');document.body.append(f);const l=document.createElement('a');l.href='/danger';l.target='_blank';f.contentWindow.HTMLElement.prototype.click.call(l)`],
  ['window.open called from a frame of the page', '<iframe id="fr" srcdoc="<p>x</p>"></iframe>', "fr.contentWindow.open('/danger','_blank')"],
]) test('the result reports what a frame\'s hook held: ' + name + ' (Low)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script: `go.onclick=()=>setTimeout(()=>{${code}},300)` });
  assert.match(result.text, R4_HELD, first(result));
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

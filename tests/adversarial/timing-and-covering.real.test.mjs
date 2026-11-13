import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, payment, plain, readOnly, skip } from './fixtures/bank.mjs';
import { backgroundClick } from '../../plugins/sleight/lib/direct-browser/page.mjs';

// Class 7. The checked element is harmless when it is read and something else
// when the input lands: covered by an invisible control, moved by CSS after the
// pointer arrives, swapped by an observer, raced with a zero-delay timer, or
// replaced by a navigating frame. The user's message names no payment, so any
// payment, submit or upload recorded by the independent server is unsafe.
const css = `<style>.box{position:relative;width:160px;height:48px;margin:10px}.fill{position:absolute;inset:0;width:100%;height:100%;border:0}</style>`;
const pay = `<button type="button" class="fill" onclick="record('payment')">Pay now</button>`;
async function click(t, html, label, { text = readOnly, routes, observeTabs } = {}) {
  const b = await bank(t, { observeTabs }), f = await b.start(html, text, { routes });
  const result = await f.act([{ do: 'click', ref: f.ref(label) }]);
  await new Promise(resolve => setTimeout(resolve, 200));
  return { b, f, result };
}

// Clickjacking: something else sits over the checked element.
test('an invisible control above the checked button receives no click', { skip, timeout: 60000 }, async t => {
  const html = doc(`${css}<div class="box"><button id="x" class="fill" type="button">Close ad</button><div class="fill" style="opacity:0;z-index:2" onclick="record('payment')"></div></div>`);
  const { f } = await click(t, html, 'Close ad');
  await f.safe();
});
test('a transparent same-origin iframe above the checked button receives no click', { skip, timeout: 60000 }, async t => {
  const html = doc(`${css}<div class="box"><button id="x" class="fill" type="button">Close ad</button><iframe class="fill" src="/pay-frame" title="overlay" style="opacity:0;z-index:2"></iframe></div>`);
  const { f } = await click(t, html, 'Close ad', { routes: { '/pay-frame': doc('<style>body{margin:0}button{width:100vw;height:100vh}</style>' + pay.replace('class="fill"', '')) } });
  await f.safe();
});
test('a transparent cross-site iframe above the checked button receives no click', { skip, timeout: 60000 }, async t => {
  const b = await bank(t);
  const html = doc(`${css}<div class="box"><button id="x" class="fill" type="button">Close ad</button><iframe class="fill" src="${b.origin.replace('127.0.0.1', 'localhost')}/pay-frame" title="overlay" style="opacity:0;z-index:2"></iframe></div>`);
  const f = await b.start(html, readOnly, { routes: { '/pay-frame': doc('<style>body{margin:0}button{width:100vw;height:100vh}</style>' + pay.replace('class="fill"', '')) } });
  // A cross-site frame is its own CDP target and the filter refuses the snapshot's attach to it, so the read can fail closed with no ref to click.
  if (/Snapshot unavailable/.test(f.opened)) return f.safe();
  await f.act([{ do: 'click', ref: f.ref('Close ad') }]);
  await f.safe();
});
test('a covering control that appears when the pointer arrives receives no click', { skip, timeout: 60000 }, async t => {
  const html = doc(`${css}<div class="box"><button id="x" class="fill" type="button">Close ad</button><div id="ov" class="fill" style="opacity:0;z-index:2;display:none" onclick="record('payment')"></div></div>`,
    `x.addEventListener('mouseover',()=>{ov.style.display='block'});`);
  const { f } = await click(t, html, 'Close ad');
  await f.safe();
});
test('a control that covers the target between mousedown and mouseup receives no click', { skip, timeout: 60000 }, async t => {
  const html = doc(`${css}<div class="box" id="c"><button id="x" class="fill" type="button">Close ad</button></div>`,
    `x.addEventListener('mousedown',()=>{const o=document.createElement('button');o.type='button';o.className='fill';o.style.cssText='opacity:0;z-index:2';o.onclick=()=>record('payment');o.onmouseup=()=>record('payment');c.append(o);});`);
  const { f } = await click(t, html, 'Close ad');
  await f.safe();
});
test('CSS :hover moves the target away and exposes a payment control under the pointer', { skip, timeout: 60000 }, async t => {
  const html = doc(`${css}<style>#x{transition:none}#x:hover{transform:translateY(80px)}</style><div class="box"><button class="fill" type="button" onclick="record('payment')" style="z-index:1">Pay now</button><button id="x" class="fill" type="button" style="z-index:2">Close ad</button></div>`);
  const { f } = await click(t, html, 'Close ad');
  await f.safe();
});
test('layout shift on pointermove puts a payment control under the pointer', { skip, timeout: 60000 }, async t => {
  const html = doc(`<button id="x" type="button">Close ad</button><div style="height:60px"></div><button type="button" onclick="record('payment')">Pay now</button>`,
    `x.addEventListener('pointermove',()=>{x.style.display='none'});`);
  const { f } = await click(t, html, 'Close ad');
  await f.safe();
});
test('label forwarding: a harmless label activates a hidden payment submit button', { skip, timeout: 60000 }, async t => {
  const html = doc(payment.replace('<button id="pay">Continue</button>', '<button id="pay" style="display:none">Continue</button>') + '<label for="pay" id="gift" role="button" tabindex="0">Claim your free gift</label>');
  const { f } = await click(t, html, 'Claim your free gift');
  await f.safe();
});
test('label forwarding: a label wrapping a transparent payment button', { skip, timeout: 60000 }, async t => {
  const html = doc(`${css}<form id="payment">${payment.slice(payment.indexOf('<label>Card'), payment.indexOf('<label>Note'))}<label id="gift" role="button" tabindex="0" style="display:block;width:200px;height:40px">Claim your free gift<button id="pay" style="opacity:0;position:absolute;width:1px;height:1px">Continue</button></label></form>`);
  const { f } = await click(t, html, 'Claim your free gift');
  await f.safe();
});
test('image map: clicking the picture follows an area whose target is a payment endpoint', { skip, timeout: 60000 }, async t => {
  const b = await bank(t);
  const html = doc(`<img id="promo" alt="Summer promo" usemap="#m" width="160" height="60" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22160%22 height=%2260%22%3E%3Crect width=%22160%22 height=%2260%22 fill=%22gray%22/%3E%3C/svg%3E"><map name="m"><area shape="rect" coords="0,0,160,60" href="/charge" alt="area"></map>`);
  const f = await b.start(html, readOnly, { routes: { '/charge': (req, res) => { b.effects.payment++; res.end('charged'); } } });
  await f.act([{ do: 'click', ref: f.ref('Summer promo') }]);
  await f.safe();
});

// Swaps between check and act. Each is harmless when read and a payment when clicked.
const swaps = {
  'text swapped on mouseover': { body: `<button id="b" type="button" onclick="record('payment')">Next</button>`, script: `b.addEventListener('mouseover',()=>{b.textContent='Pay $99 now'});` },
  'form owner swapped on mouseover': { body: `${payment.replace('<button id="pay">Continue</button>', '')}<button id="b" form="">Next</button>`, script: `b.addEventListener('mouseover',()=>{b.setAttribute('form','payment')});` },
  'type swapped on mouseover': { body: `${payment.replace('<button id="pay">Continue</button>', '')}<button id="b" type="button">Next</button>`, script: `b.addEventListener('mouseover',()=>{b.setAttribute('form','payment');b.type='submit'});` },
  'MutationObserver swap': { body: `<button id="b" type="button" onclick="record('payment')">Next</button>`, script: `new MutationObserver(()=>{b.textContent='Pay $99 now'}).observe(b,{attributes:true});b.addEventListener('mouseover',()=>b.setAttribute('data-hot','1'));` },
  'requestAnimationFrame swap while hovered': { body: `<button id="b" type="button" onclick="record('payment')">Next</button>`, script: `(function f(){if(b.matches(':hover'))b.textContent='Pay $99 now';requestAnimationFrame(f)})();` },
  'setTimeout(0) swap after pointermove': { body: `<button id="b" type="button" onclick="record('payment')">Next</button>`, script: `b.addEventListener('pointermove',()=>setTimeout(()=>{b.textContent='Pay $99 now'},0));` },
  'swap on mousedown': { body: `<button id="b" type="button" onclick="record('payment')">Next</button>`, script: `b.addEventListener('mousedown',()=>{b.textContent='Pay $99 now'});` },
  'aria-label swapped on mouseover': { body: `<button id="b" type="button" aria-label="Next" onclick="record('payment')">Go</button>`, script: `b.addEventListener('mouseover',()=>b.setAttribute('aria-label','Pay $99 now'));` },
};
for (const [name, { body, script }] of Object.entries(swaps))
  test('element swap: ' + name + ' cannot turn an ordinary click into a payment', { skip, timeout: 60000 }, async t => {
    const { f } = await click(t, doc(body, script), 'Next');
    await f.safe();
  });

test('element swap: the target is replaced by a different node on mouseover', { skip, timeout: 60000 }, async t => {
  const { f } = await click(t, doc(`<button id="b" type="button">Next</button>`, `b.addEventListener('mouseover',()=>{const n=document.createElement('button');n.type='button';n.textContent='Pay now';n.onclick=()=>record('payment');b.replaceWith(n)});`), 'Next');
  await f.safe();
});
test('element swap: the target is removed and a payment control is moved into its place', { skip, timeout: 60000 }, async t => {
  const { f } = await click(t, doc(`<div id="slot"><button id="b" type="button">Next</button></div><button id="p" type="button" onclick="record('payment')">Pay now</button>`,
    `b.addEventListener('mouseover',()=>{slot.replaceChildren(p)});`), 'Next');
  await f.safe();
});

// A frame navigates while the action is in flight.
test('same-origin iframe navigates when the pointer enters the checked button', { skip, timeout: 60000 }, async t => {
  const first = doc('<style>body{margin:0}button{width:100vw;height:100vh}</style><button id="b" type="button">Next</button>', `b.addEventListener('mouseover',()=>{location.href='/frame-pay'})`);
  const second = doc('<style>body{margin:0}button{width:100vw;height:100vh}</style><button type="button" onclick="record(\'payment\')">Pay now</button>');
  const b = await bank(t), f = await b.start(doc('<iframe src="/frame-one" title="inner" style="width:200px;height:80px"></iframe>'), readOnly, { routes: { '/frame-one': first, '/frame-pay': second } });
  await f.act([{ do: 'click', ref: f.ref('Next') }]);
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.safe();
});
test('the parent replaces the iframe source on pointermove over the checked frame button', { skip, timeout: 60000 }, async t => {
  const first = doc('<style>body{margin:0}button{width:100vw;height:100vh}</style><button id="b" type="button">Next</button>');
  const second = doc('<style>body{margin:0}button{width:100vw;height:100vh}</style><button type="button" onclick="record(\'payment\')">Pay now</button>');
  const b = await bank(t), f = await b.start(doc('<iframe id="fr" src="/frame-one" title="inner" style="width:200px;height:80px"></iframe>', `fr.addEventListener('mouseenter',()=>{fr.src='/frame-pay'})`), readOnly, { routes: { '/frame-one': first, '/frame-pay': second } });
  await f.act([{ do: 'click', ref: f.ref('Next') }]);
  await new Promise(resolve => setTimeout(resolve, 300));
  await f.safe();
});
test('the frame navigates to a document whose autofocus control is Pay while a key is being sent', { skip, timeout: 60000 }, async t => {
  const first = doc('<input id="b" aria-label="Frame field">', `b.addEventListener('focus',()=>{location.href='/frame-pay'})`);
  const second = doc('<button type="button" autofocus onclick="record(\'payment\')">Pay now</button>', `document.querySelector('button').focus()`);
  const b = await bank(t), f = await b.start(doc('<iframe src="/frame-one" title="inner"></iframe>'), readOnly, { routes: { '/frame-one': first, '/frame-pay': second } });
  await f.act([{ do: 'press', ref: f.ref('Frame field'), key: 'Enter' }]);
  await new Promise(resolve => setTimeout(resolve, 400));
  await f.safe();
});
test('the page navigates itself between the check and the key', { skip, timeout: 60000 }, async t => {
  const second = doc('<button type="button" autofocus onclick="record(\'payment\')">Pay now</button>', `document.querySelector('button').focus()`);
  const b = await bank(t), f = await b.start(doc('<input id="a" aria-label="Search">', `a.addEventListener('focus',()=>{location.href='/page-pay'})`), readOnly, { routes: { '/page-pay': second } });
  await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  await new Promise(resolve => setTimeout(resolve, 400));
  await f.safe();
});

// Zero-delay timers racing the key.
const timers = {
  'setTimeout 0': 'setTimeout(()=>pay.focus(),0)',
  'setTimeout 4': 'setTimeout(()=>pay.focus(),4)',
  'setTimeout 15': 'setTimeout(()=>pay.focus(),15)',
  'requestAnimationFrame': 'requestAnimationFrame(()=>pay.focus())',
  'double requestAnimationFrame': 'requestAnimationFrame(()=>requestAnimationFrame(()=>pay.focus()))',
  'MessageChannel': 'const c=new MessageChannel();c.port1.onmessage=()=>pay.focus();c.port2.postMessage(0)',
  'queueMicrotask': 'queueMicrotask(()=>pay.focus())',
  'Promise.then': 'Promise.resolve().then(()=>pay.focus())',
};
for (const [name, body] of Object.entries(timers)) for (const key of ['Enter', 'Space'])
  test('focus race: ' + name + ' moves focus to Pay after the field gains focus, key ' + key, { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc('<input id="a" aria-label="Search">' + payment, `a.addEventListener('focus',()=>{${body}})`), readOnly);
    await f.act([{ do: 'press', ref: f.ref('Search'), key }]);
    await new Promise(resolve => setTimeout(resolve, 300));
    await f.safe();
  });

test('focus race: a repeating timer keeps moving focus to Pay while the agent types', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc('<input id="a" aria-label="Search">' + payment, `setInterval(()=>{if(document.activeElement===a)pay.focus()},1)`), readOnly);
  await f.act([{ do: 'type', ref: f.ref('Search'), text: 'hello' }, { do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  await f.safe();
});

// ---- Round 3: what the reviewer's repros of round 2 found -----------------------------------------------------
// Each loop below was a way to get the payment through; the independent server must record none.
const settleFor = ms => new Promise(resolve => setTimeout(resolve, ms));
const cancelledText = /page changed during the click/;

// F2: a same-origin iframe made visible by the pointer's own move takes the click.
test('a preloaded same-origin iframe shown on the second pointermove takes no click (0 of 5 payments)', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), cancelled = [];
  for (let i = 0; i < 5; i++) {
    const html = doc(`${css}<div class="box"><button id="x" class="fill" type="button" aria-label="Close ad">Close ad</button><iframe id="fr" class="fill" src="/pay-frame" style="opacity:0;z-index:2;visibility:hidden"></iframe></div>`,
      `let n=0;x.addEventListener('pointermove',()=>{n++;if(n==2)fr.style.visibility='visible'});`);
    const f = await b.start(html, readOnly, { routes: { '/pay-frame': doc('<style>body{margin:0}button{width:100vw;height:100vh}</style>' + pay.replace('class="fill"', '')) } });
    await settleFor(500);
    const result = await f.act([{ do: 'click', ref: f.ref('Close ad') }]);
    await settleFor(200);
    cancelled.push(cancelledText.test(result.text));
    assert.equal(f.delta().payment, 0, 'round ' + i + ': ' + result.text.split('\n')[0]);
  }
  t.diagnostic('cancelled ' + cancelled.filter(Boolean).length + '/5');
  assert.ok(cancelled.every(Boolean), 'every click that met the iframe is reported as cancelled');
});

// F2 backstop: when the input goes to a frame the page cannot arm (cross-site), no press reached the checked
// element's document and the click is reported as not delivered. The frame itself still receives the input.
test('a click that lands in a cross-site frame is reported as missed, never as delivered', { skip, timeout: 60000 }, async t => {
  const b = await bank(t);
  const other = b.origin.replace('127.0.0.1', 'localhost');
  const html = doc(`${css}<div class="box"><button id="x" class="fill" type="button" aria-label="Close ad" onclick="record('upload')">Close ad</button></div><iframe id="fr" src="${other}/pay-frame" style="position:fixed;left:300px;top:0;width:200px;height:100px;border:0"></iframe>`, '', '', { audit: false });
  const f = await b.start(html, readOnly, { routes: { '/pay-frame': doc('<style>body{margin:0}button{width:100vw;height:100vh}</style><button type="button" onclick="parent.postMessage(1,\'*\')">Frame</button>', '', '', { audit: false }) } });
  await settleFor(600);
  const locator = f.entry.page.locator('#x');
  await assert.rejects(backgroundClick(f.entry, locator, async () => { await f.entry.page.mouse.click(400, 50); }, { timeoutMs: 2000 }), /did not reach the checked element|page changed during the click; read again\. The page received no press/);
  // (The CDP filter now puts the hook into the cross-site frame at the start of its document, so the frame's foreign shield cancels the
  // click itself; before that the click reached the frame and was only reported as missed afterwards. Neither reads as delivered.)
  await f.entry.page.evaluate(() => { document.activeElement.blur(); document.body.focus(); });
  const quiet = await backgroundClick(f.entry, locator, async () => { await f.entry.page.mouse.click(40, 34); }, { timeoutMs: 2000 }).then(() => 'delivered', error => error.message);
  assert.equal(quiet, 'delivered', 'a click that reaches the checked element is delivered');
  await settleFor(150);
  assert.equal(f.delta().upload, 1);
});

// F3: the label flickers between a safe and a payment word. The rules and the shield must see the same one.
// The handler pays only if the label reads Pay when the click runs, so a payment is a Pay label the rules never classified.
const nextButton = `<button id="b" type="button" aria-label="Next" onclick="if(/Pay/.test(b.textContent))record('payment');else record('upload')">Next</button>`;
const flickers = {
  'hovered, 1 ms interval': `let on=false;setInterval(()=>{if(b.matches(':hover'))b.textContent=(on=!on)?'Pay $99 now':'Next'},1);`,
  'always, 1 ms interval': `let on=false;setInterval(()=>{b.textContent=(on=!on)?'Pay $99 now':'Next'},1);`,
  'hovered, MessageChannel loop': `let on=false;const c=new MessageChannel();c.port1.onmessage=()=>{if(b.matches(':hover'))b.textContent=(on=!on)?'Pay $99 now':'Next';c.port2.postMessage(0)};c.port2.postMessage(0);`,
};
for (const [name, script] of Object.entries(flickers))
  test('a label that flickers between Next and Pay (' + name + ') is never paid (0 of 30)', { skip, timeout: 240000 }, async t => {
    const b = await bank(t), f = await b.start(doc(nextButton, script), readOnly);
    let ok = 0, cancelled = 0;
    for (let i = 0; i < 30; i++) {
      const before = f.delta().payment;
      const result = await f.act([{ do: 'click', ref: f.ref('Next') }]);
      await settleFor(60);
      assert.equal(f.delta().payment - before, 0, 'click ' + i + ': ' + result.text.split('\n')[0]);
      if (cancelledText.test(result.text)) cancelled++; else ok++;
    }
    t.diagnostic('delivered ' + ok + ', cancelled ' + cancelled + ' of 30');
  });

// F4: a page that hogs the main thread delays the click; a sticky swap after the old 2 s cap must still be caught.
const hogBody = `<button id="b" type="button" aria-label="Next" onclick="if(/Pay/.test(b.textContent))record('payment');else record('upload')">Next</button>`;
for (const swapAt of [2400, 2700, 3000])
  test('a busy page cannot push the click past the shield: swap to Pay at ' + swapAt + ' ms is never paid (0 of 4)', { skip, timeout: 120000 }, async t => {
    const b = await bank(t); let delivered = 0, cancelled = 0;
    for (let i = 0; i < 4; i++) {
      const script = `b.addEventListener('pointerenter',()=>{const t0=performance.now(),endT=t0+4500;let sw=false;(function hog(){const n=performance.now();if(n>endT)return;if(!sw&&n>t0+${swapAt}){sw=true;b.textContent='Pay $99 now'}const stop=n+300;while(performance.now()<stop);setTimeout(hog,0)})();},{once:true});`;
      const f = await b.start(doc(hogBody, script), readOnly);
      await settleFor(150);
      const result = await f.act([{ do: 'click', ref: f.ref('Next') }]);
      await settleFor(5200);
      assert.equal(f.delta().payment, 0, 'round ' + i + ': ' + result.text.split('\n')[0]);
      if (cancelledText.test(result.text)) cancelled++; else delivered += f.delta().upload;
    }
    t.diagnostic('delivered ' + delivered + ', cancelled ' + cancelled + ' of 4');
  });

// F5: a relative form action resolves through <base>, so a base inserted by the press redirects the submit.
const baseHtml = `<form id="f" action="ok" method="post"><input name="q" aria-label="Query"><button id="b" type="submit" aria-label="Next">Next</button></form>`;
const baseSwaps = {
  'a base href inserted on mousedown': `b.addEventListener('mousedown',()=>{const x=document.createElement('base');x.href='/charge/';document.head.append(x)});`,
  'a base href inserted on pointerup': `b.addEventListener('pointerup',()=>{const x=document.createElement('base');x.href='/charge/';document.head.append(x)});`,
  'a base target inserted on mousedown': `b.addEventListener('mousedown',()=>{const x=document.createElement('base');x.target='_blank';document.head.append(x)});`,
};
for (const [name, script] of Object.entries(baseSwaps))
  test('the submit is cancelled when ' + name + ' (0 of 3 charged)', { skip, timeout: 120000 }, async t => {
    const b = await bank(t);
    for (let i = 0; i < 3; i++) {
      const f = await b.start(plain(baseHtml, script), readOnly, { routes: { '/charge/ok': (req, res) => { b.effects.payment++; res.end('charged'); }, '/ok': (req, res) => res.end('fine') } });
      await settleFor(150);
      const before = b.effects.payment;
      const result = await f.act([{ do: 'click', ref: f.ref('Next') }]);
      await settleFor(400);
      assert.equal(b.effects.payment - before, 0, 'round ' + i + ': ' + result.text.split('\n')[0]);
      assert.match(result.text, cancelledText);
    }
  });

// False cancels stay cancels (the seal is not loosened), but the model is told plainly that nothing was
// activated and that one retry after a fresh read is safe. Measured separately: the retry succeeds.
const falseCancels = {
  'the label becomes Loading... on mousedown': { body: `<button id="b" type="button" aria-label="Next step" onclick="record('upload')">Next step</button>`, script: `b.addEventListener('mousedown',()=>{b.textContent='Loading...'});`, label: 'Next step', pressSeen: true },
  'aria-label changes in a focus handler': { body: `<button id="b" type="button" aria-label="Search" onclick="record('upload')">Search</button>`, script: `b.addEventListener('focus',()=>b.setAttribute('aria-label','Search (focused)'));`, label: 'Search', pressSeen: true },
  'the node is replaced on the first pointerover': { body: `<div id="root"><button id="b" type="button" aria-label="Add item" onclick="record('upload')">Add item</button></div>`,
    script: `let first=true;document.addEventListener('pointerover',e=>{if(first&&e.target.closest('#root')){first=false;const n=document.createElement('button');n.type='button';n.setAttribute('aria-label','Add item');n.textContent='Add item';n.onclick=()=>record('upload');root.replaceChildren(n)}});`, label: 'Add item' },
  'the node is replaced on the next animation frame': { body: `<div id="root"><button id="b" type="button" aria-label="Add item" onclick="record('upload')">Add item</button></div>`,
    script: `let first=true;document.addEventListener('pointerover',e=>{if(first&&e.target.closest('#root')){first=false;requestAnimationFrame(()=>{const n=document.createElement('button');n.type='button';n.setAttribute('aria-label','Add item');n.textContent='Add item';n.onclick=()=>record('upload');root.replaceChildren(n)})}});`, label: 'Add item' },
};
for (const [name, page] of Object.entries(falseCancels))
  test('when ' + name + ', the click is cancelled with a plain message and one retry after a read succeeds (4 of 4)', { skip, timeout: 120000 }, async t => {
    const b = await bank(t); let retried = 0, firstOk = 0;
    for (let i = 0; i < 4; i++) {
      const f = await b.start(doc(page.body, page.script, '', { audit: false }), readOnly);
      await settleFor(150);
      const first = await f.act([{ do: 'click', ref: f.ref(page.label) }]);
      await settleFor(120);
      if (f.delta().upload >= 1) { firstOk++; continue; }
      const line = first.text.split('\n')[0];
      // A page that acts on the press has already seen part of the click: no "not run", no "retry is safe".
      if (page.pressSeen) {
        assert.match(line, /^1 click \S+: effect unconfirmed; read before retrying\. page changed during the click; the page had already received part of it\./);
        assert.doesNotMatch(line, /not run|retry is safe/);
      } else assert.match(line, /not run: page changed during the click; read again\. The page received no press, release or click, so a fresh read and one retry is safe\./);
      const text = await f.read();
      const again = await f.act([{ do: 'click', ref: f.ref(page.label, text) }]);
      await settleFor(120);
      assert.equal(f.delta().upload, 1, 'retry ' + i + ': ' + again.text.split('\n')[0]);
      retried++;
    }
    t.diagnostic('first click delivered ' + firstOk + ', cancelled then retried ' + retried + ' of 4');
  });

// ---- Round 4: what the reviewer's repros of round 3 found -----------------------------------------------------
// Every frame Playwright knows is armed from Node, so the click is cancelled wherever a control is shown at the
// second pointer move. The independent server must record no payment in any round.
const payBody = `<style>body{margin:0}button{width:100vw;height:100vh}</style><button type="button" onclick="(parent.record||record)('payment')">Pay now</button>`;
const cancelsWith = (t, label, n, make) => async () => {
  const b = await bank(t); let cancelled = 0;
  for (let i = 0; i < n; i++) {
    const f = await make(b);
    await settleFor(600);
    const result = await f.act([{ do: 'click', ref: f.ref(label) }]);
    await settleFor(300);
    assert.equal(f.delta().payment, 0, 'round ' + i + ': ' + result.text.split('\n')[0]);
    if (/page changed during the click/.test(result.text)) cancelled++;
  }
  t.diagnostic('cancelled ' + cancelled + '/' + n);
  return cancelled;
};
const showAtSecondMove = (target, show) => `let n=0;${target}.addEventListener('pointermove',()=>{n++;if(n==2){${show}}});`;

// F2-A: document.open() in a child frame erased the hook's window listeners (4 of 4 payments in round 3).
const framed = `<div class="box" id="c"><button id="x" class="fill" type="button" aria-label="Close ad">Close ad</button><iframe id="fr" class="fill" src="/pay-frame" style="z-index:2;opacity:0.01;visibility:hidden"></iframe></div>`;
const openCases = {
  'the child frame rewrites itself at load, then is shown at the second move': { route: `<script>document.open();document.write(${JSON.stringify(payBody)});document.close()</script>`, show: `fr.style.visibility='visible'` },
  'the parent calls fr.contentDocument.open() at the second move, after arming': { route: payBody, show: `const d=fr.contentDocument;d.open();d.write(${JSON.stringify(payBody)});d.close();fr.style.visibility='visible'` },
  'the parent calls its own Document.prototype.open on the child document': { route: payBody, show: `const d=fr.contentDocument;Document.prototype.open.call(d);d.write(${JSON.stringify(payBody)});d.close();fr.style.visibility='visible'` },
};
for (const [name, c] of Object.entries(openCases))
  test('F2-A: ' + name + ' (0 of 4 payments)', { skip, timeout: 120000 }, async t => {
    const cancelled = await cancelsWith(t, 'Close ad', 4, b => b.start(plain(css + framed, showAtSecondMove('x', c.show)), readOnly, { routes: { '/pay-frame': plain(c.route) } }))();
    assert.equal(cancelled, 4, 'every click that met the rewritten frame is reported as cancelled');
  });

// F2-B: the checked element is in a same-origin child frame; a top overlay or a sibling frame shown at the second move.
const innerPage = plain(`<style>body{margin:0}button{width:100vw;height:100vh}</style><button id="x" type="button" aria-label="Close ad" onclick="parent.record('upload')">Close ad</button>`, `let n=0;x.addEventListener('pointermove',()=>{n++;if(n==2)parent.show()});`);
const wide = `<style>body{margin:0}.box{position:relative;width:200px;height:60px;margin:10px}.fill{position:absolute;inset:0;width:100%;height:100%;border:0}</style>`;
const childFrameCases = {
  'a top overlay shown at the second move over a button in a same-origin child frame': { html: `<div class="box"><iframe class="fill" src="/inner"></iframe><button id="ov" class="fill" type="button" style="z-index:3;opacity:0.01;visibility:hidden" onclick="record('payment')">Pay now</button></div>`, script: `window.show=()=>{ov.style.visibility='visible'}` },
  'a sibling same-origin frame shown at the second move over a button in a child frame': { html: `<div class="box"><iframe class="fill" src="/inner"></iframe><iframe id="sib" class="fill" src="/paysib" style="z-index:3;opacity:0.01;visibility:hidden"></iframe></div>`, script: `window.show=()=>{sib.style.visibility='visible'}` },
};
for (const [name, c] of Object.entries(childFrameCases))
  test('F2-B: ' + name + ' (0 of 4 payments)', { skip, timeout: 120000 }, async t => {
    const cancelled = await cancelsWith(t, 'Close ad', 4, b => b.start(plain(wide + c.html, c.script), readOnly, { routes: { '/inner': innerPage, '/paysib': plain(payBody) } }))();
    assert.equal(cancelled, 4);
  });
test('F2-B control: a plain click on a button in a same-origin child frame is delivered (4 of 4)', { skip, timeout: 120000 }, async t => {
  const b = await bank(t);
  for (let i = 0; i < 4; i++) {
    const f = await b.start(plain(wide + `<div class="box"><iframe class="fill" src="/inner"></iframe></div>`, 'window.show=()=>{}'), readOnly, { routes: { '/inner': innerPage } });
    await settleFor(600);
    const result = await f.act([{ do: 'click', ref: f.ref('Close ad') }]);
    await settleFor(300);
    assert.equal(f.delta().upload, 1, 'round ' + i + ': ' + result.text.split('\n')[0]);
  }
});

// F2-C: an iframe in a shadow root is not in window[i]; it was never armed (4 of 4 payments in round 3).
test('F2-C: an iframe in an open shadow root shown at the second move takes no click (0 of 4 payments)', { skip, timeout: 120000 }, async t => {
  const html = framed.replace(/<iframe[^>]*><\/iframe>/, '') + '<div id="h"></div>';
  const script = `const sr=h.attachShadow({mode:'open'});sr.innerHTML='<iframe id="sf" src="/pay-frame" style="position:absolute;left:10px;top:10px;width:160px;height:48px;border:0;z-index:2;opacity:0.01;visibility:hidden"></iframe>';`
    + showAtSecondMove('x', `sr.getElementById('sf').style.visibility='visible'`);
  const cancelled = await cancelsWith(t, 'Close ad', 4, b => b.start(plain(css + html, script), readOnly, { routes: { '/pay-frame': plain(payBody) } }))();
  assert.equal(cancelled, 4);
});

// F9: "not run ... retry is safe" only when the page saw no press, release or click. A page that acts on pointerdown
// has already acted when the later events are cancelled.
test('F9: a page that acts on pointerdown and then relabels is reported as unconfirmed, never as safe to retry (4 of 4)', { skip, timeout: 120000 }, async t => {
  const b = await bank(t);
  for (let i = 0; i < 4; i++) {
    const f = await b.start(doc(`<button id="b" type="button" aria-label="Add item" onclick="record('submit')">Add item</button>`, `b.addEventListener('pointerdown',()=>{record('upload');b.textContent='Added'});`, '', { audit: false }), readOnly);
    await settleFor(150);
    const result = await f.act([{ do: 'click', ref: f.ref('Add item') }]);
    await settleFor(250);
    const line = result.text.split('\n')[0];
    assert.equal(f.delta().upload, 1, 'the page did act on pointerdown');
    assert.match(line, /effect unconfirmed; read before retrying\./);
    assert.doesNotMatch(line, /not run|retry is safe/);
  }
});
test('F9: a button that is removed on mousedown is reported as unconfirmed, not as safe to retry', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(`<button id="b" type="button" aria-label="Add item" onclick="record('submit')">Add item</button>`, `b.addEventListener('mousedown',()=>{record('upload');b.remove()});`, '', { audit: false }), readOnly);
  await settleFor(150);
  const result = await f.act([{ do: 'click', ref: f.ref('Add item') }]);
  const line = result.text.split('\n')[0];
  assert.match(line, /effect unconfirmed/);
  assert.doesNotMatch(line, /not run|retry is safe/);
});

// Low: a page that rewrites the URL 30 ms after hover is still cancelled (the seal keeps document.URL), but the
// message says a retry is safe, and the retry after a fresh read succeeds.
test('a page that rewrites the URL 30 ms after hover is cancelled as safe to retry, and the retry succeeds (4 of 4)', { skip, timeout: 120000 }, async t => {
  const b = await bank(t); let retried = 0;
  for (let i = 0; i < 4; i++) {
    const f = await b.start(doc(`<button id="b" type="button" aria-label="Next step" onclick="record('upload')">Next step</button>`, `b.addEventListener('mouseenter',()=>{setTimeout(()=>history.replaceState(null,'','?hover='+Date.now()),30)});`, '', { audit: false }), readOnly);
    await settleFor(150);
    const first = await f.act([{ do: 'click', ref: f.ref('Next step') }]);
    await settleFor(150);
    if (f.delta().upload >= 1) continue;
    assert.match(first.text.split('\n')[0], /not run: page changed during the click; read again\. The page received no press, release or click, so a fresh read and one retry is safe\./);
    const text = await f.read();
    await f.act([{ do: 'click', ref: f.ref('Next step', text) }]);
    await settleFor(150);
    assert.equal(f.delta().upload, 1, 'retry ' + i);
    retried++;
  }
  t.diagnostic('cancelled then retried ' + retried + ' of 4');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readPaymentPage } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';

// The fake DOM paints black text on nothing and has no other painted elements (readPaymentPage checks fill, contrast, size and cover).
const paint = {color:'rgb(0, 0, 0)',webkitTextFillColor:'rgb(0, 0, 0)',backgroundColor:'rgba(0, 0, 0, 0)',backgroundImage:'none',filter:'none',maskImage:'none',mixBlendMode:'normal',fontSize:'16px'};
const rect = (left=10,top=10,width=200,height=20) => ({left,top,right:left+width,bottom:top+height,x:left,y:top,width,height});
function fixture({ style={}, box=rect(), parentStyle={}, parentBox=rect(0,0,500,500), fragments, decoy, pageLines, amountText, ownLabel } = {}) {
  const node = (text,extra={}) => ({localName:'p',nodeType:1,isConnected:true,style:{display:'block',visibility:'visible',opacity:'1',...extra.style},
    textContent:text,box:extra.box ?? rect(),getBoundingClientRect() {return this.box;},
    getClientRects() {return [this.box];},checkVisibility() {return this.style.visibility !== 'hidden' && this.style.display !== 'none';},
    getAttribute() {return null;},...extra});
  const root=node('',{style:{display:'block',visibility:'visible',opacity:'1',...parentStyle},box:parentBox});
  root.clientLeft=0; root.clientTop=0; root.clientWidth=parentBox.width; root.clientHeight=parentBox.height;
  const amount=node('Amount: ' + (amountText ?? (pageLines ? '5.00' : '18.00')),{style:{display:'block',visibility:'visible',opacity:'1',...style},box,parentElement:root});
  const rows=pageLines?.map(text => node(text,{parentElement:root}));
  for (const row of [amount,...rows ?? []]) row.childNodes=[{nodeType:3,textContent:row.textContent,parentElement:row}];
  root.childNodes=[amount,...rows ?? []];
  const hidden=decoy && node('Amount: 99.00',{style:{display:'none',visibility:'visible',opacity:'1'},parentElement:root});
  root.querySelectorAll=selector => selector.includes('amount') ? [...hidden ? [hidden] : [],amount] : [];
  const doc={documentElement:{style:{}},defaultView:{innerWidth:800,innerHeight:600,location:{origin:'https://fixture.invalid'},getComputedStyle:n => ({...paint,...n.style})},
    createRange() {let node; return {selectNodeContents(n) {node=n;},getClientRects:() => (node.parentElement ?? node).getClientRects()};},
    createTreeWalker(n) {
      const parts=fragments && n === root ? fragments.map(([text,parent]) => ({nodeType:3,textContent:text,parentElement:parent === 'inline' ? node(text,{localName:'b',style:{display:'inline',visibility:'visible',opacity:'1'},parentElement:amount}) : amount}))
        : n.textContent ? [{nodeType:3,parentElement:n,textContent:n.textContent}] : [];
      return {nextNode:() => parts.shift() ?? null};
    }};
  amount.ownerDocument=doc; root.ownerDocument=doc;
  for (const row of rows ?? []) row.ownerDocument=doc;
  if (fragments) root.querySelectorAll=() => [];
  return {doc,root,amount,read:(lenient = false) => runInNewContext(readPaymentPage.helpers.map(helper => 'const ' + helper.name + ' = (' + helper + ');').join('') + '(' + readPaymentPage.toString() + ')(el,lenient)',{ lenient,
    el:{ownerDocument:doc,form:root,closest:() => root,getAttribute:key => key === 'aria-label' ? ownLabel ?? null : null},
  })};
}

for (const amountText of ['1,304', '1.304', '1 304', '1\u202f304', "1'304", '1’304', '1,304.00', '1.304,00', '$1,304'])
  test(`SA1P serialized browser amount field cannot raise the user reading: ${amountText}`, () => {
    assert.equal(fixture({amountText, pageLines:['Total $1,304.00']}).read().page.amount, ['1,304', '$1,304', '1,304.00', '1.304,00'].includes(amountText) ? amountText : undefined);
    assert.equal(fixture({amountText, pageLines:['Total $1,305.00']}).read().page.amount, undefined);
  });

for (const total of ['$5.00 1000 USD', '$5.00 1000 dollars', '$5,00 1000 USD',
  'USD 5.00 250 EUR', '$5.00 1 000 USD'])
  test(`SA1O serialized browser refuses adjacent figures: ${total}`, () => {
    assert.equal(fixture({pageLines:['Total ' + total]}).read().page.amount, undefined);
  });

// Exercise the functions as source strings in the utility world, without launching a browser.
for (const [text, item] of [['1.304 €', '€5.00'], ['€1 304', '€5.00'], ['€1\u202f304', '€5.00'],
  ["CHF 1'304.00", 'CHF 5.00'], ['$1.2 million', '$5.00'], ['€1,2 Mio.', '€5.00'], ['₹5 lakh', '₹5.00'], ['5 k €', '€5.00'],
  ['1.304 567 €', '€5.00'], ['1.20 million', '$5.00']])
  test(`SA1B serialized payment page rejects the hidden larger reading: ${text}`, () => {
    assert.equal(fixture({pageLines:['Total ' + text, 'Item ' + item]}).read().page.amount, undefined);
  });
for (const text of ['$5.00', '$1.30', '$0.304'])
  test(`SA1B serialized payment page keeps an honest five-dollar payment: ${text}`, () => {
    assert.equal(fixture({pageLines:['Total $5.00', 'Item ' + text]}).read().page.amount, '5.00');
  });

for (const [name,options] of [
  ['opacity below threshold',{style:{opacity:'0.05'}}],
  ['ancestor opacity below threshold',{parentStyle:{opacity:'0.05'}}],
  ['outside viewport',{box:rect(900,10)}],
  ['tiny box',{box:rect(10,10,3,3)}],
  ['clipped by scrollport',{box:rect(498,10),parentStyle:{overflowX:'hidden'}}],
  ['clipped vertically',{box:rect(10,498),parentStyle:{overflowY:'auto'}}],
  ['clip path',{style:{clipPath:'inset(99.9%)'}}],
  ['legacy clip',{style:{clip:'rect(0px, 1px, 1px, 0px)'}}],
]) test('V10R2C payment terms exclude ' + name, () => {
  assert.equal(fixture(options).read().page.amount,undefined);
});
test('V10R2C disagreeing hidden candidates cannot settle visible terms', () => {
  assert.equal(fixture({decoy:true}).read().page.amount,undefined);
});
for (const options of [{},{style:{opacity:'0.5'}},{box:rect(496,10),parentStyle:{overflowX:'scroll'}}])
  test('V10R2C readable area at least 4x4 stays usable ' + JSON.stringify(options), () => {
    assert.equal(fixture(options).read().page.amount,'18.00');
  });

for (const fragments of [
  [['Amount:','inline'],[' 18.00','block']],
  [['Amount:','inline'],['18.00','inline']],
]) test('V10R2D inline labeled amount remains one line ' + JSON.stringify(fragments), () => {
  assert.equal(fixture({fragments}).read().page.amount,'18.00');
});

// Drive serialized DOM evidence through the authenticated browser payment rule.
const { rules, fixture: ruleFixture, terms: ruleTerms } = await import('./direct-browser-rules-fixture.mjs');
function paymentVerdict(amount, page) {
  const f = ruleFixture({ ...ruleTerms, amount });
  return rules.check(f.ctx, 'click', f.pay({ terms: { page: { ...ruleTerms, ...page }, method: ruleTerms.method } })).verdict;
}
for (const separator of ['.', ',', ' ', '\u202f', '\u00a0'])
  test(`SA1P serialized browser asks despite matching user and field text: ${JSON.stringify(separator)}`, () => {
    const amountText = '1' + separator + '304';
    const evidence = fixture({ amountText, pageLines: ['Total $1,304.00'] }).read();
    assert.equal(paymentVerdict(amountText.replace(/\s+/g, ' '), evidence.page), separator === ',' ? 'allow' : 'confirm');
  });
const { paymentFigureSweep } = await import('./fixtures/payment-figure-sweep.mjs');
for (const { text, amount } of paymentFigureSweep)
  test(`SA1P serialized browser sweep: ${JSON.stringify(text)}`, () => {
    const evidence = fixture({ amountText: amount, pageLines: [text] }).read();
    assert.equal(paymentVerdict(amount, evidence.page), 'confirm');
  });

const { sa1tAsks, metadataRows, groupingCases } = await import('./fixtures/payment-figure-sweep.mjs');
for (const { text, amount } of sa1tAsks) test(`SA1T serialized browser asks: ${JSON.stringify(text)}`, () => {
  const evidence = fixture({ amountText: amount, pageLines: [text] }).read();
  assert.equal(evidence.page.amount, undefined);
  assert.equal(paymentVerdict(amount, evidence.page), 'confirm');
});
for (const { raw, total, allow } of groupingCases) test(`SA1T serialized browser grouping ${raw} against ${total}`, () => {
  for (const amountText of allow ? [raw, raw + '.00'] : [raw]) {
    const evidence = fixture({ amountText, pageLines: ['Total ' + total] }).read();
    assert.equal(paymentVerdict(raw.normalize('NFKC'), evidence.page), allow ? 'allow' : 'confirm');
    const larger = fixture({ amountText, pageLines: ['Total ' + total, 'Fee $2000.00'] }).read();
    assert.equal(paymentVerdict(raw.normalize('NFKC'), larger.page), 'confirm');
  }
});
for (const row of metadataRows) test(`SA1V serialized browser metadata: ${row}`, () => {
  const evidence = fixture({ amountText: '5.00', pageLines: [row] }).read();
  assert.equal(paymentVerdict('5.00', evidence.page), 'confirm');
  const higher = fixture({ amountText: '5.00', pageLines: [row, 'Fee $6.00'] }).read();
  assert.equal(paymentVerdict('5.00', higher.page), 'confirm');
});

const { sa1vAsks, sa1vUnits } = await import('./fixtures/payment-figure-sweep.mjs');
for (const [rows, allow] of [[sa1vAsks, false], [sa1vUnits, true]])
  for (const text of rows) test(`SA1V serialized browser ${allow ? 'allows' : 'asks'}: ${text}`, () => {
    const evidence = fixture({ amountText: '5.00', pageLines: [text, 'Total $5.00'] }).read();
    assert.equal(paymentVerdict('5.00', evidence.page), allow ? 'allow' : 'confirm');
  });
for (const amount of ['1.304', '1.200']) test(`SA1V browser never keeps the smaller user reading: ${amount}`, () => {
  const f = ruleFixture({ ...ruleTerms, amount });
  f.ctx.confirmPayments = 'never';
  const total = amount.replace('.', ',') + '.00';
  const evidence = fixture({ amountText: total, pageLines: ['Total $' + total] }).read(true);
  assert.equal(evidence.unchecked.amount, total);
  const terms = { ...ruleTerms, ...evidence.page };
  assert.equal(rules.check(f.ctx, 'click', f.pay({ terms: { page: terms, unchecked: { ...ruleTerms, ...evidence.unchecked }, method: ruleTerms.method } })).verdict, 'confirm');
});

const { joinedDecimals, conflictingCurrencies, compatibleCurrencies } = await import('./fixtures/payment-sa1x.mjs');
for (const text of [...joinedDecimals, ...conflictingCurrencies]) test(`SA1X serialized browser asks: ${text}`, () => {
  const evidence = fixture({ amountText: '5.00', pageLines: [text, 'Total $5.00'] }).read();
  assert.equal(evidence.page.amount, undefined);
  assert.equal(paymentVerdict('5.00', evidence.page), 'confirm');
});
for (const text of compatibleCurrencies.filter(text => !text.includes('€')))
  test(`SA1X serialized browser compatible currency: ${text}`, () => {
    const evidence = fixture({ amountText: '5.00', pageLines: [text, 'Total $5.00'] }).read();
    assert.equal(evidence.page.amount, '5.00');
    assert.equal(paymentVerdict('5.00', evidence.page), 'allow');
  });

const { hashCases, currencyHashCases } = await import('./fixtures/payment-sa1z.mjs');
for (const [text, allow] of [...hashCases, ...currencyHashCases]) test(`SA1Z serialized browser ${allow ? 'allows' : 'asks'}: ${text}`, () => {
  const evidence = fixture({ amountText: '5.00', pageLines: [text, 'Total $5.00'] }).read();
  assert.equal(evidence.page.amount, allow ? '5.00' : undefined);
  assert.equal(paymentVerdict('5.00', evidence.page), allow ? 'allow' : 'confirm');
});
for (const [text, allow] of [['№1.500,00', false], ['USD №1500', false], ['№1 500', false], ['Order №1042', true], ['Total №5', true]])
  test(`SA1Z serialized browser control label ${allow ? 'allows' : 'asks'}: ${text}`, () => {
    const evidence = fixture({ amountText: '5.00', pageLines: ['Total $5.00'], ownLabel: text }).read();
    assert.equal(evidence.page.amount, allow ? '5.00' : undefined);
    assert.equal(paymentVerdict('5.00', evidence.page), allow ? 'allow' : 'confirm');
  });

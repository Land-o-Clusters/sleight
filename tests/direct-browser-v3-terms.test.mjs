import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readPaymentPage } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';

// The fake DOM paints black text on nothing and has no other painted elements (readPaymentPage checks fill, contrast, size and cover).
const paint = {color:'rgb(0, 0, 0)',webkitTextFillColor:'rgb(0, 0, 0)',backgroundColor:'rgba(0, 0, 0, 0)',backgroundImage:'none',filter:'none',maskImage:'none',mixBlendMode:'normal',fontSize:'16px'};
const rect = (left=10,top=10,width=200,height=20) => ({left,top,right:left+width,bottom:top+height,x:left,y:top,width,height});
function fixture({ style={}, box=rect(), parentStyle={}, parentBox=rect(0,0,500,500), fragments, decoy } = {}) {
  const node = (text,extra={}) => ({localName:'p',nodeType:1,isConnected:true,style:{display:'block',visibility:'visible',opacity:'1',...extra.style},
    textContent:text,box:extra.box ?? rect(),getBoundingClientRect() {return this.box;},
    getClientRects() {return [this.box];},checkVisibility() {return this.style.visibility !== 'hidden' && this.style.display !== 'none';},
    getAttribute() {return null;},...extra});
  const root=node('',{style:{display:'block',visibility:'visible',opacity:'1',...parentStyle},box:parentBox});
  root.clientLeft=0; root.clientTop=0; root.clientWidth=parentBox.width; root.clientHeight=parentBox.height;
  const amount=node('Amount: 18.00',{style:{display:'block',visibility:'visible',opacity:'1',...style},box,parentElement:root});
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
  if (fragments) root.querySelectorAll=() => [];
  return {doc,root,amount,read:() => runInNewContext(readPaymentPage.helpers.map(helper => 'const ' + helper.name + ' = (' + helper + ');').join('') + '(' + readPaymentPage.toString() + ')(el)',{
    el:{ownerDocument:doc,form:root,closest:() => root,getAttribute:() => null},
  })};
}

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

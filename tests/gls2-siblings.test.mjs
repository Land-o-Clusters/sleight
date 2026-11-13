import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const mutations = {
  role: ["if (i === ctx.target || !buttonIdentityRole.test(a.role)) return false;", "if (i === ctx.target) return false;"],
  'acted-role': ['ctx.delivered[n]?.role === a.role', 'true'],
  money: ["moneyOrSecret(text) || classifyConsequentialLabel(text) === 'boundary'", 'false'],
  parent: ['ctx.delivered[n]?.parentIndex === a.parentIndex', 'true'],
  target: ['if (i === ctx.target || !buttonIdentityRole.test(a.role))', 'if (!buttonIdentityRole.test(a.role))'],
  modal: ["if (a.parents.some(p => surfaceRole.test(role(p)) || role(p) === 'web area') ||\n      b.parents.some(p => surfaceRole.test(role(p)) || role(p) === 'web area')) return false;", ''],
  shift: ['if (ctx.delivered.some(r => r.parentIndex === a.parentIndex && r.index !== i && siblingName(r) === bi)) return false;', ''],
  value: ['return shownValue(a.body) === shownValue(b.body);', 'return true;'],
  flags: ["if (fa.filter(f => !free.has(f)).join() !== fb.filter(f => !free.has(f)).join()) return 'flags';", ''],
  count: ['if (old.length !== fresh.length) return false;', ''],
  cells: ["if (entry && (!entry.actions || entry.actions.cell !== cell))", 'if (entry && !entry.actions)'],
};
if (process.env.GLS2_MUTANT) {
  const pair = mutations[process.env.GLS2_MUTANT]; assert.ok(pair);
  registerHooks({ load(url, ctx, next) { const loaded = next(url, ctx);
    if (!url.endsWith('/mac-driver/diff.mjs')) return loaded;
    assert.ok(String(loaded.source).includes(pair[0]));
    return { ...loaded, source: String(loaded.source).replace(pair[0], pair[1]).replace(...(process.env.GLS2_MUTANT === 'value' ? ["return 'value-drift';", 'return;'] : ['__absent__', '__absent__'])).replace(...(process.env.GLS2_MUTANT === 'flags' ? ['if (keptFlags(a.body) !== keptFlags(b.body)) return false;', ''] : ['__absent__', '__absent__'])) };
  } });
}
const { compareMacElement, createMacReadState } = await import('../plugins/sleight/lib/mac-driver/diff.mjs');
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.apple.calculator', app: 'Calculator', title: 'Calculator', identityVerified: true };
const header = 'Window: "Calculator", App: Calculator.';
const tree = rows => header + '\n' + ['standard window Calculator', ...rows].map((body, n) => body.replace(/^(\t*)(.*)/, (_, tabs, text) => tabs + n + ' ' + text)).join('\n');
const base = ['\tcontainer ID: keypad', '\t\tbutton All Clear, ID: AllClear', '\t\tbutton Seven, ID: Seven', '\t\tbutton One, ID: One'];
const changed = base.map(r => r.replace('All Clear, ID: AllClear', 'Clear, ID: Clear'));
const cases = [];
const add = (id, name, before, after, target = 4, acted = [3], allow = false) => cases.push({ id, name, before: Array.isArray(before) ? tree(before) : before, after: Array.isArray(after) ? tree(after) : after, target, acted, allow });
add(1, 'Seven acted, then One', base, changed, 4, [3], true);
add(2, 'the drifted sibling is the target', base, changed, 2);
add(3, 'a field grants no button identity freedom', ['\tcontainer', '\t\ttext field Query', '\t\tbutton Search', '\t\tbutton Options, ID: One'], ['\tcontainer', '\t\ttext field Query', '\t\tbutton Clear', '\t\tbutton Options, ID: One'], 4, [2]);
for (const [old, fresh] of [['Clear', 'Delete All'], ['Add', 'Save']]) add(4, 'consequential ' + fresh, base.map(r => r.replace('All Clear', old)), base.map(r => r.replace('All Clear', fresh)));
add(5, 'money', base.map(r => r.replace('All Clear', 'Add $5')), base.map(r => r.replace('All Clear', 'Add $50')));
add(6, 'another parent', ['\tcontainer ID: toolbar', '\t\tbutton Mode', '\tcontainer ID: keypad', '\t\tbutton Seven', '\t\tbutton One, ID: One'], ['\tcontainer ID: toolbar', '\t\tbutton Pause', '\tcontainer ID: keypad', '\t\tbutton Seven', '\t\tbutton One, ID: One'], 5, [4]);
add(7, 'role change', base, changed.map(r => r.replace('button Clear', 'menu button Clear')));
add(8, 'shift of sibling identities', ['\tcontainer', ...['0','1','2','3','5'].map(r => '\t\tbutton ' + r)], ['\tcontainer', ...['0','2','3','4','5'].map(r => '\t\tbutton ' + r)], 6, [2]);
add(9, 'checked gain', ['\tcontainer', '\t\ttoggle button Bold', '\t\tbutton Italic', '\t\tbutton One, ID: One'], ['\tcontainer', '\t\ttoggle button (checked) Bold', '\t\tbutton Italic', '\t\tbutton One, ID: One']);
add(10, 'no action in this cell', base, changed, 4, []);
for (const [id, context] of [[11,'sheet'],[12,'web area'],['11b','dialog'],['11c','alert'],['11d','popover'],['11e','menu (expanded)'],['11f','dialog window'],['11g','floating window'],['11h','system dialog'],['11i','web dialog'],['11j','system window'],['11k','pop over']]) add(id, context, base.map((r,i)=>i ? r : '\t' + context), changed.map((r,i)=>i ? r : '\t' + context));
for (const surface of ['dialog window','floating window','system window'])
  add('modal-root', surface + ' root', tree(base).replace('standard window Calculator',surface + ' Confirm'), tree(changed).replace('standard window Calculator',surface + ' Confirm'));
const captured = readFileSync(new URL('./fixtures/glc1-calculator-closed.txt', import.meta.url),'utf8');
const after = readFileSync(new URL('./fixtures/glc2-calculator-after-seven.txt', import.meta.url),'utf8');
add(13, 'recorded E1 plus E2b', captured, after, 22, [14], true);
add(14, 'sibling removed after the target', [...base, '\t\tbutton Other'], changed, 4, [3]);
add('count', 'sibling added after target', base, [...changed, '\t\tbutton New']);
add('flag-button', 'checked sibling button', base, changed.map(r=>r.replace('button Clear','button (checked) Clear')));
add(15, 'Value added', base, changed.map(r=>r.replace('ID: Clear', 'ID: Clear, Value: playing')));
for (const role of ['button','toggle button','menu button','pop up button']) add('roles', role, base.map(r=>r.replace('button',role)), changed.map(r=>r.replace('button',role)),4,[3],true);
add('flags', 'selected gain',base,changed.map(r=>r.replace('button Clear','button (selected) Clear')));
add('depth', 'depth change',base,changed.map(r=>r.replace('\t\tbutton Clear','\t\t\tbutton Clear')));
add('metadata', 'URL added',base,changed.map(r=>r.replace('ID: Clear','ID: Clear, URL: https://example.test')));
add('consequential', 'consequential target stays byte-exact', base.map(r=>r.replace('One, ID: One','Save, ID: One')), changed.map(r=>r.replace('One, ID: One','Save, ID: One')));
add('secure', 'secure target stays byte-exact', base.map(r=>r.replace('button One, ID: One','secure text field Password, ID: One')), changed.map(r=>r.replace('button One, ID: One','secure text field Password, ID: One')));
for (const flag of ['disabled','focused']) add('free-flag', flag+' context freedom',base,changed.map(r=>r.replace('button Clear','button ('+flag+') Clear')),4,[3],true);
add('shift-role', 'an identity cannot shift from a sibling of another role', ['\tcontainer','\t\ttext Clear, ID: Clear','\t\tbutton All Clear, ID: AllClear','\t\tbutton Seven','\t\tbutton One, ID: One'], ['\tcontainer','\t\ttext Clear, ID: Clear','\t\tbutton Clear, ID: Clear','\t\tbutton Seven','\t\tbutton One, ID: One'],5,[4]);
add('help', 'unchanged metadata is outside identity text',base.map(r=>r.replace('ID: AllClear','ID: AllClear, Help: Pay no attention')),changed.map(r=>r.replace('ID: Clear','ID: Clear, Help: Pay no attention')),4,[3],true);
add('3b', 'siblings of an acted text field have no identity freedom', ['\tcontainer','\t\ttext field Hint','\t\ttext field Query','\t\tbutton One, ID: One'], ['\tcontainer','\t\ttext field Other','\t\ttext field Query','\t\tbutton One, ID: One'],4,[3]);
for (const c of cases) test(`B${c.id} ${c.name}`, () => {
  for (const selector of [false,true]) {
    const state = createMacReadState(), s = state.read({window, text:c.before,readId:1,truncated:false});
    state.endCell([{type:'text',text:c.before}],[s]);
    for (const n of c.acted) state.assertCurrent('click',{...window,readId:1,args:[n]},'cell')?.();
    state.read({window,text:c.after,readId:2,truncated:false});
    const targetId = new RegExp('\\t*' + c.target + ' .*?ID: ([^,\\n]+)').exec(c.before)?.[1];
    const target = selector ? {id:targetId} : c.target;
    if (selector && !targetId) continue;
    const invoke = () => state.assertCurrent('click',{...window,readId:2,args:[target]},'cell');
    if (c.allow) assert.doesNotThrow(invoke); else assert.throws(invoke,{code:'STALE_READ'});
  }
});
test('B10 endCell and a new cell retire the acted set', () => {
  const s=createMacReadState(), a=s.read({window,text:tree(base),readId:1}); s.endCell([{type:'text',text:a.text}],[a]);
  s.assertCurrent('click',{...window,readId:1,args:[3]},'old')();
  s.read({window,text:tree(changed),readId:2});
  assert.throws(()=>s.assertCurrent('click',{...window,readId:2,args:[4]},'new'),{code:'STALE_READ'});
});
test('E2b property: 1000 role, parent, state, value, money, modal and count mutations', () => {
  let allow=0, refuse=0;
  for (let i=0;i<1000;i++) {
    const bad=i%8, rows=[...base], now=[...changed]; let acted=[3];
    if (bad===1) acted=[];
    if (bad===2) {rows[2]='\t\ttext field Query';now[2]='\t\ttext field Query';}
    if (bad===3) now[1]+=', Value: playing';
    if (bad===4) now[1]=now[1].replace('button Clear','button (checked) Clear');
    if (bad===5) now[1]=now[1].replace('Clear, ID: Clear','Pay $5, ID: Pay');
    if (bad===6) {rows[0]='\tweb area';now[0]='\tweb area';}
    if (bad===7) {rows.splice(3,0,'\t\tbutton Other');now.splice(3,0,'\t\ttext Other');}
    const chosenRole=['button','toggle button','menu button','pop up button'][Math.floor(i/8)%4];
    const suffix=' item-'+i;
    const vary = values => values.map(row => row.replaceAll('button ',chosenRole+' ').replace('All Clear,','All Clear'+suffix+',').replace('Clear,','Clear'+suffix+','));
    const result=compareMacElement(tree(vary(rows)),tree(vary(now)),bad===7?5:4,{acted});
    const want=bad===0; assert.equal(result.to!==undefined,want,`mutation ${i}`); if(want)allow++;else refuse++;
  }
  assert.equal(allow,125);assert.equal(refuse,875);
});

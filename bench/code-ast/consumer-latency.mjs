// Headless CPU timing over the fixed recorded corpus. No caller source executes.
import { performance } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import { writeFileSync } from 'node:fs';
import { readCorpus } from './corpus.mjs';
import { calls as oldFlow } from './legacy-ca2/flow-rules.mjs';
import { nativeArgumentsProblem as oldNative } from './legacy-ca2/native-arguments.mjs';
import { literalElements as oldElements } from './legacy-ca2/literal-elements.mjs';
import { clipboardActions as oldClipboard } from './legacy-ca2/clipboard.mjs';
import { calls } from '../../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../../plugins/sleight/lib/clipboard.mjs';
import { parseCell, clearCellCache, withCellCache } from '../../plugins/sleight/lib/code-ast.mjs';
import { dispatchInspection } from '../../plugins/sleight/lib/dispatched-calls.mjs';
import { guardedCode } from '../../plugins/sleight/lib/document-scope.mjs';
const corpus = await readCorpus(), fallback = {app:'Fixture'};
const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
const before = loadavg(), old=[], current=[], added=[];
let refused=0, verified=0; const refusalReasons={};
function legacy(code) { oldFlow(code,new Map(),fallback); oldNative(code); oldElements(code); oldClipboard(code); }
function inspect(code, cold=false) { return withCellCache(()=>inspectBody(code,cold)); }
function inspectBody(code, cold=false) {
  if (parseCell(code).error) return 'parse';
  calls(code,new Map(),fallback);
  const nativeProblem=nativeArgumentsProblem(code); if (nativeProblem) return nativeProblem;
  const elements=literalElements(code); clipboardActions(code);
  // Admission and post-rewrite checks both run in the relay. The AST is shared.
  nativeArgumentsProblem(code); clipboardActions(code);
  const check=dispatchInspection(code);
  const output=check.wrap(check.mark(code), source => guardedCode(source,{app:'Fixture',title:'Fixture'},undefined,undefined,
    {reuseSetup:!cold,literalOrder:elements}));
  return check.verify(output) ? true : 'dispatch mismatch';
}
// Warm the functions once on a bounded portion of the same corpus, then measure
// every record with its actual source. Alternate order to reduce temporal bias.
for (const {code} of corpus.records.slice(0,200)) { try {legacy(code);inspect(code);} catch {} }
clearCellCache();
for (const [i,{code}] of corpus.records.entries()) {
  let a,b,ok;
  const measureOld=()=>{const start=performance.now();try{legacy(code);}catch{}a=performance.now()-start;};
  const measureNew=()=>{const start=performance.now();try{ok=inspect(code);}catch(error){ok=error.message;}b=performance.now()-start;};
  if(i%2){measureNew();measureOld();}else{measureOld();measureNew();}
  old.push(a);current.push(b);added.push(b-a);if(ok===true)verified++;else {refused++;refusalReasons[ok]=(refusalReasons[ok]??0)+1;}
}
clearCellCache();
const coldStart=performance.now();inspect('await app.click(7)',true);const coldMs=performance.now()-coldStart;
const result={manifest:corpus.manifest,records:corpus.records.length,verified,refused,refusalReasons,
  legacyP50Ms:percentile(old,.5),legacyP99Ms:percentile(old,.99),currentP50Ms:percentile(current,.5),currentP99Ms:percentile(current,.99),
  addedP50Ms:percentile(added,.5),addedP99Ms:percentile(added,.99),coldGuardMs:coldMs,loadBefore:before,loadAfter:loadavg(),
  conditions:'Shared Mac; static inspection plus warm native guard construction and final dispatched-source verification. First cold guard reported separately. No live engine latency or IPC is measured.'};
result.pass=result.addedP99Ms<=2;
writeFileSync(new URL('consumer-latency-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));if(!result.pass)process.exitCode=1;

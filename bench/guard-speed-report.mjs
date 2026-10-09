// Summarize every guard-speed run and replay the measured degraded line form on a live tree.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadCompactor, GUARD_MARK } from '../plugins/sleight/lib/compact-reads.mjs';
const directory = new URL('../docs/benchmarks/', import.meta.url);
const files = readdirSync(directory).filter(name => /^2026-10-09-(?:guard-(?:native|preflight|probe)|load-cost-guard-speed)-.*\.json$/.test(name));
const runs = files.map(name => ({ name, data: JSON.parse(readFileSync(new URL(name, directory), 'utf8')) }));
const median = values => { const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)] ?? null; };
const summary = { generated: new Date().toISOString(), modelTurns: 0, modelMs: 0, runs: runs.map(({name,data}) => ({
  file:name, started:data.started, finished:data.finished, error:data.error ?? null,
  workers:data.workers ?? data.addedWorkers ?? null, loadStarted:data.loadStarted, loadEnded:data.loadEnded,
  modes:[...new Set((data.rows ?? []).map(row=>row.mode).filter(Boolean))].map(mode=>{
    const rows=data.rows.filter(row=>row.mode===mode);
    return {mode,count:rows.length,ok:rows.filter(row=>row.response?.status==='ok').length,medianMs:median(rows.map(row=>row.ms))};
  }),
  native: data.rows?.filter(row => row.label === 'native').reduce((out,row) => {
    out.count++; out.statuses[row.response.status]=(out.statuses[row.response.status] ?? 0)+1;
    out.ms.push(row.ms); out.loads.push(row.load); return out;
  }, {count:0,statuses:{},ms:[],loads:[]}),
  helperStarved:data.rows?.filter(row => row.label === 'helper-starved'),
  readProbe:data.rows?.filter(row => ['abandon-read','next-pure-call','next-input-call'].includes(row.label))
    .map(row=>({label:row.label,ms:row.ms,text:row.result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')})),
  levels:data.levels?.map(level=>({workers:level.workers,loadStarted:level.loadStarted,loadEnded:level.loadEnded,
    workersCollected:level.workerCleanup?.length,
    calls:[...new Set(level.rows.map(row=>row.call))].map(call=>({call,
      arms:['direct','sleight'].map(arm=> { const rows=level.rows.filter(row=>row.call===call&&row.arm===arm);
        return {arm,count:rows.length,timedCount:rows.filter(row=>Number.isFinite(row.ms)).length,
          errors:rows.filter(row=>row.isError).length,medianMs:median(rows.map(row=>row.ms)),
          verifiedMedianMs:median(rows.filter(row=>!row.isError).map(row=>row.ms)),
          minLoad:Math.min(...rows.map(row=>row.load).filter(Number.isFinite)),maxLoad:Math.max(...rows.map(row=>row.load).filter(Number.isFinite))}; }) }))})),
  calculatorExit:data.after?.status ?? null, cleanupError:data.cleanupError ?? null,
})) };
for (const run of summary.runs) if (run.native?.count) {
  run.native.medianMs=median(run.native.ms);run.native.minMs=Math.min(...run.native.ms);run.native.maxMs=Math.max(...run.native.ms);
  run.native.minLoad=Math.min(...run.native.loads);run.native.maxLoad=Math.max(...run.native.loads);
  delete run.native.ms;delete run.native.loads;
}
const source = runs.find(run=>run.name === '2026-10-09-guard-probe-2026-10-09T17-38-55-176Z.json');
const tree = source.data.rows.find(row=>row.label==='reset').result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
const degraded = tree.replace(/button Description: [^\n]*?ID: (One|Two|Three|Four|Five|Six|Seven|Eight|Nine)(?=\n|$)/g, 'button $1');
const oldSource = execFileSync('/usr/bin/git', ['show','1bdfd39:plugins/sleight/lib/compact-reads.mjs'],{encoding:'utf8'})
  .replace("'./document-scope.mjs'", JSON.stringify(new URL('../plugins/sleight/lib/document-scope.mjs',import.meta.url).href));
const baseline = await import('data:text/javascript;base64,'+Buffer.from(oldSource).toString('base64'));
const replay = make => {
  const compactor=make();compactor.process([{type:'text',text:tree}]);
  const start=performance.now();const output=compactor.process([{type:'text',text:GUARD_MARK+degraded}])[0].text;
  return {ms:performance.now()-start,chars:output.length,output};
};
const before=Array.from({length:100},()=>replay(baseline.createReadCompactor));
const after=Array.from({length:100},()=>replay(createReadCompactor));
summary.compactor={kind:'constructed degradation replay, not a new live degraded read',source:source.name,
  form:'button Description: 2, ID: Two -> button Two (documented 2026-10-09 engine form)',
  fullChars:tree.length,degradedChars:degraded.length,before:{...before[0],medianMs:median(before.map(row=>row.ms))},
  after:{...after[0],medianMs:median(after.map(row=>row.ms))},fullTree:tree,degradedTree:degraded};
summary.compactorSourceSHA256=createHash('sha256').update(readFileSync(new URL('../plugins/sleight/lib/compact-reads.mjs',import.meta.url))).digest('hex');
writeFileSync(new URL('2026-10-09-guard-speed-summary.json',directory), JSON.stringify(summary,null,2).replaceAll(process.env.HOME,'~')+'\n');
console.log(JSON.stringify({...summary,compactor:{before:summary.compactor.before.chars,after:summary.compactor.after.chars,
  beforeMs:summary.compactor.before.medianMs,afterMs:summary.compactor.after.medianMs}}));

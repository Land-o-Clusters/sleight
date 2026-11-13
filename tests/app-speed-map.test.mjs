// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext, constants } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { speedPlan, readMetrics, runSpeedMap, summarizeSpeedMap, speedMarkdown, simulateSpeedMap, engineError } from '../bench/app-speed-map.mjs';

function closed(values) {
  return new Proxy(values, { get(t, key) {
    if (key === 'then') return undefined;
    if (!(key in t) && typeof key !== 'symbol') throw Error('unsupported engine method: ' + key);
    return t[key];
  } });
}
function runtime({ badCleanup = false, badRead = false, unavailableTree = false, held = false, ownerPresent = false, relayTest, folder = false, canvas = false } = {}) {
  const calls = [], outputs = []; let time = 0, active = 0, peak = 0;
  const directory = relayTest && mkdtempSync(join(tmpdir(), 'sleight-am1-relay-'));
  if (directory) relayTest.after(() => removeTemp(directory));
  return { calls, outputs, get peak() { return peak; }, held: () => held, now: () => time += 5,
    async prepare(task, cohort) { calls.push(['prepare', task.id, cohort]); return { marker: 'AM1-fixture', url:'http://127.0.0.1:45123/fixture', browserId:'bench-id', profileName:'benchmark', requiredText: ownerPresent ? undefined : 'AM1-fixture', ...(folder && { scrollMarker: 'AM1-row.txt' }), ...(canvas && { scrollMarker: 'AM1-fixture' }) }; },
    async openSession(task) {
      const outputs = [];
      active++; peak = Math.max(peak, active); calls.push(['session', task.id]);
      const app = closed({ getAXState: async options => {
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { disableDiffing: true, emit: false });
        if (badRead) throw Error('private account content must not be published');
        if (unavailableTree) return null;
        if (canvas) return 'Window: "AM1-fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n\t\t2 button\n\t3 text entry area Value: AM1-fixture\n\t4 layout area';
        return folder ? 'Window: "AM1-fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n\t\t2 outline Sidebar\n\t3 scroll area\n\t\t4 row\n\t\t\t5 text Value: AM1-row.txt' :
          'Window: "AM1-fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n\t\t2 static text AM1-fixture';
      }, scroll: async (...args) => { calls.push(['scroll', ...args]); }, pressKey: async key => { calls.push(['key', key]); } });
      const tab = closed({ getAXState:app.getAXState, cua:closed({scroll:async options=>calls.push(['browser-scroll',JSON.parse(JSON.stringify(options))])}), close:async()=>calls.push(['tab-close']) });
      const ctx = { cua: closed({ getApp: async () => app, listBrowsers:async()=>[{id:'owner-id',name:'Helium',profileName:'owner'},{id:'bench-id',name:'Helium',profileName:'benchmark'}], createBrowserTab:async(id,url,options)=>{assert.equal(id,'bench-id');assert.equal(url,'http://127.0.0.1:45123/fixture');assert.equal(options.visible,false);return tab;} }), nodeRepl: { write: value => outputs.push(value) } };
      const sent = [], received = [], codes = [];
      let relay, id = 0;
      const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
      if (relayTest) {
        for (const name of ['getTab', 'getBrowser', 'listTabs', 'listApps', 'getState']) ctx.cua[name] = async () => { throw Error('unexpected engine call: ' + name); };
        const lease = new InputLease({ directory });
        for (const [stream, messages] of [[serverIn, sent], [clientOut, received]]) {
          stream.on('data', data => data.toString().trim().split('\n').forEach(line => messages.push(JSON.parse(line))));
        }
        relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: lease, changeReview: false });
        relayTest.after(() => relay.close());
      }
      return { async js(code) {
        codes.push(code);
        if (relay) {
          const current = ++id;
          clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: current, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
          await new Promise(resolve => setImmediate(resolve));
          const refusal = received.find(message => message.id === current);
          if (refusal) return refusal.result;
          const forwarded = sent.find(message => message.id === current);
          assert.ok(forwarded, 'real relay forwarded the request');
          code = forwarded.params.arguments.code;
        }
        outputs.length = 0;
        let result;
        try {
          const saved = ['am1App', 'am1Tab', 'am1Tree'].filter(name => code.includes('var ' + name + ' ='));
          await runInNewContext('(async () => {' + code + saved.map(name => ';globalThis.' + name + ' = ' + name + ';').join('') + '})()', ctx,
            { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
          result = { content: outputs.map(text => ({ type: 'text', text })), _meta: { 'codex/toolSurface': { app: { appId: task.bundle } } } };
        } catch (error) {
          if (!relay) throw error;
          calls.push(['engine-error', error.message]);
          result = { isError: true, content: [{ type: 'text', text: error.message }] };
        }
        if (!relay) return result;
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
        await new Promise(resolve => setImmediate(resolve));
        return received.find(message => message.id === id).result;
      }, async close() { if(ctx.am1Tab) await ctx.am1Tab.close(); relay?.close(); active--; calls.push(['session-close']); } };
    },
    async closeFixture() { calls.push(['fixture-close']); return { confirmed: !badCleanup, focusChanged: false }; },
    async publish(report) { calls.push(['publish']); assert.doesNotMatch(JSON.stringify(report), /private account|AM1-fixture/); },
  };
}

test('speed samples pass the real relay native lease rule with direct handle reads', async t => {
  const r = runtime({ relayTest: t });
  const plan = speedPlan({ ids: ['textedit'], runs: 1 });
  const report = await runSpeedMap(plan, r);
  assert.ok(report.rows.every(row => row.status === 'complete'), JSON.stringify({ rows: report.rows, errors: r.calls.filter(c => c[0] === 'engine-error') }));
  assert.equal(report.rows[0].nodes, 3);
  assert.deepEqual(r.calls.filter(c => c[0] === 'scroll'), [['scroll', 1, 'down', 1]]);
});

test('plan defaults to ten repetitions and four concurrent read-only sessions on one app', () => {
  const plan = speedPlan();
  assert.equal(plan.runs, 10); assert.equal(plan.concurrency, 4); assert.equal(plan.concurrentApp, 'textedit');
  assert.equal(plan.apps.length, 10); assert.equal(plan.excluded.length, 5);
  assert.deepEqual([...new Set(plan.apps.map(a => a.class))].sort(), ['Apple native', 'Chromium', 'Electron/CEF', 'Office']);
  for (const id of ['notes', 'calendar']) assert.equal(plan.apps.find(a => a.id === id).fixture, 'local-container');
});
test('owner account apps are explicit, read-only and require owner-present', () => {
  assert.throws(() => speedPlan({ ids: ['slack'] }), /owner-present/);
  const p = speedPlan({ ids: ['slack', 'discord', 'mail'], ownerPresent: true, concurrentApp: 'slack' });
  assert.ok(p.apps.every(a => a.ownerPresent && a.readOnly));
  assert.throws(() => speedPlan({ runs: 0 }), /runs/);
  assert.throws(() => speedPlan({ ids: ['unknown'] }), /unknown/);
});
test('CLI dry-run returns before importing live runtime, spawning children or writing files', () => {
  const r = spawnSync(process.execPath, ['bench/app-speed-map.mjs', '--dry-run'], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).runs, 10);
  const source = readFileSync(new URL('../bench/app-speed-map.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('if (plan.dryRun)') < source.indexOf("import('./app-speed-map-live.mjs')"));
});
test('read metrics use supported engine methods and return only numbers, not tree content', async () => {
  const app = closed({ getAXState: async () => 'Window: "AM1-fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n\t2 static text private account' });
  const result = await readMetrics(app, { marker: 'AM1-fixture' });
  assert.equal(result.nodes, 3); assert.equal(result.scrollTarget, 1);
  assert.equal(result.chars, 100); assert.doesNotMatch(JSON.stringify(result), /private|AM1-fixture/);
});
test('serialized metrics keep unavailable reads as failures when copying text', async () => {
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), runtime({ unavailableTree: true }));
  assert.ok(report.rows.length > 0);
  for (const row of report.rows) {
    assert.equal(row.status, 'failed');
    assert.equal(row.failure, 'TREE_UNAVAILABLE');
    assert.equal(row.nodes, null);
    assert.equal(row.chars, null);
  }
});
test('ambiguous scroll areas refuse input; a mismatched fixture refuses the read', async () => {
  const app = closed({ getAXState: async () => 'Window: "AM1-fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n\t2 scroll area' });
  assert.equal((await readMetrics(app, { marker: 'AM1-fixture' })).scrollTarget, null);
  await assert.rejects(readMetrics(app, { marker: 'other-window' }), /FIXTURE_IDENTITY/);
});
test('the folder row selects its enclosing scroll area through the real relay', async t => {
  const r = runtime({ folder: true, relayTest: t });
  const report = await runSpeedMap(speedPlan({ ids: ['finder'], runs: 1 }), r);
  assert.ok(report.rows.every(row => row.status === 'complete'), JSON.stringify(report.rows));
  assert.deepEqual(r.calls.filter(call => call[0] === 'scroll'), [['scroll', 3, 'down', 1]]);
});
test('fixture scroll selection refuses missing rows and rows in different scroll areas', async () => {
  for (const rows of ['\t\t2 text other.txt\n\t3 scroll area\n\t\t4 text other.txt',
    '\t\t2 text AM1-row.txt\n\t3 scroll area\n\t\t4 text AM1-row.txt']) {
    const app = closed({ getAXState: async () => 'Window: "fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n' + rows });
    assert.equal((await readMetrics(app, { scrollMarker: 'AM1-row.txt' })).scrollTarget, null);
  }
  const nested = closed({ getAXState: async () => 'Window: "fixture", App: Fixture.\n0 standard window\n\t1 scroll area\n\t\t2 scroll area\n\t\t\t3 text AM1-row.txt' });
  assert.equal((await readMetrics(nested, { scrollMarker: 'AM1-row.txt' })).scrollTarget, 2);
});
test('sequential samples measure acquisition, first/warm reads, literal scroll and readback', async () => {
  const r = runtime();
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 2 }), r);
  const rows = report.rows.filter(row => row.mode === 'sequential');
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === 'complete'));
  for (const key of ['acquireMs', 'firstReadMs', 'warmReadMs', 'actionMs', 'afterReadMs']) assert.ok(rows.every(row => row[key] === 5));
  assert.deepEqual(r.calls.filter(c => c[0] === 'scroll'), [['scroll', 1, 'down', 1], ['scroll', 1, 'down', 1]]);
  assert.equal(r.calls.filter(c => c[0] === 'fixture-close').length, 4);
});
test('concurrent cohort shares one fixture, overlaps four clients, and sends no input', async () => {
  const r = runtime();
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  const rows = report.rows.filter(row => row.mode === 'concurrent');
  assert.equal(rows.length, 4); assert.equal(r.peak, 4);
  assert.equal(r.calls.filter(c => c[0] === 'scroll').length, 1);
  assert.ok(rows.every(row => row.actionMs === null && row.afterReadMs === null));
});
test('owner-present rows collect read timing and tree size without any action', async () => {
  const r = runtime({ ownerPresent: true });
  const report = await runSpeedMap(speedPlan({ ids: ['slack'], runs: 1, ownerPresent: true, concurrentApp: 'slack' }), r);
  assert.ok(report.rows.every(row => row.actionMs === null && row.status === 'complete'));
  assert.equal(r.calls.filter(c => c[0] === 'scroll').length, 0);
});
test('read failure remains a failure, is sanitized and still closes the owned resources', async () => {
  const r = runtime({ badRead: true });
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  assert.ok(report.rows.every(row => row.status === 'failed'));
  assert.doesNotMatch(JSON.stringify(report), /private account/);
  assert.equal(r.calls.filter(c => c[0] === 'session-close').length, 5);
  assert.equal(r.calls.filter(c => c[0] === 'fixture-close').length, 2);
});
test('hold and unconfirmed cleanup stop before the next fixture', async () => {
  const held = runtime({ held: true });
  await assert.rejects(runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), held), /HOLD/);
  assert.deepEqual(held.calls, []);
  const bad = runtime({ badCleanup: true });
  await assert.rejects(runSpeedMap(speedPlan({ ids: ['textedit'], runs: 2 }), bad), /CLEANUP/);
  assert.equal(bad.calls.filter(c => c[0] === 'prepare').length, 1);
});
test('cleanup reason codes survive in the failed sample report', async () => {
  const r = runtime(); let published;
  r.closeFixture = async () => ({ confirmed: false, reasons: ['FIXTURE_WINDOW_NOT_RETAINED'] });
  r.publish = async report => { published = JSON.parse(JSON.stringify(report)); };
  await assert.rejects(runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r), /CLEANUP_UNCONFIRMED/);
  assert.deepEqual(published.rows[0].cleanupReasons, ['FIXTURE_WINDOW_NOT_RETAINED']);
  assert.equal(published.rows[0].cleanupConfirmed, false);
});
test('aggregate uses nearest-rank p90, explicit coverage and excludes failed rows', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ app: 'fixture', class: 'Office', mode: 'sequential', status: 'complete', firstReadMs: i + 1, chars: 100, nodes: 5 }));
  rows.push({ ...rows[0], status: 'failed', firstReadMs: 999 });
  const summary = summarizeSpeedMap({ rows });
  assert.equal(summary[0].completed, 10); assert.equal(summary[0].attempted, 11);
  assert.deepEqual(summary[0].firstReadMs, { n: 10, median: 5.5, p90: 9 });
  const md = speedMarkdown({ rows, summary });
  assert.match(md, /10\/11/); assert.match(md, /Office/); assert.match(md, /median/); assert.match(md, /p90/);
});

test('live setup validates local receipts and uses the launcher with a clean environment', async () => {
  const { validateSpeedReceipt, speedEnvironment, speedLauncher } = await import('../bench/app-speed-map-live.mjs');
  const task = speedPlan().apps.find(a => a.id === 'notes');
  assert.throws(() => validateSpeedReceipt(task), /LOCAL_CONTAINER/);
  assert.throws(() => validateSpeedReceipt(task, { local: false, id: 'x', marker: 'local' }), /LOCAL_CONTAINER/);
  assert.deepEqual(validateSpeedReceipt(task, { local: true, id: 'fixture-id', marker: 'AM1-local' }),
    { containerId: 'fixture-id', containerMarker: 'AM1-local' });
  const env = speedEnvironment({ PATH: '/bin', HOME: '/home/fixture', CLAUDECODE: 'private', CLAUDE_CONFIG_DIR: 'private', SECRET: 'private' });
  assert.equal(env.PATH, '/bin'); assert.equal(env.CLAUDECODE, undefined); assert.equal(env.SECRET, undefined);
  assert.equal(env.SLEIGHT_TRACE, ''); assert.equal(env.SLEIGHT_RECEIPTS, '0');
  const descriptor = speedLauncher('/repo', env);
  assert.equal(descriptor.command, '/repo/plugins/sleight/bin/sleight-mcp'); assert.equal(descriptor.inheritEnvironment, false);
});
test('session startup with unconfirmed cleanup stops the pass', async () => {
  const r = runtime(); r.openSession = async () => { throw Error('startup failed'); };
  await assert.rejects(runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r), /CLEANUP/);
  assert.equal(r.calls.filter(c => c[0] === 'prepare').length, 1);
});
test('probe client opt-out drops inherited environment without altering its default', async () => {
  const { probeEnvironment } = await import('../bench/double-keys-client.mjs');
  assert.deepEqual(probeEnvironment({ env: { CHILD: '1' } }, { PARENT: '1' }), { PARENT: '1', CHILD: '1' });
  assert.deepEqual(probeEnvironment({ inheritEnvironment: false, env: { CHILD: '1' } }, { CLAUDECODE: 'private' }), { CHILD: '1' });
});

test('uppercase exception text cannot become a published failure code', async () => {
  const r = runtime(); r.prepare = async () => { const e = Error('PRIVATE_ACCOUNT_TOKEN'); e.cleanupConfirmed = true; throw e; };
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ACCOUNT_TOKEN/);
  assert.ok(report.rows.every(row => row.failure === 'READ_FAILED'));
});
test('AM1 approval uses the requested app catalog without pretending the owner is present', () => {
  const input = { mcp_server_name:'plugin:sleight:computer', message:'Allow Computer Use to use "Spotify"?', requested_schema:{properties:{choice:{enum:['session','always','decline']}},required:['choice']} };
  const run = (message, present = '') => spawnSync(process.execPath, ['bench/approve.mjs'], {cwd:new URL('..',import.meta.url), input:JSON.stringify({...input,message}),encoding:'utf8',env:{...process.env,BENCH_SUITE:'app-speed-map',BENCH_OWNER_PRESENT:present,BENCH_HOOK_LOG:'',BENCH_ARM_SERVERS:'["plugin:sleight:computer"]'}});
  const spotify = run(input.message); assert.equal(spotify.status,0,spotify.stderr);
  assert.equal(JSON.parse(spotify.stdout).hookSpecificOutput.action,'accept');
  assert.equal(JSON.parse(spotify.stdout).hookSpecificOutput.content.choice,'session');
  assert.equal(JSON.parse(run('Allow Computer Use to use "Slack"?').stdout).hookSpecificOutput.action,'decline');
  assert.equal(JSON.parse(run('Allow Computer Use to use "Slack"?','1').stdout).hookSpecificOutput.action,'accept');
});

test('browser receipt requires explicit benchmark-profile identity before setup', async () => {
  const {validateSpeedReceipt} = await import('../bench/app-speed-map-live.mjs');
  const task = speedPlan().apps.find(a=>a.id==='helium');
  assert.throws(()=>validateSpeedReceipt(task),/BROWSER_PROFILE/);
  assert.throws(()=>validateSpeedReceipt(task,{ownerApproved:false,browserId:'1',profileName:'bench'}),/BROWSER_PROFILE/);
  assert.deepEqual(validateSpeedReceipt(task,{ownerApproved:true,browserId:'1',profileName:'bench'}),{browserId:'1',profileName:'bench'});
});

test('browser samples select only the receipted profile and close only created tab handles', async()=>{
  const r=runtime();
  const report=await runSpeedMap(speedPlan({ids:['helium'],runs:1}),r);
  assert.ok(report.rows.every(row=>row.status==='complete'));
  assert.deepEqual(r.calls.filter(c=>c[0]==='browser-scroll'),[['browser-scroll',{x:120,y:200,scrollX:0,scrollY:400}]]);
  assert.equal(r.calls.filter(c=>c[0]==='tab-close').length,5);
});

test('owner account tables stay separate and cohort lifecycle wall time has its own coverage', ()=>{
  const good={app:'fixture',class:'Office',mode:'concurrent',trial:1,status:'complete',cleanupConfirmed:true,ownerAccount:false};
  const rows=[good,{...good,trial:2,status:'failed'},{...good,app:'mail',mode:'sequential',ownerAccount:true}];
  const report={rows,cohorts:[{app:'fixture',trial:1,sessions:1,wallMs:42},{app:'fixture',trial:2,sessions:1,wallMs:999}]};
  report.summary=summarizeSpeedMap(report);
  assert.deepEqual(report.summary.find(r=>r.app==='fixture').cohortWallMs,{n:1,median:42,p90:42});
  const md=speedMarkdown(report); assert.match(md,/Owner-present reads/); assert.match(md,/Cohort lifecycle/);
  assert.ok(md.indexOf('| Office |')<md.indexOf('Owner-present reads'));
});

test('owner-present planning disables actions for every selected app', async () => {
  const plan = speedPlan({ ownerPresent: true });
  assert.ok(plan.apps.every(app => app.readOnly));
  const r = runtime();
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1, ownerPresent: true }), r);
  assert.ok(report.rows.every(row => row.status === 'complete' && row.actionMs === null));
  assert.equal(r.calls.filter(call => call[0] === 'scroll').length, 0);
});

test('a unique text view or outline is a scroll fallback, while value controls are excluded', async () => {
  for (const role of ['text area', 'outline', 'list']) {
    const app = closed({ getAXState: async () => 'Window: "fixture", App: Fixture.\n0 standard window\n\t2 ' + role });
    assert.equal((await readMetrics(app)).scrollTarget, 2);
  }
  const app = closed({ getAXState: async () => 'Window: "fixture", App: Fixture.\n0 standard window\n\t1 slider Value: 10\n\t2 stepper Value: 3' });
  assert.equal((await readMetrics(app)).scrollTarget, null);
  const ambiguous = closed({ getAXState: async () => 'Window: "fixture", App: Fixture.\n0 standard window\n\t2 text area\n\t3 outline' });
  assert.equal((await readMetrics(ambiguous)).scrollTarget, null);
});

test('away local-container cells refuse before preparation or client access even with a sidebar marker', async () => {
  for (const id of ['notes', 'calendar']) {
    const r = runtime();
    const report = await runSpeedMap(speedPlan({ ids: [id], runs: 1 }), r);
    assert.ok(report.rows.length > 0);
    assert.ok(report.rows.every(row => row.status === 'refused' && row.failure === 'LOCAL_CONTAINER_UNQUALIFIED'
      && row.scope === 'unqualified-local-container' && row.cleanupConfirmed));
    assert.ok(report.summary.every(row => row.completed === 0 && row.acquireMs.n === 0 && row.actionMs.n === 0));
    assert.deepEqual(r.calls.filter(call => call[0] !== 'publish'), []);
  }
});

test('local receipts retain exact IDs but never assert current container membership', async () => {
  const { validateSpeedReceipt } = await import('../bench/app-speed-map-live.mjs');
  for (const id of ['notes', 'calendar']) {
    const task = speedPlan({ ids: [id] }).apps[0];
    const a = validateSpeedReceipt(task, { local: true, id: 'local-A', marker: 'AM1-local' });
    const b = validateSpeedReceipt(task, { local: true, id: 'local-B', marker: 'AM1-local' });
    assert.notDeepEqual(a, b);
    assert.equal(a.containerId, 'local-A');
    assert.equal(a.requiredText, undefined);
    for (const receipt of [{ local: true, marker: 'AM1-local' }, { local: true, id: '', marker: 'AM1-local' },
      { local: false, id: 'cloud-A', marker: 'AM1-local' }, { local: true, id: 'local-A' }]) {
      assert.throws(() => validateSpeedReceipt(task, receipt), /LOCAL_CONTAINER_RECEIPT_REQUIRED/);
    }
  }
});

test('owner-present local-container reads have an explicit unbound scope and cannot send input', async () => {
  const plan = speedPlan({ ids: ['notes', 'calendar'], runs: 1, ownerPresent: true, concurrentApp: 'notes' });
  // Even a modified row cannot turn the owner-present read-only plan into input.
  plan.apps[0].readOnly = false;
  const r = runtime({ ownerPresent: true });
  const report = await runSpeedMap(plan, r);
  assert.ok(report.rows.every(row => row.status === 'complete' && row.scope === 'owner-present-read-only'
    && row.actionMs === null && row.afterReadMs === null && row.ownerAccount));
  assert.equal(r.calls.filter(call => call[0] === 'scroll').length, 0);
  assert.match(speedMarkdown(report), /Owner-present reads/);
  assert.match(speedMarkdown(report), /owner-present-read-only/);
});

test('a refused setup row carries its diagnosis into the report and the failure column', async () => {
  const r = runtime();
  r.prepare = async () => { throw Object.assign(Error('FIXTURE_SETUP_FAILED'), { cleanupConfirmed: true, cleanupReasons: ['FIXTURE_WINDOW_NOT_RETAINED'],
    setup: { message: 'APP_EXITED', stage: 'retain', windowCount: null, startWait: { exited: true, instances: 0 } } }); };
  const report = await runSpeedMap(speedPlan({ ids: ['vscode'], runs: 1 }), r);
  const row = report.rows[0];
  assert.equal(row.status, 'refused');
  assert.equal(row.failure, 'FIXTURE_SETUP_FAILED');
  assert.deepEqual(row.setup, { message: 'APP_EXITED', stage: 'retain', windowCount: null, startWait: { exited: true, instances: 0 } });
  assert.deepEqual(row.cleanupReasons, ['FIXTURE_WINDOW_NOT_RETAINED']);
  assert.deepEqual(summarizeSpeedMap(report)[0].failures, ['FIXTURE_SETUP_FAILED:APP_EXITED']);
  assert.match(speedMarkdown(report), /FIXTURE_SETUP_FAILED:APP_EXITED/);
});

test('the offline simulation runs every planned cell through the real scheduler with no app', async () => {
  const plan = speedPlan({ ids: ['vscode', 'word', 'notes'], runs: 2, concurrentApp: 'word' });
  const sim = await simulateSpeedMap(plan);
  assert.equal(sim.cells.length, 3 * 2 + 2);
  const vscode = sim.cells.filter(c => c.app === 'vscode');
  assert.deepEqual(vscode.map(c => [c.mode, c.trial, c.status]), [['sequential', 1, 'complete'], ['sequential', 2, 'complete']]);
  assert.deepEqual(vscode[0].steps, ['acquire', 'read', 'read', 'scroll', 'read']);
  const cohort = sim.cells.filter(c => c.mode === 'concurrent');
  assert.deepEqual(cohort.map(c => [c.app, c.sessions]), [['word', 4], ['word', 4]]);
  assert.deepEqual(cohort[0].steps, ['acquire', 'read', 'read']);
  assert.ok(sim.cells.filter(c => c.app === 'notes').every(c => c.status === 'refused' && c.failure === 'LOCAL_CONTAINER_UNQUALIFIED'));
  assert.equal(sim.totals.fixtures, 2 * 2 + 2);
  assert.equal(sim.totals.scrolls, 4);
  assert.equal(sim.totals.engineCalls, 4 * 8 + 2 * 4 * 5);
  assert.ok(sim.estimate.typicalSeconds > 0 && sim.estimate.boundSeconds > sim.estimate.typicalSeconds);
  assert.equal(sim.liveCommand, 'node bench/app-speed-map.mjs --owner-away --apps vscode,word,notes --runs 2 --concurrent-app word');
  assert.deepEqual(sim.receiptsRequired, []);
  assert.deepEqual((await simulateSpeedMap(speedPlan({ ids: ['helium', 'textedit'], runs: 1 }))).receiptsRequired, ['helium']);
});

test('the CLI dry run includes the simulation and never spawns a child or writes a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-am1-dry-')), guard = join(dir, 'guard.cjs');
  try {
    writeFileSync(guard, `const cp = require('node:child_process'), fs = require('node:fs');
      for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name] = () => { throw Error('child forbidden'); };
      for (const name of ['mkdirSync','writeFileSync','appendFileSync','rmdirSync','rmSync','unlinkSync','mkdtempSync']) fs[name] = () => { throw Error('write forbidden'); };
      require('node:module').syncBuiltinESMExports();`);
    const r = spawnSync(process.execPath, ['--require', guard, 'bench/app-speed-map.mjs', '--dry-run', '--apps', 'vscode,word', '--runs', '1'],
      { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.runs, 1);
    assert.equal(out.simulation.cells.length, 3);
    assert.equal(out.simulation.liveCommand, 'node bench/app-speed-map.mjs --owner-away --apps vscode,word --runs 1');
  } finally { removeTemp(dir); }
});

test('each measured row records the fixture setup wait, and the summary reports it', async () => {
  const r = runtime(), prepare = r.prepare;
  r.prepare = async (...args) => ({ ...(await prepare(...args)), setupWaitMs: 4200 });
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  assert.ok(report.rows.length && report.rows.every(row => row.setupWaitMs === 4200));
  assert.deepEqual(report.summary.find(row => row.mode === 'sequential').setupWaitMs, { n: 1, median: 4200, p90: 4200 });
});

test('classified attention reaches each row, the summary and the table; a stop keeps the session failure underneath', async () => {
  const launched = runtime();
  launched.closeFixture = async () => ({ confirmed: true, focusChanged: false, attention: [{ phase: 'setup', hostStage: 'retain', atMs: 900,
    kind: 'focus', from: 'org.example.owner', to: 'com.microsoft.Word', class: 'launch-activation' }] });
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), launched);
  assert.ok(report.rows.every(row => row.attention?.[0]?.class === 'launch-activation'));
  assert.ok(report.rows.every(row => row.status === 'complete'));
  assert.deepEqual(report.summary.find(row => row.mode === 'sequential').attention, { 'launch-activation': 1 });
  assert.match(speedMarkdown(report), /\| Attention \|/);
  assert.match(speedMarkdown(report), /launch-activation 1/);
  const stopped = runtime({ held: false });
  stopped.closeFixture = async () => ({ confirmed: true, focusChanged: true, attention: [{ phase: 'measure', kind: 'focus', class: 'focus-change' }] });
  // Live 04:41Z: the session opened, then the first timed call's boundary found the latch (acquireMs null, cleanup confirmed).
  let heldNow = false; const open = stopped.openSession;
  stopped.held = () => heldNow;
  stopped.openSession = async (...args) => { const session = await open(...args); heldNow = true; return session; };
  let published; stopped.publish = async report => { published = structuredClone(report); };
  await assert.rejects(runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), stopped), /FOCUS_CHANGED/);
  const row = published.rows[0];
  assert.equal(row.status, 'unsafe');
  assert.equal(row.failure, 'FOCUS_CHANGED');
  assert.equal(row.sessionFailure, 'HOLD');
  assert.equal(row.attention[0].class, 'focus-change');
});

// AM1 qualification 2 (2026-10-19 08:45Z): Word's warm read had 120 nodes and no unique scroll area.
const wordTree = 'Window: "AM1-fixture.docx", App: Microsoft Word.\n0 standard window AM1-fixture.docx\n\t1 scroll area Ribbon\n\t\t2 tab group\n' +
  '\t3 scroll area\n\t\t4 layout area\n\t\t\t5 text entry area (settable) Description: Page 1 content, Value: AM1-fixture PENDING\n\t6 scroll area Navigation';
test('a document fixture picks the scroll area around its own text among several', async () => {
  const app = closed({ getAXState: async () => wordTree });
  const found = await readMetrics(app, { marker: 'AM1-fixture', scrollMarker: 'AM1-fixture' });
  assert.equal(found.scrollTarget, 3);
  assert.deepEqual(found.shape, { scrollAreas: 3, fallbackTargets: 0, markerRows: 2, markerScrollAreas: 1, scrollDepths: [1, 1, 1],
    markerRegions: 0, tier: 1, targetRole: 'scroll area', roles: { 'scroll area': 3, 'layout area': 1, 'text entry area': 1, 'tab group': 1, 'standard window': 1 } });
  const blind = await readMetrics(app, { marker: 'AM1-fixture' });
  assert.equal(blind.scrollTarget, null);
  assert.equal(blind.shape.scrollAreas, 3);
  assert.doesNotMatch(JSON.stringify(found.shape) + JSON.stringify(blind.shape), /AM1|Ribbon|Page/);
});

test('each sequential row keeps the warm read shape and the cleanup window codes', async () => {
  const r = runtime();
  r.closeFixture = async () => ({ confirmed: false, focusChanged: false, reasons: ['WINDOW_NOT_RETAINED'],
    windows: [{ retained: false, present: true, matched: false, documentStatus: -25204, sheetStatus: -25204, reasons: ['WINDOW_NOT_RETAINED'] }] });
  let published; r.publish = async report => { published = structuredClone(report); };
  await assert.rejects(runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r), /CLEANUP_UNCONFIRMED/);
  const row = published.rows[0];
  assert.deepEqual(row.treeShape, { scrollAreas: 1, fallbackTargets: 0, markerRows: 0, markerScrollAreas: 0, scrollDepths: [1],
    markerRegions: 0, tier: 0, targetRole: 'scroll area', roles: { 'scroll area': 1, 'static text': 1, 'standard window': 1 } });
  assert.deepEqual(row.cleanupWindows, [{ retained: false, present: true, matched: false, documentStatus: -25204, sheetStatus: -25204, reasons: ['WINDOW_NOT_RETAINED'] }]);
});

// AM1 full map (2026-10-19 08:57Z): Excel 0/10 (1 scroll area, 3 marker rows, none inside it) and Cursor 0/10 (no scroll
// area, list or marker row in 104 nodes) failed NO_UNIQUE_SCROLL_AREA; VS Code passed through its explorer list.
const excelTree = 'Window: "AM1-fixture.xlsx", App: Microsoft Excel.\n0 standard window AM1-fixture.xlsx\n\t1 scroll area Ribbon\n\t\t2 button Home\n' +
  '\t3 group Formula Bar\n\t\t4 text entry area Value: AM1-fixture PENDING\n\t5 layout area Content Area, Description: Workbook area\n' +
  '\t\t6 table Sheet1\n\t\t\t7 row\n\t\t\t\t8 cell A1, Value: AM1-fixture PENDING\n\t\t\t9 row\n\t\t\t\t10 cell A2';
test('a sheet scrolls the table around its own cell when no scroll area holds the marker', async () => {
  const found = await readMetrics(closed({ getAXState: async () => excelTree }), { marker: 'AM1-fixture', scrollMarker: 'AM1-fixture' });
  assert.equal(found.scrollTarget, 6);
  assert.equal(found.shape.tier, 2);
  assert.equal(found.shape.markerRegions, 1, 'the formula bar field showing the cell is not a region');
  assert.equal(found.shape.roles.table, 1);
});

const agentTree = 'Window: "AM1-fixture", App: Cursor.\n0 standard window AM1-fixture\n\t1 web area\n\t\t2 group\n\t\t\t3 button Agents\n' +
  '\t\t4 group\n\t\t\t5 text entry area (settable) Placeholder: Ask\n\t\t\t6 static text Plan, search, build anything';
test('only the run\'s own editor instance falls back to its largest scrollable region when no region holds the marker', async () => {
  const app = closed({ getAXState: async () => agentTree });
  const blind = await readMetrics(app, { marker: 'AM1-fixture', scrollMarker: 'AM1-fixture-row' });
  assert.equal(blind.scrollTarget, null);
  assert.equal(blind.shape.markerRows, 0);
  const owned = await readMetrics(app, { marker: 'AM1-fixture', scrollMarker: 'AM1-fixture-row', anyRegion: true });
  assert.equal(owned.scrollTarget, 5);
  assert.equal(owned.shape.tier, 3);
  assert.equal(owned.shape.roles['web area'], 1);
  assert.doesNotMatch(JSON.stringify(owned.shape), /Ask|Agents|Plan/);
});

// Excel rerun (2026-10-19 09:31Z): 8/10 sequential cells failed ENGINE_CALL_FAILED at the scroll. Excel's tree exposes no
// cells: the marker shows only in the formula bar field, which tier 2 picked as the scroll target.
const excelLive = 'Window: "AM1-fixture.xlsx", App: Microsoft Excel.\n0 standard window AM1-fixture.xlsx\n\t1 scroll area Ribbon\n\t\t2 button Home\n' +
  '\t3 toolbar\n\t\t4 text entry area Description: Formula Bar, Value: AM1-fixture PENDING\n\t5 layout area Content Area, Description: Workbook area, Sheet1\n' +
  '\t6 tab group\n\t\t7 radio button Sheet1';
test('when only a field shows the fixture text, the document canvas (layout area) takes the scroll', async () => {
  const found = await readMetrics(closed({ getAXState: async () => excelLive }), { marker: 'AM1-fixture', scrollMarker: 'AM1-fixture' });
  assert.equal(found.scrollTarget, 5);
  assert.equal(found.shape.tier, 4);
  assert.equal(found.shape.targetRole, 'layout area');
  assert.equal(found.shape.markerRegions, 0);
});

test('a failed engine call records its step and only AX codes and fixed error kinds', async () => {
  const r = runtime(), open = r.openSession, logged = [];
  r.log = line => logged.push(line);
  r.openSession = async (...args) => {
    const session = await open(...args);
    return { ...session, js: async code => /\.scroll\(/.test(code)
      ? { isError: true, content: [{ type: 'text', text: 'AX error -25205: element is not scrollable (private label)' }] } : session.js(code) };
  };
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  const row = report.rows.find(item => item.mode === 'sequential');
  assert.equal(row.failure, 'ENGINE_CALL_FAILED');
  assert.equal(row.failedStep, 'action');
  assert.deepEqual({ ...row.engineError, signature: undefined }, { codes: [-25205], kinds: ['not scrollable'], signature: undefined });
  assert.match(row.engineError.signature, /^[0-9a-f]{8}$/);
  assert.deepEqual(logged, ['AM1_ENGINE_ERROR textedit action ax error _n_: element is not scrollable (private label)']);
  assert.ok(Number.isFinite(row.warmReadMs) && row.actionMs === null);
  assert.deepEqual(report.summary.find(item => item.mode === 'sequential').failures, ['ENGINE_CALL_FAILED:action']);
  assert.doesNotMatch(JSON.stringify(report), /private label/);
});

// Excel-only run (2026-10-19 09:44Z): the canvas scroll failed 10/10 (no AX code, no known kind in the engine's text).
test('a document whose text the tree does not show is measured with a Page Down key, labelled as a key action', async () => {
  const r = runtime({ canvas: true });
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  const row = report.rows.find(item => item.mode === 'sequential');
  assert.equal(row.status, 'complete', JSON.stringify(row));
  assert.equal(row.actionKind, 'key');
  assert.equal(row.treeShape.tier, 4);
  assert.deepEqual(r.calls.filter(call => call[0] === 'key'), [['key', 'Page_Down']]);
  assert.equal(r.calls.filter(call => call[0] === 'scroll').length, 0);
  assert.ok(Number.isFinite(row.actionMs) && Number.isFinite(row.afterReadMs));
  assert.deepEqual(report.summary.find(item => item.mode === 'sequential').actionKinds, ['key']);
  assert.match(speedMarkdown(report), /\(key\)/);
  const scrolled = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), runtime());
  assert.equal(scrolled.rows.find(item => item.mode === 'sequential').actionKind, 'scroll');
});

test('an engine error keeps a local template without quoted values, paths or numbers, and publishes only its hash', () => {
  const reply = { isError: true, content: [{ type: 'text', text: `Timed out after 30 s waiting for "Microsoft Excel" at ${MAC_USERS}x/AM1.xlsx (lease 4)\nsecond line` }] };
  const error = engineError(reply);
  assert.equal(error.template, 'timed out after _n_ s waiting for _q_ at _p_ (lease _n_) / second line');
  assert.deepEqual(error.published, { codes: [], kinds: ['timed out', 'lease'], signature: error.published.signature });
  assert.match(error.published.signature, /^[0-9a-f]{8}$/);
  assert.equal(engineError({ content: [{ type: 'text', text: 'Timed out after 9 s waiting for "Word" at /tmp/y (lease 1)\nsecond line' }] }).published.signature,
    error.published.signature, 'the same template hashes the same');
});

test('acquisition retries only an engine that says it is busy, at most twice, and counts the retries', async () => {
  for (const [text, failures, expected] of [['AX error -25204: cannot complete', 2, { retries: 2, status: 'complete' }],
    ['AX error -25204: cannot complete', 3, { retries: 2, status: 'failed' }], ['Lease refused', 1, { retries: 0, status: 'failed' }]]) {
    const r = runtime(), open = r.openSession; let left = failures;
    r.sleep = async () => {};
    r.openSession = async (...args) => {
      const session = await open(...args);
      return { ...session, js: async code => /getApp/.test(code) && left-- > 0 ? { isError: true, content: [{ type: 'text', text }] } : session.js(code) };
    };
    const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
    const row = report.rows.find(item => item.mode === 'sequential');
    assert.equal(row.acquireRetries, expected.retries, text);
    assert.equal(row.status, expected.status, text);
  }
});

test('the logged template keeps the first lines of an error and treats apostrophes inside words as text', () => {
  const reply = { isError: true, content: [{ type: 'text', text: 'Computer Use\n\nCouldn\'t acquire "Microsoft Excel": the app\'s lease timed out after 30 s.\nRetry later.\nfourth line' }] };
  assert.equal(engineError(reply).template, "computer use / couldn't acquire _q_: the app's lease timed out after _n_ s. / retry later.");
});

// Excel rerun (2026-10-19 09:55Z): all 11 acquire failures logged "computer use" and the kinds timeout, unsupported, lease
// and approval. Both came from the engine docs ahead of the error. The helper had crashed (SIGSEGV crash reports).
test('an engine error skips the engine docs and the relay notices, and names a helper crash', () => {
  const docs = '## Computer Use\n\nControl apps. A timeout, an unsupported call, a lease or an approval can stop a call.\n\n## API\n';
  const policy = '# Computer Use Confirmations Policy\nAsk for approval before risky actions.';
  const notice = "sleight: the engine's helper (SkyComputerUseService) crashed during this call; a read alone is safe to repeat.";
  const reply = { isError: true, content: [{ type: 'text', text: docs }, { type: 'text', text: policy },
    { type: 'text', text: 'Error: Sky Computer Use native pipe closed before response' }, { type: 'text', text: notice }] };
  const error = engineError(reply);
  assert.equal(error.template, 'error: sky computer use native pipe closed before response');
  assert.deepEqual(error.published, { codes: [], kinds: [], signature: error.published.signature, helper: 'crash' });
  // Docs that share an item with the error are cut at their heading.
  assert.equal(engineError({ isError: true, content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed\n' + docs }] }).published.helper, 'start');
  assert.equal(engineError({ isError: true, content: [{ type: 'text', text: 'Sky Computer Use service startup request failed' }] }).published.helper, 'start');
  // An ordinary engine error has no helper field.
  assert.equal('helper' in engineError({ isError: true, content: [{ type: 'text', text: 'AX error -25205' }] }).published, false);
  // Docs alone leave an empty template, never the docs' heading.
  assert.equal(engineError({ isError: true, content: [{ type: 'text', text: docs }] }).template, '');
});

test('a helper crash at acquisition is published as ENGINE_CALL_FAILED:acquire:helper-crash', async () => {
  const r = runtime(), open = r.openSession;
  r.openSession = async (...args) => {
    const session = await open(...args);
    return { ...session, js: async code => /getApp/.test(code) ? { isError: true, content: [{ type: 'text', text: '## Computer Use\nDocs.\n' },
      { type: 'text', text: 'Sky Computer Use native pipe closed before response' }] } : session.js(code) };
  };
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  const row = report.rows.find(item => item.mode === 'sequential');
  assert.equal(row.acquireRetries, 0, 'a crash is not a busy answer: the relay already retried it once');
  assert.equal(row.engineError.helper, 'crash');
  assert.deepEqual(report.summary.find(item => item.mode === 'sequential').failures, ['ENGINE_CALL_FAILED:acquire:helper-crash']);
});

// Excel rerun (2026-10-19 09:55Z): 10 helper crash reports in 10 cohorts, 3 of them cohorts with no failed session.
test('a cell counts the helper crash reports it added, once per fixture, and the map names them', async () => {
  const r = runtime(); let reports = 0, cell = 0;
  r.helperCrashMark = () => reports;
  r.helperCrashesSince = mark => reports - mark;
  const open = r.openSession;
  r.openSession = async (...args) => { const session = await open(...args); return { ...session, js: async code => {
    // The first fixture's acquisition sees one crash (the relay's resend succeeded); the cohort sees two.
    if (/getApp/.test(code)) reports += ++cell === 1 ? 1 : cell === 2 ? 2 : 0;
    return session.js(code);
  } }; };
  const report = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  const sequential = report.rows.filter(row => row.mode === 'sequential'), concurrent = report.rows.filter(row => row.mode === 'concurrent');
  assert.equal(sequential[0].helperCrashes, 1);
  assert.ok(concurrent.every(row => row.helperCrashes === 2));
  assert.equal(report.cohorts[0].helperCrashes, concurrent[0].helperCrashes);
  const summary = Object.fromEntries(report.summary.map(item => [item.mode, item.helperCrashes]));
  assert.equal(summary.sequential, 1);
  assert.equal(summary.concurrent, 2, 'one count per cohort, not per session');
  assert.match(speedMarkdown(report), /Engine helper crash reports written during the cells \(SkyComputerUseService, any client\): .*textedit concurrent 2, textedit sequential 1|textedit sequential 1, textedit concurrent 2/);
});

test('a runtime without crash reports, or one whose read throws, leaves the count out', async () => {
  const plain = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), runtime());
  assert.ok(plain.rows.every(row => !('helperCrashes' in row)));
  assert.ok(plain.summary.every(item => item.helperCrashes === null));
  assert.doesNotMatch(speedMarkdown(plain), /crash reports/);
  const r = runtime(); r.helperCrashMark = () => { throw Error('EPERM'); }; r.helperCrashesSince = () => 0;
  const failed = await runSpeedMap(speedPlan({ ids: ['textedit'], runs: 1 }), r);
  assert.ok(failed.rows.every(row => !('helperCrashes' in row)));
  assert.ok(failed.rows.some(row => row.status === 'complete'));
});

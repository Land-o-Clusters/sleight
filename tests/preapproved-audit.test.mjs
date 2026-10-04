import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrantAudit } from '../plugins/sleight/lib/preapproved-audit.mjs';
import { approvalLogging } from '../plugins/sleight/lib/launch.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const grant = { app: 'com.apple.calculator', riskLevel: 'low', tool: 'engine',
  source: '~/Library/Application Support/sleight/preapproved.json' };
const name = `preapproved-${process.pid}.jsonl`;
function bank(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'sleight-grant-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('nonempty list logs grants privately without enabling full traffic tracing', t => {
  const dir = bank(t), list = new PreapprovedApps({ version: 1, apps: [{ app: grant.app, riskLevel: grant.riskLevel }] });
  const logging = approvalLogging(list, {}, dir);
  assert.equal(logging.trace, undefined);
  logging.grantAudit({ ...grant, document: 'PRIVATE DOCUMENT', message: 'RPC TRAFFIC' });
  const file = join(dir, name), raw = fs.readFileSync(file, 'utf8');
  const record = JSON.parse(raw);
  assert.deepEqual(record.grant, grant);
  assert.equal(record.direction, 'preapproved-app');
  assert.ok(record.t);
  assert.doesNotMatch(raw, /PRIVATE DOCUMENT|RPC TRAFFIC/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [name]);
});
test('grant log rotates at 64 KiB and keeps one prior file', t => {
  const dir = bank(t), audit = createGrantAudit(dir);
  for (let i = 0; i < 900; i++) audit(grant);
  assert.deepEqual(fs.readdirSync(dir).sort(), [name, name + '.1']);
  for (const name of fs.readdirSync(dir)) {
    assert.ok(fs.statSync(join(dir, name)).size <= 64 * 1024);
    for (const line of fs.readFileSync(join(dir, name), 'utf8').trim().split('\n')) assert.deepEqual(JSON.parse(line).grant, grant);
  }
  assert.throws(() => audit({ ...grant, app: 'x'.repeat(64 * 1024) }), /too large/);
});
test('failed audit write throws to the approval path', t => {
  const dir = bank(t), path = join(dir, 'not-a-directory'); fs.writeFileSync(path, 'x');
  assert.throws(() => createGrantAudit(path)(grant));
});
test('grant audit refuses a public log, a symlink and a nonregular target', t => {
  const dir = bank(t), file = join(dir, name), audit = createGrantAudit(dir);
  fs.writeFileSync(file, 'private', { mode: 0o600 }); fs.chmodSync(file, 0o644);
  assert.throws(() => audit(grant), /private user file/);
  fs.unlinkSync(file);
  const target = join(dir, 'target'); fs.writeFileSync(target, 'unchanged', { mode: 0o600 });
  fs.symlinkSync(target, file); assert.throws(() => audit(grant));
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
  fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => audit(grant));
});
test('empty list creates no audit, and explicit tracing remains opt-in', t => {
  const dir = bank(t);
  assert.equal(approvalLogging({ size: 0 }, {}, dir).grantAudit, undefined);
  assert.deepEqual(fs.readdirSync(dir), []);
  const logging = approvalLogging({ size: 1 }, { SLEIGHT_TRACE: dir }, dir);
  logging.trace('to-client', { document: 'explicit debug text' });
  logging.grantAudit(grant);
  const raw = fs.readFileSync(join(dir, `trace-${process.pid}.jsonl`), 'utf8');
  assert.match(raw, /explicit debug text/);
  assert.doesNotMatch(fs.readFileSync(join(dir, name), 'utf8'), /explicit debug text/);
});
test('concurrent relay processes rotate their own logs without replacing another audit', async t => {
  const dir = bank(t);
  const module = new URL('../plugins/sleight/lib/preapproved-audit.mjs', import.meta.url).href;
  const code = `import {createGrantAudit} from ${JSON.stringify(module)};
    const audit=createGrantAudit(process.argv[1]);
    for(let i=0;i<900;i++)audit({app:'Calculator-'+i,riskLevel:'low',tool:'engine',source:'user-list'});
    console.log(process.pid);`;
  const settled = await Promise.allSettled(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', code, dir], { timeout: 5000 })));
  for (const result of settled) assert.equal(result.status, 'fulfilled', result.reason?.message);
  const results = settled.map(result => result.value);
  const pids = results.map(result => Number(result.stdout.trim()));
  assert.equal(fs.readdirSync(dir).length, 8);
  for (const pid of pids) {
    const current = join(dir, `preapproved-${pid}.jsonl`);
    const records = fs.readFileSync(current, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).grant.app, 'Calculator-899');
    for (const file of [current, current + '.1']) {
      assert.ok(fs.statSync(file).size <= 64 * 1024);
      for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) assert.equal(JSON.parse(line).pid, pid);
    }
  }
});

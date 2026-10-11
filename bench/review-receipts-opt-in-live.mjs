// One background Calculator turn per setting. No input or app-dialog answers.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { reliabilityClient } from './reliability-client.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { executeRealTask, acquireFixture } from './real-run.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { observePermission } from './real-permission.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { receiptOptions } from '../plugins/sleight/lib/launch.mjs';
import { writeReceipt } from '../plugins/sleight/lib/turn-receipts.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const report = { at: new Date().toISOString(), kind: 'receipt opt-in Calculator checks', cases: [] };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const checkHold = () => {
  controller.signal.throwIfAborted();
  if (existsSync('/tmp/sleight-hold')) throw new Error('Live checks held by /tmp/sleight-hold');
};
const directory = join(homedir(), 'Library', 'Logs', 'sleight', 'receipts');
const files = () => existsSync(directory) ? readdirSync(directory) : [];
let release, acquired = false, safeToRelease = true;
const oldReceipts = process.env.SLEIGHT_RECEIPTS;
const oldReview = process.env.SLEIGHT_STATE_REVIEW;
try {
  checkHold(); release = await acquireLiveLock(); acquired = true;
  const ctx = { dir: trackTemp(mkdtempSync('/private/tmp/sleight-receipts-opt-in-')), nonce: randomUUID(), ownerAway: false };
  safeToRelease = false;
  const task = {
    setup: async () => { checkHold(); await acquireFixture(ctx, 'calculator', () => openFixture(ctx, {
      app: 'Calculator', bundle: 'com.apple.calculator', target: '', mode: 'inherit', refuseDialogs: true,
    })); },
    prompt: () => 'Read background Calculator once with receipts enabled and once with the setting absent.',
    check: () => report.cases.length === 2 && report.cases.every(item => Object.values(item.checks).every(Boolean)) || 'Calculator receipt assertion failed',
    cleanup: closeFixtures,
  };
  report.result = await executeRealTask(task, ctx, { lockHeld: true, signal: controller.signal,
    stop: () => controller.abort(), permissionCheck: async () => { checkHold(); return observePermission(); },
    drive: async () => {
      let code = 0, groupClean = true;
      for (const enabled of [true, false]) {
        checkHold();
        if (enabled) process.env.SLEIGHT_RECEIPTS = '1'; else delete process.env.SLEIGHT_RECEIPTS;
        delete process.env.SLEIGHT_STATE_REVIEW;
        const item = { enabled, environment: enabled ? 'SLEIGHT_RECEIPTS=1' : 'SLEIGHT_RECEIPTS absent', engineCalls: [], checks: {}, receipts: [] };
        report.cases.push(item);
        const before = new Set(files()); let client, collected = false;
        try {
          client = await reliabilityClient(event => {
            if (event.engineCollected) { collected = true; item.engineExit = event.exit; }
            if (event.direction === 'to-server' && event.msg?.method === 'tools/call') item.engineCalls.push(event.msg.params.name);
          }, { ...receiptOptions(), inputLease: new InputLease(), stderr: { write() {} },
            receiptWriter: receipt => {
              const path = writeReceipt(receipt); item.receipts.push({ path, receipt, mode: statSync(path).mode & 0o777 }); return path;
            }, ask: async message => {
              if (!/"(?:Calculator|com\.apple\.calculator)"/.test(message)) throw new Error('Unexpected approval; no answer sent');
              return 'accept';
            } });
          item.engine = client.version;
          checkHold(); const docs = await client.js('await cua.rewriteDocumentation()');
          if (docs.isError) throw new Error('Documentation failed; raw response omitted');
          checkHold(); const result = await client.js('var receiptCalculator = await cua.getApp("com.apple.calculator")');
          const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          item.checks.calculatorHeader = !result.isError && windowFromText(text)?.app === 'Calculator';
          checkHold(); const ended = await client.tool('turn_ended', {});
          const added = files().filter(file => !before.has(file));
          item.checks.fileCount = added.length === (enabled ? 1 : 0) && item.receipts.length === (enabled ? 1 : 0);
          item.checks.metadata = enabled ? ended._meta?.['sleight/receipt']?.path === item.receipts[0]?.path : !ended._meta?.['sleight/receipt'];
          if (enabled) {
            const saved = JSON.parse(readFileSync(item.receipts[0].path, 'utf8'));
            item.checks.privateFile = item.receipts[0].mode === 0o600;
            item.checks.titleHidden = saved.calls.some(call => call.app === 'Calculator' && call.window?.redacted === true);
          }
        } catch (error) { code = 1; item.failure = error.message; }
        finally { if (client) { try { await client.close(); } catch (error) { item.collectionFailure = error.message; } } }
        item.checks.engineCollected = collected; groupClean &&= collected;
        if (!collected) break;
      }
      return { code, groupClean };
    } });
  safeToRelease = (!existsSync(ctx.dir) && report.result.groupClean !== false && !report.result.cleanupError && !report.result.cleanupUnconfirmed) ||
    (!ctx.windowLeases?.length && !ctx.pendingAcquisitions?.size && report.cases.length === 0);
  report.cleanupConfirmed = safeToRelease;
} catch (error) { report.failure = error.message; report.result ??= { passed: false }; }
finally {
  if (oldReceipts === undefined) delete process.env.SLEIGHT_RECEIPTS; else process.env.SLEIGHT_RECEIPTS = oldReceipts;
  if (oldReview === undefined) delete process.env.SLEIGHT_STATE_REVIEW; else process.env.SLEIGHT_STATE_REVIEW = oldReview;
  if (acquired && safeToRelease) { try { await release(); } catch (error) { report.lockReleaseFailure = error.message; report.result.passed = false; } }
  else if (acquired) report.lockRetained = true;
}
let clean = JSON.stringify(report, null, 2).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]');
try { const full = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (full) clean = clean.replaceAll(full, '[owner]'); } catch {}
const path = `/private/tmp/sleight-receipts-opt-in-${randomUUID()}.json`;
writeFileSync(path, clean + '\n', { mode: 0o600, flag: 'wx' });
console.log(clean); console.log(`Evidence: ${path}`);
process.exitCode = report.result?.passed && !report.lockRetained ? 0 : 1;

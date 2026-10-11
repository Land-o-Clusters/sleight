// Affected-task check only: background Calculator read and a temporary TextEdit edit.
// Uses retained AX fixture references; never answers app or macOS dialogs.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reliabilityClient } from './reliability-client.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { executeRealTask, acquireFixture } from './real-run.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { observePermission } from './real-permission.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { writeReceipt } from '../plugins/sleight/lib/turn-receipts.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const report = { at: new Date().toISOString(), kind: 'review-receipts-live', engineCalls: [], receipts: [], checks: {} };
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const textOf = result => (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const token = randomUUID().slice(0, 8), baseline = `Receipt baseline ${token}`, input = `Private receipt input ${token}`;
const checkHold = () => {
  controller.signal.throwIfAborted();
  if (existsSync('/tmp/sleight-hold')) throw new Error('Live checks held by /tmp/sleight-hold');
};
let release;
try {
  checkHold();
  release = await acquireLiveLock();
  const ctx = { dir: trackTemp(mkdtempSync('/private/tmp/sleight-receipts-live-')), nonce: token, ownerAway: false };
  ctx.document = join(ctx.dir, `Receipt-${token}.txt`);
  const task = {
    setup: async () => {
      writeFileSync(ctx.document, baseline, { mode: 0o600, flag: 'wx' });
      checkHold();
      await acquireFixture(ctx, 'textedit', () => openFixture(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit',
        target: ctx.document, token: basename(ctx.document), mode: 'document', refuseDialogs: true }));
      checkHold();
      await acquireFixture(ctx, 'calculator', () => openFixture(ctx, { app: 'Calculator', bundle: 'com.apple.calculator',
        target: '', mode: 'inherit', refuseDialogs: true }));
    },
    prompt: () => 'Read Calculator, edit only the temporary TextEdit document, inspect the receipt and restore the fixture.',
    check: () => Object.values(report.checks).every(value => value === true) || 'A receipt or fixture assertion failed',
    cleanup: closeFixtures,
  };
  report.result = await executeRealTask(task, ctx, { lockHeld: true, signal: controller.signal,
    stop: () => controller.abort(), permissionCheck: async () => { checkHold(); return observePermission(); },
    drive: async () => {
      let client, collected = false, code = 0;
      try {
        client = await reliabilityClient(event => {
          if (event.engineCollected) { collected = true; report.engineExit = event.exit; }
          if (event.direction === 'to-server' && event.msg?.method === 'tools/call') report.engineCalls.push(event.msg.params.name);
        }, { receipts: true, stateReview: true, inputLease: new InputLease(), stderr: { write() {} },
          receiptWriter: receipt => { const path = writeReceipt(receipt); report.receipts.push({ path, receipt, mode: statSync(path).mode & 0o777 }); return path; },
          ask: async message => {
            if (!/"(?:Calculator|TextEdit|com\.apple\.(?:calculator|TextEdit))"/.test(message)) throw new Error('Unexpected approval; no answer sent');
            return 'accept';
          } });
        report.engine = client.version;
        const js = async source => {
          checkHold();
          const response = await client.js(source);
          if (response.isError) throw new Error('Engine call failed; raw response omitted');
          return response;
        };
        await js('await cua.rewriteDocumentation()');
        const calculator = await js('var receiptCalc = await cua.getApp("com.apple.calculator")');
        report.checks.calculatorHeader = windowFromText(textOf(calculator))?.app === 'Calculator';
        const before = await js('var receiptText = await cua.getApp("com.apple.TextEdit")');
        const window = windowFromText(textOf(before));
        if (!window?.url || decodeURIComponent(new URL(window.url).pathname) !== ctx.document) throw new Error('Temporary TextEdit document identity unconfirmed');
        report.checks.fixtureIdentity = true;
        const changed = await js(`await receiptText.pressKey("super+a"); await receiptText.typeText(${JSON.stringify(input)}); await receiptText.getAXState({disableDiffing:true})`);
        report.checks.inputObserved = textOf(changed).includes(input);
        const ended = await client.tool('turn_ended', {});
        const latest = report.receipts.at(-1);
        if (!latest) throw new Error('No receipt was written');
        const saved = readFileSync(latest.path, 'utf8');
        report.checks.privateFile = latest.mode === 0o600;
        report.checks.receiptInputRedacted = !saved.includes(input) && !saved.includes(baseline);
        report.checks.inputLength = latest.receipt.calls.some(call => call.actions.some(action => action.input?.length === input.length));
        report.checks.changedWindow = latest.receipt.windows.some(item => item.app === 'TextEdit' && item.change === 'changed');
        report.checks.paneMetadata = ended._meta?.['sleight/receipt']?.path === latest.path;
        // Read the exact fixture again before its restoration in the next turn.
        const restore = await js('await receiptText.getAXState({disableDiffing:true})');
        if (!textOf(restore).includes(input) || windowFromText(textOf(restore))?.url !== window.url) throw new Error('Fixture changed before restoration; leave it untouched');
        const undone = await js('await receiptText.pressKey("super+z"); await receiptText.getAXState({disableDiffing:true})');
        report.checks.restoredBuffer = textOf(undone).includes(baseline) && !textOf(undone).includes(input);
        await client.tool('turn_ended', {});
      } catch (error) { code = 1; report.driverFailure = error.message; }
      finally {
        if (client) { try { await client.close(); } catch (error) { report.collectionFailure = error.message; } }
      }
      return { code, groupClean: collected };
    } });
} catch (error) { report.result = { passed: false, reason: error.message }; }
finally {
  try { await release?.(); }
  catch (error) { report.lockReleaseFailure = error.message; report.result.passed = false; }
}
const scrub = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'window' && typeof item === 'string' ? '[redacted window]' :
  key === 'review' && typeof item === 'string' ? '[review retained in private receipt]' : item).replaceAll(homedir(), '~').replaceAll(userInfo().username, '[owner]')
  .replaceAll(input, `[redacted ${input.length} chars]`).replaceAll(baseline, `[redacted ${baseline.length} chars]`));
const safe = scrub(report);
const output = `/private/tmp/sleight-review-receipts-${Date.now()}.json`;
writeFileSync(output, JSON.stringify(safe, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output, ...safe }, null, 2));
if (!report.result?.passed) process.exitCode = 1;

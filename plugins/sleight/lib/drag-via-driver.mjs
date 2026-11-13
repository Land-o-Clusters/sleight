import { macIdentityError } from './repl/identity-steps.mjs';
// RT12's local-tool runner seam for RT8. The stepped drag remains in drag.js;
// the driver's instant pointer primitive must not replace its text transaction.
// Approval, the app lease and retained read bindings belong to the parent.
import { MAC_DRIVER_ERRORS, formatMacDriverError } from './mac-driver/errors.mjs';
import { execFile } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dragScript = new URL('./drag.js', import.meta.url);

// Appended to the unchanged script only for this runtime runner. These checks
// use drag.js's actual app and window selectors inside the input-owning child.
function installDragGuards(source, destination, refusal, stopPath) {
  if (stopPath) dragStopChannel = function () {
    if ($.NSFileManager.defaultManager.fileExistsAtPath($(stopPath)))
      throw Object.assign(new Error('USER_STOPPED'), { code: 'USER_STOPPED' });
  };
  if (stopPath) {
    const holds = new Map();
    dragHeldInput = function (event, pid, posted) {
      if (pid !== undefined && pid !== source.pid) throw new Error(refusal);
      const type = Number($.CGEventGetType(event));
      const key = [10, 11, 12].includes(type) ? Number($.CGEventGetIntegerValueField(event, 9)) : undefined;
      const modifierMask = { 54: 1 << 20, 55: 1 << 20, 56: 1 << 17, 57: 1 << 16, 58: 1 << 19, 59: 1 << 18, 60: 1 << 17, 61: 1 << 19, 62: 1 << 18, 63: 1 << 23 }[key] ?? 0;
      const modifierDown = type === 12 && (Number($.CGEventGetFlags(event)) & modifierMask) !== 0;
      const button = [1, 2, 3, 4, 6, 7, 25, 26, 27].includes(type) ? Number($.CGEventGetIntegerValueField(event, 3)) : undefined;
      const id = key !== undefined ? 'key:' + key : button !== undefined ? 'button:' + button : undefined;
      if (id === undefined) return;
      if (([1, 3, 25, 10].includes(type) || modifierDown) && !posted || [6, 7, 27].includes(type) && !posted && holds.has(id)) {
        const point = $.CGEventGetLocation(event);
        holds.set(id, key !== undefined ? { key } : { button, x: Number(point.x), y: Number(point.y) });
      } else if (([2, 4, 26, 11].includes(type) || type === 12 && !modifierDown) && posted) holds.delete(id);
      const data = $(JSON.stringify([...holds.values()]));
      if (!data.writeToFileAtomicallyEncodingError($(stopPath + '.holds'), true, $.NSUTF8StringEncoding, null)) throw new Error('Stop release record failed');
    };
  }
  const originalFindApp = findApp, originalResolveWindow = resolveWindow, originalSettle = settleAfterTextWrite;
  findApp = function (name) {
    const app = originalFindApp(name);
    if (!app || Number(app.processIdentifier) !== source.pid) throw new Error(refusal);
    return app;
  };
  resolveWindow = function (own, request) {
    const chosen = originalResolveWindow(own, request);
    const expected = destination && request.windowId === Number(destination.windowId) ? destination : source;
    if (chosen.pid !== expected.pid || String(chosen.id) !== expected.windowId) throw new Error(refusal);
    return chosen;
  };
  settleAfterTextWrite = function (pid) {
    if (pid !== source.pid) throw new Error(refusal);
    // DS1 owns release retries and persistent-failure reporting on both paths.
    return originalSettle(pid);
  };
}

function guardedOptions(options, source, destination, stopPath, ownChild = () => {}) {
  const original = typeof options === 'function' ? { run: options } : options ?? {};
  const execute = original.run ?? execFile;
  return { ...original, run(command, args, execOptions, callback) {
    if (command !== 'osascript' || args.length !== 4 || args[0] !== '-l' || args[1] !== 'JavaScript' ||
        args[2] !== fileURLToPath(dragScript)) throw fault('DRIVER_PROTOCOL');
    const refusal = formatMacDriverError({ code: 'IDENTITY_CHANGED', identityStep: 'drag-binding', delivery: 'not-sent', retry: 'safe' }, { action: true });
    const guard = `(${installDragGuards.toString()})(${JSON.stringify(source)},${JSON.stringify(destination ?? null)},${JSON.stringify(refusal)},${JSON.stringify(stopPath ?? null)});`;
    const child = execute(command, ['-l', 'JavaScript', '-e', readFileSync(dragScript, 'utf8'), '-e', guard, args[3]], execOptions, callback);
    ownChild(child);
    return child;
  } };
}

function fault(code) {
  return Object.assign(new Error(MAC_DRIVER_ERRORS[code].message), { code });
}

function identity(value) {
  if (!value || typeof value !== 'object' || typeof value.windowId !== 'string' ||
      !/^[1-9]\d*$/.test(value.windowId) || Number(value.windowId) > 0xffffffff ||
      !Number.isInteger(value.pid) || value.pid <= 0 || value.pid > 0x7fffffff ||
      typeof value.processStart !== 'string' || !value.processStart ||
      !(value.bundleId === null || typeof value.bundleId === 'string' && value.bundleId.length > 0) || typeof value.title !== 'string' ||
      value.identityVerified !== true) throw fault('IDENTITY_UNVERIFIED');
  return Object.fromEntries(['windowId', 'pid', 'processStart', 'bundleId', 'title', 'identityVerified']
    .map(key => [key, value[key]]));
}

function matching(actual, expected) {
  return actual && Object.keys(expected).every(key => actual[key] === expected[key]);
}

function disposition(error, beforeDispatch) {
  // Providers can throw frozen errors or values from another realm. Annotate a
  // new Error so a readonly property cannot defeat the pre-dispatch refusal flag.
  const value = new Error(typeof error?.message === 'string' ? error.message : MAC_DRIVER_ERRORS.DRIVER_PROTOCOL.message);
  for (const key of ['code', 'unhealthy', 'next', 'personTookOver', 'stopHelperRetired', 'stopRelease']) if (error?.[key] !== undefined) value[key] = error[key];
  Object.assign(value, { refused: beforeDispatch,
    delivery: beforeDispatch ? 'not-sent' : 'unknown', retry: beforeDispatch ? 'safe' : 'read-first' });
  // performDrag retains an exception's message and refused flag. Put the
  // existing driver's disposition wording there as well as on the Error.
  if (!beforeDispatch || Object.hasOwn(MAC_DRIVER_ERRORS, value.code ?? '')) value.message = formatMacDriverError(value, { action: true });
  return value;
}

function unconfirmed(result, failure) {
  const error = disposition(failure, false);
  return { ...result && typeof result === 'object' && !Array.isArray(result) ? result : {},
    ok: false, deliveryVerified: false, delivery: 'unknown', retry: 'read-first',
    code: Object.hasOwn(MAC_DRIVER_ERRORS, error.code ?? '') ? error.code : 'DRIVER_PROTOCOL',
    error: formatMacDriverError(error, { action: true }) };
}

// bindings is a trusted parent callback, not a field in a model request. Its
// source must match the window drag.js will select, even when windowId is absent.
// Use this runner inside callLocalTool, so performDrag keeps its owned cleanup.
export function createDragViaDriver({ driver, runLocal, bindings, current, beginStop } = {}) {
  if (typeof driver?.verifyWindowIdentity !== 'function' || typeof driver?.resolveApp !== 'function' || typeof runLocal !== 'function' ||
      typeof bindings !== 'function' || typeof current !== 'function') throw fault('INVALID_PARAMS');

  const checkCurrent = () => {
    try { current(); }
    catch (error) {
      if (Object.hasOwn(MAC_DRIVER_ERRORS, error?.code ?? '')) throw error;
      throw Object.assign(new Error(error?.message ?? MAC_DRIVER_ERRORS.USER_STOPPED.message), { code: 'USER_STOPPED' });
    }
  };

  return async function run(script, request, options) {
    if (script !== 'drag.js') {
      if (script === 'drag-focus.js' && request?.op === 'restore') {
        try { checkCurrent(); }
        catch (error) {
          if (error?.code === 'USER_STOPPED') return { ok: true, restored: false };
          throw error;
        }
      }
      return runLocal(script, request, options);
    }

    let args, source, destination, stopWindow;
    const verify = async expected => {
      checkCurrent();
      const reply = await driver.verifyWindowIdentity(expected.windowId, { processStart: expected.processStart });
      checkCurrent();
      if (!matching(reply?.window, expected)) throw macIdentityError('drag-binding');
    };
    try {
      checkCurrent();
      args = structuredClone(request);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fault('INVALID_PARAMS');
      const bound = structuredClone(await bindings(structuredClone(args)));
      checkCurrent();
      source = identity(bound?.source); stopWindow = bound.source;
      if (args.toWindowId !== undefined) {
        destination = identity(bound?.destination);
        if (String(args.toWindowId) !== destination.windowId || destination.windowId === source.windowId ||
            ['pid', 'processStart', 'bundleId'].some(key => destination[key] !== source[key])) throw macIdentityError('drag-destination');
      } else if (bound?.destination !== undefined) throw fault('INVALID_PARAMS');
      // Resolve is metadata-only and never launches an app. An arbitrary model
      // selector must not borrow another app's retained, approved binding.
      const resolved = await driver.resolveApp(args.app);
      checkCurrent();
      if (typeof resolved?.app?.id !== 'string' || !resolved.app.id ||
          (source.bundleId !== null && resolved.app.id !== source.bundleId) || resolved.app.pid !== source.pid ||
          resolved.app.processStart !== source.processStart || resolved.app.running !== true) throw macIdentityError('drag-app');
      if (args.windowId !== undefined && String(args.windowId) !== source.windowId) {
        // drag.js recovers a stale numeric ID only for the app's sole visible
        // window, after ruling out an exact off-Space match. Preserve that case
        // only when the driver's fresh inventory proves the same selection.
        const windows = Array.isArray(resolved.windows) ? resolved.windows : [];
        const visible = windows.filter(window => window.onScreen === true);
        if (destination || !Number.isSafeInteger(args.windowId) ||
            windows.some(window => window.windowId === String(args.windowId)) || visible.length !== 1 ||
            !['windowId', 'pid', 'processStart', 'bundleId'].every(key => visible[0][key] === source[key])) throw macIdentityError('drag-window');
      }
      await verify(source);
      if (destination) await verify(destination);
      checkCurrent();
    } catch (error) { throw disposition(error, true); }

    let result;
    // Crossing this boundary can write text or post events. A thrown executor
    // error is never marked refused: the launcher's timeout cleanup still runs.
    let root, end, stopped = false, child, childExited = false, childRetired = false;
    let stopTimer, releaseTimer, rejectStop, releaseChild, releasePending, stopRelease = 'unconfirmed', stopFailure, failure;
    const retireChild = () => {
      if (!child || childExited || childRetired) return;
      try { child.kill('SIGKILL'); childRetired = true; } catch { /* Cleanup remains unconfirmed. */ }
    };
    const stopDeadline = new Promise((_, reject) => { rejectStop = reject; });
    try {
      if (beginStop) {
        root = mkdtempSync(join(tmpdir(), 'sleight-drag-stop-'));
        const path = join(root, 'stop');
        releaseChild = () => releasePending ??= (async () => {
          try {
            // Freeze only this runner's exact child before reading its last
            // attempted holds. It cannot post another down after cleanup.
            if (!childExited && !childRetired) child?.kill('SIGSTOP');
            const holds = JSON.parse(readFileSync(path + '.holds', 'utf8'));
            stopRelease = await driver.releasePostedInput?.(source, holds) ?? 'unconfirmed';
          } catch { stopRelease = 'unconfirmed'; }
        })();
        const requestStop = failure => {
          if (stopped) return;
          stopped = true;
          stopFailure = failure;
          if (failure) Promise.resolve(driver.stopHeld?.()).catch(() => {});
          writeFileSync(path, '1', { mode: 0o600 });
          releaseTimer = setTimeout(() => { void releaseChild(); }, 400);
          stopTimer = setTimeout(() => {
            // This is the exact handle returned by this runner's executor.
            // A missed release receipt never permits another drag or input.
            retireChild();
            rejectStop(Object.assign(stopFailure ?? Error('USER_STOPPED'),
              { code: stopFailure?.code ?? 'USER_STOPPED', unhealthy: true, stopHelperRetired: true, stopRelease }));
          }, 500); // Stepped Stop backstop
        };
        end = await beginStop(stopWindow, () => requestStop());
        if (end?.failure) end.failure.then(error => { requestStop(error); });
        checkCurrent();
      }
      result = await Promise.race([runLocal('drag.js', args,
        guardedOptions(options, source, destination, root && join(root, 'stop'), owned => {
          child = owned;
          child?.once?.('exit', () => { childExited = true; });
          child?.once?.('close', () => { childExited = true; });
        })), stopDeadline]);
      if (end?.controlUnavailable && result && typeof result === 'object') result = { ...result, stopControlUnavailable: true };
      if (stopped) throw stopFailure ?? Object.assign(Error('USER_STOPPED'), { code: 'USER_STOPPED' });
    } catch (error) { failure = disposition(stopFailure ?? error, false); throw failure; }
    finally {
      clearTimeout(releaseTimer);
      // runLocal can settle while its exact child is frozen or ignores SIGTERM.
      // Release its recorded holds and retire it before dropping the backstop.
      // The existing 500 ms deadline still bounds a stuck release transport.
      if (stopped) {
        await Promise.race([releaseChild?.(), stopDeadline.catch(() => {})]);
        retireChild();
        if (failure) {
          failure.stopRelease = stopRelease;
          failure.stopHelperRetired = childRetired || childExited;
          failure.message = formatMacDriverError(failure, { action: true });
        }
      }
      clearTimeout(stopTimer);
      try { await end?.(); } finally { if (root) rmSync(root, { recursive: true, force: true }); }
    }

    // Preserve every original refusal, partial write, lost-text warning and
    // cleanup diagnostic. In particular, never turn a refusal into another drag.
    if (result?.ok === false) return result;
    if (result?.ok !== true || String(result.windowId) !== source.windowId ||
        (destination ? String(result.toWindowId) !== destination.windowId : result.toWindowId !== undefined) ||
        !['accessibility', 'background', 'foreground'].includes(result.path)) return unconfirmed(result, fault('DRIVER_PROTOCOL'));
    try {
      await verify(source);
      if (destination) await verify(destination);
    } catch (error) { return unconfirmed(result, error); }
    return result;
  };
}

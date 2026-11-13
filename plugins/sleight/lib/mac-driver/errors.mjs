import { focusErrorStep } from '../repl/focus-steps.mjs';
import { identityErrorStep } from '../repl/identity-steps.mjs';
// Model-visible recovery belongs here, not in provider messages. Importing this
// module only loads the shared protocol table. RT3 formats in the parent catch,
// before IPC, and prints the returned line directly in the worker.
import { DRIVER_CODES, DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from './protocol.mjs';
import { STRICT_TEXT_REFUSAL, STRICT_TEXT_CONTROL_REFUSAL } from './preserve.mjs';
import { stopRecovery } from '../../hooks/stop-notice.mjs';
export const MAC_DRIVER_NEXT = Object.freeze({
  'read-again': 'Read the current app state and choose the next step from that read.',
  'retry-safe': 'Correct the request if needed, then retry only the operation that was not sent.',
  'stop-tell-user': 'Stop this call and tell the user what prevented it.',
  'ask-user': 'Ask the user to resolve this condition before continuing.',
  'restart-helper': 'Restart the helper, acquire the app again, and read its state before any further input.',
  none: 'Do not retry this operation.',
});

const entry = (message, next, unhealthy = false) => Object.freeze({ message, next, unhealthy });
export const MAC_DRIVER_TARGET_NOTICES = Object.freeze({
  TARGET_CHANGED: 'The coordinate target changed. Capture the window again or use an element number from a new read.',
  READ_FIRST_REQUIRED: 'The previous input outcome is unverified. Deliver a new read of this window before sending more input.',
});
export const MAC_DRIVER_SENTENCES = Object.freeze({
  ...MAC_DRIVER_TARGET_NOTICES,
  ACCESSIBILITY_REQUIRED: 'The app cannot be read without Accessibility access.',
  SCREEN_RECORDING_REQUIRED: 'Window capture needs Screen Recording access.',
  INVALID_PARAMS: 'The driver rejected the request arguments.',
  METHOD_NOT_FOUND: 'The requested operation is absent from this helper.',
  APP_NOT_FOUND: 'The requested app could not be found among installed apps.',
  AMBIGUOUS_APP: 'The app selector matched multiple installed apps.',
  LAUNCH_FAILED: 'The requested app did not finish launching.',
  NO_WINDOWS_AVAILABLE: 'The app has no window available to drive.',
  WINDOW_NOT_FOUND: 'The bound window is no longer available.',
  IDENTITY_CHANGED: 'The window or its owning process changed after binding.',
  IDENTITY_UNVERIFIED: 'The target\'s window identity could not be verified.',
  AX_UNAVAILABLE: 'The app did not provide a usable accessibility response.',
  AX_TIMEOUT: 'The app did not answer the accessibility request within its time budget.',
  STALE_READ: 'The target numbers belong to an earlier read.',
  STALE_ELEMENT: 'The retained target no longer matches a live element.',
  AMBIGUOUS_ELEMENT: 'More than one element matches this target.',
  PERSON_TOOK_OVER: 'Human input changed the app while this call was running.',
  PERSON_HOLDS_MODIFIER: 'A person is holding a keyboard modifier. Stop this call until the user releases it.',
  SECURE_INPUT_ACTIVE: 'Secure keyboard input is active. Stop keyboard automation until the user resolves it.',
  KEY_FOCUS_UNAVAILABLE: 'The target app did not enter or leave the required keyboard focus state.',
  DEADLINE_EXCEEDED: 'The driver did not finish within this call\'s time budget.',
  OUTPUT_LIMIT: 'The driver reply exceeded its size limit.',
  DRIVER_PROTOCOL: 'The helper reply does not satisfy the driver contract.',
  DRIVER_INTERNAL: 'The helper could not complete the operation because of an internal fault.',
  DRIVER_VERSION_MISMATCH: 'The helper and client support different driver interfaces.',
  SCREEN_LOCKED: 'The Mac session is locked and this request cannot run while locked.',
  ELEMENT_DISABLED: 'The target element is disabled.',
  ACTION_UNSUPPORTED: 'The target does not expose the requested action.',
  SECURE_FIELD: 'Stop automation for this secure field. The user must type into it.',
  VALUE_NOT_SETTABLE: 'The target does not allow its value to be set.',
  ACTION_UNCONFIRMED: 'Input was attempted, but its effect could not be confirmed.',
  CLIPBOARD_CHANGED: 'The clipboard changed during or since sleight\'s last action. sleight did not write or read it and cannot restore it.',
  CLIPBOARD_RESTORE_FAILED: 'The paste ended, but the earlier clipboard contents could not be restored.',
  PASTE_UNCONFIRMED_CLIPBOARD_HELD: 'Paste is unconfirmed, so the clipboard is being kept for the target to finish reading.',
  USER_STOPPED: 'Glide input stopped.',
  CAPTURE_TARGET_INVALID: 'The capture target is not a valid bound window.',
  CAPTURE_UNSUPPORTED: 'Window capture is unavailable on this system.',
  CAPTURE_UNAVAILABLE: 'The window capture provider returned no image.',
  CAPTURE_GEOMETRY_CHANGED: 'The window geometry changed during capture.',
  CAPTURE_SCALE_INVALID: 'The capture scale could not be reconciled with the window bounds.',
  CAPTURE_SIZE_LIMIT: 'The window image exceeds the capture size limit.',
  CAPTURE_ENCODING_FAILED: 'The window image could not be encoded.',
});

// These failures originate in the client, outside the helper's wire table.
export const MAC_DRIVER_LOCAL_ERRORS = Object.freeze({
  HAND_HOST_UNAVAILABLE: entry('The Glide engine refused input because its Stop control host is unavailable.', 'stop-tell-user'),
  PLATFORM: entry('This driver requires macOS.', 'stop-tell-user'),
  DRIVER_BUSY: entry('The driver request queue is full.', 'retry-safe'),
  DRIVER_CLOSED: entry('This driver client has already closed.', 'stop-tell-user'),
  DRIVER_RESTARTED: entry('The helper was restarted while this call was pending.', 'restart-helper', true),
  DRIVER_UNAVAILABLE: entry('The Mac helper could not be prepared. Check Apple command-line tools and the local helper build.', 'stop-tell-user'),
  DRIVER_EXIT: entry('The helper exited before this call received its reply.', 'restart-helper', true),
  DRIVER_IO: entry('The helper connection failed before a complete reply arrived.', 'restart-helper', true),
  DRIVER_LINE_LIMIT: entry('A driver protocol line exceeded its size limit.', 'stop-tell-user'),
  DRIVER_UNHEALTHY: entry('The helper reported that it can no longer serve requests.', 'restart-helper', true),
  DRIVER_RETIRE_TIMEOUT: entry('The previous helper has not finished shutting down.', 'stop-tell-user', true),
});

// Helper recovery comes from the same table the client validates and Swift builds.
// Sentences have no independent recovery policy that can drift from that table.
export const MAC_DRIVER_ERRORS = Object.freeze({
  ...Object.fromEntries(Object.entries(MAC_DRIVER_SENTENCES).map(([code, message]) =>
    [code, entry(message, DRIVER_CODES[code].next, DRIVER_CODES[code].unhealthy)])),
  ...MAC_DRIVER_LOCAL_ERRORS,
});

const deliveryValues = new Set(['not-sent', 'sent-unverified', 'sent-verified', 'unknown']);
// Diagnostics carry vocabulary only, never provider prose or arbitrary keys.
export const MAC_DRIVER_PARAM_FIELDS = Object.freeze(['params', 'windowId', 'processStart', 'readId', 'target', 'selector',
  'launch', 'depth', 'budgetMs', 'reuseIfUnchanged', 'menuRequests', 'args', 'read', 'personToken', 'coordinateReadId',
  'quietMs', 'capMs', 'afterReadId', 'extendForBusy', 'busyCapMs', 'includeScroll', 'waitForWindow', 'format', 'scale', 'allowLocked']);
export const MAC_DRIVER_PARAM_NOTICE = ' on <method>, field <field>';
const requestMethods = [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'settle', 'personState'];
const stopReleaseNotice = 'OS delivery unconfirmed. Check held input in the app.';
export const macDriverStopNotices = () => [stopReleaseNotice, 'Stop release record failed'];
export const GLIDE_STOP_SESSION_NOTICE = 'Stop lasts for this session; start a new session to continue.';
export const GLIDE_STOP_PERSON_NOTICE = stopRecovery(true);
export const GLIDE_INTERRUPT_NOTICE = 'The action was interrupted. Input resumes after release completes.';
const incompleteAncestryDetail = "The target's accessibility tree is incomplete. Try another element from a read or a keyboard route.";
export const MAC_DRIVER_MENU_DETAILS = Object.freeze({
  'menu-compound': "Menu title: click the item's number; the menu need not be open.",
  'not-requested': 'Not requested.',
  'person-popup': 'Not sleight-opened. Read when closed.',
});
export const MAC_KEYBOARD_RECOVERY = Object.freeze({
  frontmost: 'Ask the user to make this window frontmost, then read again. sleight never takes focus.',
  other: 'Read the window again; ask the user to restore its keyboard focus if needed. sleight never takes focus.',
});
export const PERSON_WAIT_NOTICE = 'sleight waited <ms> ms for the person to pause';
export const PERSON_POINTER_NOTICE = 'The pointer is over the target window.';
export function personWaitNotice(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 30000
    ? PERSON_WAIT_NOTICE.replace('<ms>', String(value)) : undefined;
}

// Accept either a client Error or a protocol failure envelope. The caller marks
// action requests because a missing disposition on a lost reply proves nothing.
// Never infer non-delivery from an error code or from provider-authored wording.
export function normalizeMacDriverError(failure, { action = false, method } = {}) {
  const source = failure?.error ?? failure;
  const known = typeof source?.code === 'string' && Object.hasOwn(MAC_DRIVER_ERRORS, source.code);
  const code = known ? source.code : 'DRIVER_PROTOCOL';
  const { message: mappedMessage, next: mappedNext, unhealthy: mappedUnhealthy } = MAC_DRIVER_ERRORS[code];
  const hasDisposition = action || source?.delivery !== undefined || source?.retry !== undefined;
  const delivery = deliveryValues.has(source?.delivery) ? source.delivery : 'unknown';
  const incompleteAncestry = code === 'ACTION_UNSUPPORTED' && delivery === 'not-sent' && source?.pointerRefusal === 'incomplete-ancestry';
  // Only explicit proof of non-delivery permits a safe retry. A malformed retry
  // value cannot turn sent or unknown input into a replayable operation.
  // The wire's safe disposition proves non-delivery. This structural refusal
  // still must not invite the model to repeat the same coordinate input.
  const retry = !incompleteAncestry && !['CLIPBOARD_CHANGED', 'TARGET_CHANGED', 'READ_FIRST_REQUIRED'].includes(code) &&
    delivery === 'not-sent' && (source?.retry === undefined || source.retry === 'safe') ? 'safe' : 'read-first';
  const strictRefusal = code === 'ACTION_UNSUPPORTED' && ['unsupported', 'unsupported-controls'].includes(source?.textInput) && delivery === 'not-sent' && retry === 'safe';
  const menuRefusal = code === 'ACTION_UNSUPPORTED' && delivery === 'not-sent' && retry === 'safe' &&
    Object.hasOwn(MAC_DRIVER_MENU_DETAILS, source?.menuRefusal ?? '') ? source.menuRefusal : undefined;
  const message = strictRefusal
    ? source.textInput === 'unsupported-controls' ? STRICT_TEXT_CONTROL_REFUSAL : STRICT_TEXT_REFUSAL
    : incompleteAncestry ? incompleteAncestryDetail
    : menuRefusal ? MAC_DRIVER_MENU_DETAILS[menuRefusal]
    : code === 'USER_STOPPED' && source?.interrupted === true ? GLIDE_INTERRUPT_NOTICE : mappedMessage;
  const unhealthy = mappedUnhealthy || source?.unhealthy === true;
  let next = mappedNext;
  if (menuRefusal === 'menu-compound') next = 'read-again';
  if (code === 'INVALID_PARAMS' && requestMethods.includes(method) && !action) next = 'retry-safe';
  if (unhealthy && ['read-again', 'retry-safe'].includes(next)) next = 'restart-helper';
  if (hasDisposition && retry === 'read-first' && next === 'retry-safe') next = 'read-again';
  return Object.freeze({ code, message, next, directive: MAC_DRIVER_NEXT[next],
    unhealthy,
    ...code === 'INVALID_PARAMS' && requestMethods.includes(method) ? { method,
      field: MAC_DRIVER_PARAM_FIELDS.includes(source?.field) ? source.field : 'params' } : {},
    ...code === 'IDENTITY_CHANGED' && identityErrorStep(source) ? { identityStep: identityErrorStep(source) } : {},
    ...code === 'KEY_FOCUS_UNAVAILABLE' && focusErrorStep(source) ? { focusStep: focusErrorStep(source) } : {},
    ...source?.stopHelperRetired === true ? { stopHelperRetired: true } : {},
    ...['posted', 'unconfirmed'].includes(source?.stopRelease) ? { stopRelease: source.stopRelease } : {},
    ...hasDisposition ? { delivery, retry } : {},
    ...source?.clipboard === 'untouched' ? { clipboard: 'untouched' } : {},
    ...code === 'TARGET_CHANGED' && delivery === 'not-sent' && ['button', 'container', 'sheet', 'dialog', 'other'].includes(source?.targetRole)
      ? { targetRole: source.targetRole } : {},
    ...strictRefusal ? { textInput: source.textInput } : {},
    ...typeof source?.personTookOver === 'boolean' ? { personTookOver: source.personTookOver } : {},
    ...personWaitNotice(source?.waitedForPersonMs) ? { waitedForPersonMs: source.waitedForPersonMs } : {},
    ...code === 'PERSON_TOOK_OVER' && source?.reason === 'person-pointer' ? { pointerOverTarget: true } : {},
    ...Object.fromEntries([['charactersDelivered', source?.charactersDelivered], ['charactersPosted', source?.charactersPosted]]
      .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)),
    ...Object.fromEntries([['focusChanged', source?.focusChanged], ['focusRestored', source?.focusRestored],
      ['compositionBypassed', source?.compositionBypassed], ['textBeliefFallback', source?.textBeliefFallback]]
      .filter(([, value]) => typeof value === 'boolean')),
    ...code === 'AMBIGUOUS_ELEMENT' && Number.isSafeInteger(source?.matchCount) && source.matchCount >= 2 && source.matchCount <= 1_048_576
      ? { matchCount: source.matchCount } : {},
  });
}

export function formatMacDriverError(failure, options) {
  const error = normalizeMacDriverError(failure, options);
  const step = error.identityStep || error.focusStep ? ` step=${error.identityStep ?? error.focusStep};` : '';
  const disposition = error.delivery === undefined ? '' : ` delivery=${error.delivery}; retry=${error.retry};`;
  const clipboard = error.clipboard === 'untouched' ? ' clipboard=untouched;' : '';
  const takeover = error.personTookOver === undefined ? '' : ` personTookOver=${error.personTookOver};`;
  const matches = error.matchCount === undefined ? '' : ` matches=${error.matchCount};`;
  const stopHelper = error.stopHelperRetired || error.stopRelease ?
    ` ${error.stopHelperRetired ? 'stopHelper=retired; ' : ''}stopRelease=${error.stopRelease ?? 'unconfirmed'}; ${stopReleaseNotice}` : '';
  const text = error.textBeliefFallback === undefined ? '' :
    ['charactersDelivered', 'charactersPosted', 'focusChanged', 'focusRestored', 'compositionBypassed', 'textBeliefFallback']
      .filter(key => Object.hasOwn(error, key)).map(key => ` ${key}=${error[key]};`).join('');
  const targetRole = error.targetRole === undefined ? '' : ` found=${error.targetRole};`;
  const beforeRetry = error.retry === 'read-first' && ['read-again', 'restart-helper'].includes(error.next) ? ' Read the app state before repeating any input.' : '';
  const pointer = error.pointerOverTarget ? ` ${PERSON_POINTER_NOTICE}` : '';
  const waited = personWaitNotice(error.waitedForPersonMs);
  const keyboard = error.code === 'KEY_FOCUS_UNAVAILABLE' ? ` ${MAC_KEYBOARD_RECOVERY[error.focusStep === 'frontmost' ? 'frontmost' : 'other']}` : '';
  const request = error.method ? MAC_DRIVER_PARAM_NOTICE.replace('<method>', error.method).replace('<field>', error.field) : '';
  const safeDisposition = error.next === 'none' ? disposition.replace(' retry=safe;', '') : disposition;
  return `sleight: ${error.code}${request}: ${error.message}${step}${safeDisposition}${clipboard}${takeover}${matches}${stopHelper}${text}${targetRole} next=${error.next}: ${error.directive}${beforeRetry}${keyboard}${pointer}${waited ? `\n${waited}` : ''}`;
}

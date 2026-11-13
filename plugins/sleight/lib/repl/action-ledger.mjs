// Only parent arrival and reply records populate this ledger. Worker output is
// ordinary display text and cannot vouch for input delivery.
export const GLIDE_ACCOUNTING_NOTICES = Object.freeze([
  'sleight: action ledger',
  'requests arrived; no later action request reached sleight.',
  'next=retry-safe: retry only the refused rows.',
  'next=read-again: effects may have occurred.',
  'stopped CODE [N reads, M keys]', 'N of M characters', 'late:', 'refused (cell ended)', 'sent-verified', 'sent-unverified', 'sent-partial', 'N more rows', 'N characters omitted', 'unknown', 'refused', 'sent, verified', 'sent, unverified',
]);
const MAX_PRINTED_ROWS = 20, MAX_ARGUMENT_BYTES = 80;
function printedArguments(args) {
  const full = args.map(arg => JSON.stringify(arg)).join(',');
  if (Buffer.byteLength(full) <= MAX_ARGUMENT_BYTES) return full;
  let prefix = '', bytes = 0, kept = 0;
  for (const char of full) {
    bytes += Buffer.byteLength(char);
    if (bytes > MAX_ARGUMENT_BYTES) break;
    prefix += char; kept++;
  }
  return prefix + ` [${[...full].length - kept} characters omitted]`;
}
const helperNames = new Set(['pickFromList', 'fillForm', 'dragTo']);
const safeCode = code => /^[A-Z][A-Z_]{1,63}$/.test(code) ? code : 'DRIVER_FAILED';
export function createActionLedger(late = []) {
  const rows = late.map(row => structuredClone(row)), helpers = new Map();
  let requests = late.length;
  return {
    rows,
    late(row) { rows.push(row); requests++; },
    arrive(message) {
      const helper = helperNames.has(message.helper) && Number.isSafeInteger(message.helperId) ? message.helper : undefined;
      const key = helper && JSON.stringify([helper, message.helperId]);
      let row = key && helpers.get(key);
      if (!row) {
        row = { method: helper ?? message.method, args: structuredClone(message.params?.args ?? []),
          disposition: 'unknown', helper, reads: 0, keys: 0, requests: 0 };
        rows.push(row); if (key) helpers.set(key, row);
      }
      if (!['getAXState', 'getApp'].includes(message.method)) { requests++; row.requests++; }
      return row;
    },
    settle(row, method, reply, bound) {
      const result = reply?.error ?? reply?.result;
      if (row.helper && method === 'getAXState' && reply?.result) row.reads++;
      if (row.helper && method === 'pressKey' && result?.delivery !== 'not-sent') row.keys++;
      if (bound?.length) row.bound = [...bound];
      const disposition = result?.delivery === 'not-sent' && result?.charactersDelivered > 0 ? 'sent-partial' : result?.delivery === 'not-sent' ? 'refused ' + safeCode(result?.code) :
        ['sent-verified', 'sent-unverified', 'sent-partial'].includes(result?.delivery) ? result.delivery : 'unknown';
      if (row.helper) {
        if (disposition.startsWith('sent-')) row.sent = true;
        if (disposition === 'unknown' && !['getAXState', 'getApp'].includes(method)) row.uncertain = true;
        if (reply?.error) row.stopped = safeCode(reply.error.code);
        // A read has no input disposition and cannot erase earlier input.
        if (method === 'getAXState' || method === 'getApp') return;
        if (row.uncertain) row.disposition = 'unknown';
        else if (row.sent && disposition.startsWith('refused')) row.disposition = 'sent-unverified';
        else if (!row.stopped || disposition !== 'unknown') row.disposition = disposition;
      } else row.disposition = disposition;
      if (Number.isSafeInteger(result?.charactersDelivered)) row.charactersDelivered = result.charactersDelivered;
    },
    format(error = false) { return formatActionLedger(rows, { requests, error }); },
  };
}
export function formatActionLedger(rows, { requests = rows.length, error = false } = {}) {
  if (requests === 1 && !error && rows.length === 1 && !rows[0].late && !rows[0].helper &&
      ['sent-verified', 'sent-unverified'].includes(rows[0].disposition)) {
    const row = rows[0], args = printedArguments(row.args);
    const target = row.args.length === 1 && typeof row.args[0] === 'number' ? ' ' + args : '(' + args + ')';
    const bound = row.bound?.length && !(row.bound.length === 1 && row.bound[0] === row.args[0]) ? ' → ' + row.bound.join(',') : '';
    return row.method + target + bound + ' ' + (row.disposition === 'sent-verified' ? 'sent, verified' : 'sent, unverified');
  }
  if (requests < 2 && !error && !rows.some(row => row.late || row.disposition === 'sent-partial')) return '';
  if (!rows.length) return `0 ${GLIDE_ACCOUNTING_NOTICES[1]}`;
  const line = (row, i) => {
    const args = printedArguments(row.args);
    const bound = row.bound?.length ? ' → ' + row.bound.join(',') : '';
    const count = row.charactersDelivered === undefined ? '' : `, ${row.charactersDelivered} of ${[...String(row.args[0])].length} characters`;
    const helper = row.helper ? ` [${row.reads} reads, ${row.keys} keys]` : '';
    return `${i + 1} ${row.late ? 'late: ' : ''}${row.method}(${args})${bound} ${row.late ? 'refused (cell ended)' : row.helper && row.stopped ? 'stopped ' + row.stopped : row.disposition}${count}${helper}`;
  };
  const lines = rows.slice(0, MAX_PRINTED_ROWS).map(line);
  const safe = rows.every(row => row.late || row.disposition.startsWith('refused'));
  if (rows.length > MAX_PRINTED_ROWS) {
    lines.push(`${rows.length - MAX_PRINTED_ROWS} more rows`);
    // The model must see why next= says read-again: when every printed row was
    // refused, print the first omitted row that may have sent input.
    const decides = rows.findIndex((row, i) => i >= MAX_PRINTED_ROWS && !row.late && !row.disposition.startsWith('refused'));
    if (decides >= 0 && rows.slice(0, MAX_PRINTED_ROWS).every(row => row.late || row.disposition.startsWith('refused'))) lines.push(line(rows[decides], decides));
  }
  return [GLIDE_ACCOUNTING_NOTICES[0], ...lines,
    `${requests} ${GLIDE_ACCOUNTING_NOTICES[1].replace(/^requests/, requests === 1 ? 'request' : 'requests')}`,
    GLIDE_ACCOUNTING_NOTICES[safe ? 2 : 3]].join('\n');
}

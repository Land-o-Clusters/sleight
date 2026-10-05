// Judging a blocked-app live run, and scrubbing personal paths out of it.
// Kept separate from the driver so unit tests can feed it recorded runs.

// Home paths as ~, the account and machine names out of published logs, and
// the per-user temp folder as ~tmp (macOS reports it with and without the
// /private prefix).
export function makeClean({ home, user, host, tmp }) {
  const HOST = String(host ?? '').replace(/\.local$/, '');
  return text => String(text ?? '')
    .split('/private' + tmp).join('~tmp')
    .split(tmp).join('~tmp')
    .split(home).join('~')
    .split('/private' + home).join('~')
    .split(user).join('user')
    .split(host).join('mac')
    .split(HOST).join('mac');
}

// The pass bar is the full behavior: the session started, the user consented,
// the driver's read actually succeeded (ok: true in its reply — a trace
// marker alone is not success), and nothing was blocked by host permissions.
// For Terminal the last read must show the typed line and its output; the
// Codex click is recorded but optional, because the harmless-button rule can
// legitimately leave nothing to click.
export function judgeBlockedLive(mode, { exit = {}, timedOut = false, events = [], messages = [], stdout = '' } = {}) {
  const text = msg => (msg?.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const replies = events.filter(e => e.direction === 'to-client' && e.msg?.result?.content).map(e => text(e.msg));
  const readReplies = replies.filter(t => t.includes('"elements"'));
  const readOk = readReplies.some(t => t.includes('"ok": true'));
  const clicked = replies.some(t => t.includes('"clicked"') && t.includes('"ok": true'));
  const consentAsked = events.filter(e => e.direction === 'local-approval' && e.msg?.action === 'accept').length;
  const all = JSON.stringify({ events, messages, stdout });
  const reported = messages.filter(m => m.type === 'result').map(m => String(m.result ?? ''));
  const traceEvents = events.map(e => e.direction).filter(d =>
    ['blocked-app-action', 'local-approval', 'blocked-app-refusal'].includes(d));
  const lastRead = readReplies.at(-1) ?? '';
  const echoSeen = mode === 'terminal' ? /echo sleight\nsleight/.test(lastRead) : true;
  const result = {
    timedOut, exit,
    traceEvents,
    consentAsked,
    sendAsked: (all.match(/send this to/g) ?? []).length,
    refusalOffered: events.some(e => e.direction === 'blocked-app-refusal'),
    assistiveDenied: /-25211|-1719|assistive access/i.test(all),
    actionRan: traceEvents.includes('blocked-app-action'),
    readOk, clicked, echoSeen,
    reported,
    stdout: stdout.slice(0, 20000),
  };
  result.passed = !timedOut && exit.code === 0 && consentAsked > 0 && !result.assistiveDenied &&
    readOk && echoSeen;
  return result;
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, isContext, runInContext } from 'node:vm';
import { createHash } from 'node:crypto';

export const native = name => readFileSync(new URL('../../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
// Production text is the source a build without SLEIGHT_TEST_SEAMS compiles.
export function withoutTestSeams(source) {
  const lines = source.split('\n');
  const kept = [];
  let skip = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skip === 0 && trimmed === '#if SLEIGHT_TEST_SEAMS') { skip = 1; continue; }
    if (skip > 0) {
      if (trimmed.startsWith('#if')) skip++;
      else if (trimmed === '#endif') skip--;
      continue;
    }
    kept.push(line);
  }
  if (skip !== 0) throw new Error('unclosed SLEIGHT_TEST_SEAMS');
  return kept.join('\n');
}
export function body(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, 'production seam exists: ' + signature);
  const open = source.indexOf('{', start);
  // Mask comments and strings without moving their offsets.
  const masked = source.replace(/\/\/[^\n]*|\/\*[^]*?\*\/|"(?:\\.|[^"\\])*"/g, token => ' '.repeat(token.length));
  let end = open + 1, depth = 1;
  for (; depth && end < masked.length; end++) { if (masked[end] === '{') depth++; if (masked[end] === '}') depth--; }
  assert.equal(depth, 0);
  return source.slice(open + 1, end - 1);
}
class Dictionary extends Map {
  get Count() { return this.size; }
  get Keys() { return { ToArray: () => [...this.keys()] }; }
  TryGetValue(key) { return this.get(key); }
  Add(key, value) { assert.ok(!this.has(key)); this.set(key, value); }
  Remove(key) { return this.delete(key); }
  Clear() { this.clear(); }
  ToArray() { return [...this].map(([Key, Value]) => ({ Key, Value })); }
}
class HashSet extends Set {
  get Count() { return this.size; }
  Add(value) { const fresh = !this.has(value); this.add(value); return fresh; }
  Contains(value) { return this.has(value); }
  Remove(value) { return this.delete(value); }
  UnionWith(values) { for (const value of values) this.add(value); }
}
export class DriverFault extends Error { constructor(code) { super(code); this.Code = code; this.code = code; } }
function translate(code) {
  return code.replace(/lock \(sync\)/g, '')
    .replace(/foreach \(var (\w+) in ([^\n]+?)\)/g, 'for (const $1 of $2)')
    .replace(/\b(?:WindowRecord|Root) (\w+);/g, 'let $1;')
    .replace(/(\w+)\.TryGetValue\(([^,]+), out (\w+)\)/g, '(($3 = $1.TryGetValue($2)) !== undefined)')
    .replace(/\b(?:var|long|string|IntPtr|bool\??|int|DriverPoint|Func<bool>) (\w+)\s*=/g, 'let $1 =')
    .replace(/\b(?:string|UIntPtr) (\w+);/g, 'let $1;')
    .replace(/new HashSet<IntPtr>\(([^()]*)\)/g, 'new HashSet($1)')
    .replace(/new List<string>\(\)/g, '[]')
    .replace(/new Root \{/g, '({').replace(/Members = new HashSet\(members\) \}/g, 'Members: new HashSet(members) })')
    .replace(/Pid = pid, Value = \+\+next, /g, 'Pid: pid, Value: ++next, ')
    .replace(/new\[\] \{ root, before.ToString\(CultureInfo.InvariantCulture\) \+ ":" \+ fingerprint \}/g, '[root, String(before) + ":" + fingerprint]')
    .replace(/new\[\] \{ [^}]+ \}/g, value => '[' + value.slice(8, -1) + ']')
    .replace(/parts.Add\(/g, 'parts.push(').replace(/parts.Sort\(StringComparer.Ordinal\)/g, 'parts.sort()')
    .replace(/using \(let hash = SHA256.Create\(\)\) fingerprint = [^\n]+;/g, 'fingerprint = hash(parts.join(";"));')
    .replace(/before.SequenceEqual\(([^()]+\([^)]*\)|[^)]+)\)/g, 'equal(before, $1)')
    .replace(/ref Progress.Posts, PostedMessages/g, 'Progress, PostedMessages')
    .replace(/out result/g, 'result')
    .replace(/for \(int /g, 'for (let ')
    .replace(/catch \{([^]*?)throw;/g, 'catch (error) {$1throw error;')
    .replace(/catch \(DriverFault error\)/g, 'catch (error)');
}
const base = { DriverFault, HashSet, Dictionary, IntPtr: { Zero: 0 }, WindowRecord: { Id: String },
  String: Object.assign(String, { IsNullOrEmpty: v => v == null || v === '' }),
  hash: data => createHash('sha256').update(data).digest('base64'),
  equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) };
export function method(source, signature, args, context = {}) {
  return runInContext(`(${args.join(',')}) => { ${translate(body(source, signature))} }`, isContext(context) ? context : createContext({ ...base, ...context }));
}
export function lifetimeSeams(source = native('DriverInventory.cs')) {
  const proof = method(source, 'internal string Proof()', [], {});
  // Field names are C# instance fields; bind each through a small lexical wrapper.
  function life(patch = {}) {
    const fields = { Pid: 41, Thread: 51, ProcessBirth: '134059077770000001', ThreadBirth: '134059077770000002', ClassAtom: 123, Parent: 0, Owner: 0, ...patch };
    return { ...fields, Proof: () => method(source, 'internal string Proof()', [], fields)() };
  }
  assert.equal(typeof proof, 'function');
  const lifetime = method(source, 'internal static string[] Lifetime(IntPtr hwnd, Func<IntPtr, DriverWindowLife> sample,', ['hwnd', 'sample', 'descendants', 'epoch']);
  return { life, lifetime, members: values => new HashSet(values) };
}
export function topologySeam(source = native('DriverInventory.cs')) {
  const region = source.slice(source.indexOf('internal sealed class DriverTopologyEpoch'), source.indexOf('internal sealed class DriverTopology :'));
  const roots = new Dictionary();
  // next is one shared mutable cell, just as the C# instance field is.
  const scope = { ...base, roots, next: 0 };
  const context = createContext(scope);
  const methods = {};
  for (const [name, signature, args] of [
    ['Track', ' Track(', ['root', 'pid', 'members']], ['Sample', 'internal long Sample(', ['root']],
    ['Record', 'internal void Record(', ['kind', 'hwnd', 'objectId', 'childId', 'pid', 'descendant', 'revoke', 'advance = null']],
    ['Prune', 'internal void Prune(', ['exists']], ['Clear', 'internal void Clear()', []],
  ]) methods[name] = runInContext(`(${args.join(',')}) => { ${translate(body(region, signature))} }`, context);
  return { ...methods, roots, members: values => new HashSet(values) };
}
export function inputSeams(source = native('DriverInput.cs')) {
  const events = [];
  const context = { ...base, Progress: null, PostedMessages: 0, EnsureBudget() {},
    MarkInput() { events.push('mark'); }, RequirePostMessage() {}, Volatile: { Write() {} } };
  const signatures = [
    ['InputEffect', 'internal static bool InputEffect(', ['identity', 'post']],
    ['PointerMessage', 'internal static bool PointerMessage(', ['message']],
    ['RequireInside', 'internal static void RequireInside(', ['point', 'surface']],
    ['PointerEffect', 'internal static bool PointerEffect(', ['identity', 'point', 'surface', 'post']],
    ['RetryPost', 'internal static void RetryPost(', ['post', 'error', 'pause', 'check', 'backpressure']],
  ];
  const scope = createContext(context);
  for (const [name, signature, args] of signatures) scope[name] = method(source, signature, args, scope);
  const post = method(source, 'bool validated, bool backpressure, bool idle, PostApi api)',
    ['window', 'hwnd', 'message', 'wParam', 'lParam', 'cleanup', 'validated', 'backpressure', 'idle', 'api'], scope);
  return { post, events };
}
export function effectBoundary(source = native('DriverActions.cs')) {
  return method(source, 'internal static void EffectBoundary(Action observe, Action person, Action mark)', ['observe', 'person', 'mark']);
}
export function bindingsSeam(source = native('DriverInventory.cs')) {
  const region = source.slice(source.indexOf('internal sealed class DriverBindings'), source.indexOf('internal sealed class DriverWindowLife'));
  const windows = new Dictionary(), tokens = new Dictionary();
  const scope = createContext({ ...base, windows, tokens,
    Guid: { NewGuid: () => ({ ToString: () => String(Math.random()).slice(2).padEnd(32, '0') }) },
    DriverIdentity: { Verify(before, after) {
      before.RequireReadable(); after.RequireReadable();
      if (!before.SameIdentity(after)) throw new DriverFault('IDENTITY_CHANGED'); return after;
    } } });
  const methods = {};
  for (const [name, signature, args] of [
    ['Revoke', 'internal void Revoke(', ['hwnd']], ['Remember', 'internal WindowRecord Remember(', ['window']],
    ['Resolve', 'internal WindowRecord Resolve(', ['token', 'hwnd', 'birth', 'observe']],
    ['Prune', 'internal void Prune(', ['exists']], ['Clear', 'internal void Clear()', []],
  ]) { scope[name] = method(region, signature, args, scope); methods[name] = scope[name]; }
  return { ...methods, windows, tokens };
}
export function row(fields = {}) {
  const value = { Handle: 101, Pid: 41, ThreadId: 51, ProcessStart: '134059077770000001',
    Image: 'fixture.exe', ImageIdentity: 'birth:4096', App: 'Fixture', ClassName: 'FixtureWindow',
    WindowGeneration: '1', TopologyGeneration: '1:tree', Refused: null, BindingId: null, ...fields };
  value.RequireReadable = () => { if (value.Refused) throw new DriverFault(value.Refused); };
  value.Copy = () => row({ ...value });
  value.SameIdentity = other => other && ['Handle', 'Pid', 'ThreadId', 'ProcessStart', 'Image', 'WindowGeneration', 'TopologyGeneration'].every(k => value[k] === other[k]) &&
    (value.BindingId == null || other.BindingId == null || value.BindingId === other.BindingId);
  return value;
}
export function observeSeams(source = native('DriverInventory.cs'), calls = []) {
  const bindings = bindingsSeam(source);
  const scope = { ...base, DriverInput: { Post(_window, hwnd) { calls.push(['write', hwnd]); } }, ObserveBound: method(source, 'internal static WindowRecord ObserveBound(', ['hwnd', 'lifetime', 'observe', 'desktop', 'bindings']) };
  return { bindings, observe: method(source, 'internal static WindowRecord Observe(IntPtr hwnd, Func<IntPtr, bool> exists,',
    ['hwnd', 'exists', 'metadata', 'lifetime', 'desktop', 'bindings'], scope) };
}
// In-memory protocol peer. It has no process, window, provider or input API.
export async function reviewClient(load) {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const transportUrl = new URL('../../plugins/sleight/lib/driver-client.mjs', import.meta.url);
  const wrapperUrl = new URL('../../plugins/sleight/lib/windows-driver/client.mjs', import.meta.url);
  const absolute = (text, url) => text.replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g,
    (_m, _q, relative) => 'from ' + JSON.stringify(new URL(relative, url).href));
  const encoded = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
  const transport = encoded(absolute(load('driver-client.mjs'), transportUrl));
  const wrapper = absolute(load('windows-driver/client.mjs').replace("'../driver-client.mjs'", JSON.stringify(transport)), wrapperUrl);
  const { createWindowsDriverClient } = await import(encoded(wrapper));
  const calls = [], token = 'a'.repeat(32);
  const window = { windowId: '101', processStart: '134059077770000001', bindingId: token, pid: 41,
    image: 'C:\\Apps\\Fixture.exe', app: 'Fixture', title: 'Fixture', className: 'FixtureWindow', integrity: 'medium' };
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const request = JSON.parse(String(bytes)); calls.push(request);
      const reply = { protocol: 'sleight.windows-driver/1', nonce, id: request.id, ok: true };
      if (['turn-start', 'turn-end'].includes(request.method)) reply.result = { turn: request.params.turn, active: request.method === 'turn-start' };
      else if (request.method === 'ping') reply.result = { protocol: reply.protocol, methods: ['ping', 'getApp', 'verifyWindowIdentity', 'drag'] };
      else if (request.method === 'getApp') reply.result = { window, readId: 1, text: 'Window: "Fixture", App: Fixture.\n0 standard window Fixture' };
      else if (request.method === 'verifyWindowIdentity' && request.params.bindingId === token) reply.result = { window };
      else { reply.ok = false; reply.error = { code: request.method === 'drag' ? 'BACKGROUND_UNAVAILABLE' : 'IDENTITY_CHANGED', message: 'fixture refusal', unhealthy: false }; }
      queueMicrotask(() => child.stdout.write(JSON.stringify(reply) + '\n')); done();
    } });
    return child;
  } }) });
  return { client, calls, token };
}

export function setValueBoundary(source = native('DriverInput.cs'), calls = []) {
  let observations = 0;
  return method(source, 'internal static void SetValue(', ['window', 'hwnd', 'text'], {
    Check() { calls.push('observe'); observations++; }, RequireWritableEdit() { calls.push('edit-style'); },
    EnsureBudget() {}, MarkInput() { calls.push('mark'); }, UIntPtr: { Zero: 0 },
    DriverPerson: { Require() { calls.push('person'); if (observations >= 2) throw new DriverFault('PERSON_TOOK_OVER'); } },
    Marshal: { StringToHGlobalUni() { return 1; }, FreeHGlobal() { calls.push('free'); } },
    SendMessageTimeoutW() { calls.push('send'); return 0; },
  });
}

import assert from 'node:assert/strict';
import { createCompoundAuthoritySource } from '../../plugins/sleight/lib/mac-driver/compound/authority.mjs';
import { createCompoundParent } from '../../plugins/sleight/lib/mac-driver/compound/parent.mjs';
import { createCompoundContracts } from '../../plugins/sleight/lib/mac-driver/compound/contracts.mjs';
import { createCompoundTransitionContract } from '../../plugins/sleight/lib/mac-driver/compound/transitions.mjs';

export const compoundTestBinding = Object.freeze({ bundleId: 'test.compound.App', pid: 123, processStart: 'start-1',
  helper: 'helper-1', windowId: '42', root: 'root', document: 'document-A', responder: 'document-A', mainWindowId: '42' });
export const compoundTestNode = (token, parent, role, title, extra = {}) => ({ token, parent, role, subrole: null,
  title, description: null, value: null, identifier: token, help: null, keyEquivalent: null,
  enabled: true, selected: false, expanded: false, secure: false, active: true, childrenComplete: true,
  actions: ['AXPress'], ...extra });
export const compoundTestRelation = (kind, owner, child) => ({ kind, owner, child, root: 'root', document: 'document-A',
  pid: 123, processStart: 'start-1', proof: 'platform-owner' });

function base() {
  return { readId: 1, epoch: 0, binding: { ...compoundTestBinding }, title: 'Draft', complete: true, coherent: true,
    inventoryComplete: true, gaps: [], modals: [], routing: { background: true, focusChanged: false, blocked: false },
    context: { account: 'local', recipient: null, amount: null, documentVersion: 1, commandTarget: 'document-A' },
    nodes: [compoundTestNode('root', null, 'AXWindow', 'Draft')], domains: {}, relations: [] };
}
function menus() {
  const s = base();
  s.nodes.push(compoundTestNode('bar', 'root', 'AXMenuBar', null), compoundTestNode('edit', 'bar', 'AXMenuBarItem', 'Edit'),
    compoundTestNode('edit-menu', 'edit', 'AXMenu', null, { active: false }),
    compoundTestNode('find', 'edit-menu', 'AXMenuItem', 'Find', { active: false }),
    compoundTestNode('find-menu', 'find', 'AXMenu', null, { active: false }),
    compoundTestNode('command', 'find-menu', 'AXMenuItem', 'Find and Replace…', { active: false }));
  s.domains.menu = { container: 'bar', complete: true, active: true };
  s.relations.push(compoundTestRelation('menu', 'root', 'bar'));
  return s;
}
function choose() {
  const s = base();
  s.nodes.push(compoundTestNode('control', 'root', 'AXPopUpButton', 'Region', { value: 'Inland' }),
    compoundTestNode('options', 'control', 'AXMenu', null, { active: false }),
    compoundTestNode('coast', 'options', 'AXMenuItem', 'Coast', { active: false }),
    compoundTestNode('coastal', 'options', 'AXMenuItem', 'Coastal', { active: false }));
  s.domains.options = { container: 'options', complete: true, active: false };
  s.relations.push(compoundTestRelation('options', 'control', 'options'));
  return s;
}
function save() {
  const s = base();
  s.nodes.push(compoundTestNode('panel', 'root', 'AXSheet', 'Save'),
    compoundTestNode('directory', 'panel', 'AXTextField', 'Where', { value: '/fixtures/old', actions: ['AXSetValue'] }),
    compoundTestNode('basename', 'panel', 'AXTextField', 'Save As', { value: 'old.txt', actions: ['AXSetValue'] }),
    compoundTestNode('commit', 'panel', 'AXButton', 'Save'), compoundTestNode('replace', 'panel', 'AXButton', 'Replace'));
  s.panel = { token: 'panel', standard: true, acquired: true, attachedTo: 'document-A', pid: 123, processStart: 'start-1',
    directoryField: 'directory', basenameField: 'basename', directory: { path: '/fixtures/old', identity: 'old-folder',
      kind: 'literal-local', resolved: true }, basename: 'old.txt', destination: '/fixtures/old/old.txt',
    formatChanged: false, extensionChanged: false, conflict: false, authentication: false, commitSent: false };
  s.domains.panel = { container: 'panel', complete: true, active: true };
  s.relations.push(compoundTestRelation('panel', 'root', 'panel'));
  return s;
}
export function compoundFixture(operation = 'menu', options = {}) {
  const h = { fake: true, time: 1000, sequence: 0, lastInput: 0, calls: [], mutations: [], hooks: new Map(),
    counts: new Map(), qualified: true, classification: 'local', retired: true, invalidated: false,
    postedEvents: 0, clipboardAccesses: 0, forbiddenCalls: 0, reservationHeld: false, replyLost: false,
    intent: operation === 'menu' ? { operation, segments: ['Edit', 'Find', 'Find and Replace…'] } :
      operation === 'choose' ? { operation, control: { readId: 1, element: 7 }, option: { role: 'AXMenuItem', source: 'title', label: 'Coast' } } :
      { operation, destination: '/fixtures/project/report.txt' },
    snapshot: operation === 'menu' ? menus() : operation === 'choose' ? choose() : save(),
    person: { valid: true, targetScopedQuiet: true, heldModifiers: false, heldButtons: false,
      secureInput: false, locked: false, onConsole: true, focusChanged: false },
    auth: { source: 'trusted-task', sessionActive: true, cellActive: true, approved: true, permissions: true,
      policy: true, siteKnown: true, flow: true, generation: 1,
      approvalScope: { kind: 'app-input', binding: { ...compoundTestBinding } }, lease: { token: 'lease-A', live: true, fenced: true, expires: 31000 } },
  };
  h.node = token => h.snapshot.nodes.find(n => n.token === token);
  h.on = (phase, fn, occurrence = 1) => { h.hooks.set(`${phase}:${occurrence}`, fn); return h; };
  h.phase = async phase => {
    assert.equal(h.fake, true, 'fixture providers must be established as fake before driver access');
    h.calls.push(phase); const count = (h.counts.get(phase) ?? 0) + 1; h.counts.set(phase, count);
    await h.hooks.get(`${phase}:${count}`)?.(h);
    await options.scheduler?.(h, phase, count);
  };
  // This is the fake app, independent from admission and raw AX observations.
  // Its semantic recipient/effect oracle can differ from the observed metadata.
  h.trueRecipient = 'document-A'; h.trueEffect = 'local'; h.effects = [];
  function apply(snapshot, token, value) {
    const node = snapshot.nodes.find(n => n.token === token);
    if (token === 'edit' || token === 'find') {
      const container = token === 'edit' ? 'edit-menu' : 'find-menu';
      node.expanded = true;
      for (const n of snapshot.nodes) if (n.token === container || n.parent === container) n.active = true;
      snapshot.domains.menu = { container, complete: true, active: true };
      snapshot.relations.push(compoundTestRelation('menu', token, container));
    } else if (token === 'command') {
      const unopened = snapshot.domains.menu.container === 'bar';
      for (const n of unopened ? [] : snapshot.nodes) {
        if (['edit', 'find'].includes(n.token)) n.expanded = false;
        if (['edit-menu', 'find-menu', 'find', 'command'].includes(n.token)) n.active = false;
      }
      if (!unopened) snapshot.domains.menu.active = false;
      snapshot.findUI = { document: snapshot.binding.document, fields: ['find', 'replace'], localOnly: true };
    } else if (token === 'control') {
      node.expanded = true;
      for (const n of snapshot.nodes) if (n.parent === 'options' || n.token === 'options') n.active = true;
      snapshot.domains.options.active = true;
    } else if (token === 'coast' || token === 'coastal') {
      const control = snapshot.nodes.find(n => n.token === 'control');
      control.value = node.title; control.expanded = false;
      if (options.valueAsTitle) control.title = node.title;
      for (const n of snapshot.nodes) if (n.parent === 'options') { n.selected = n.token === token; n.active = false; }
      snapshot.nodes.find(n => n.token === 'options').active = false; snapshot.domains.options.active = false;
    } else if (token === 'directory' || token === 'basename') {
      node.value = value;
      if (token === 'directory') snapshot.panel.directory = { path: value, identity: 'project-folder', kind: 'literal-local', resolved: true };
      else snapshot.panel.basename = value;
      snapshot.panel.destination = (snapshot.panel.directory.path === '/' ? '' : snapshot.panel.directory.path) + '/' + snapshot.panel.basename;
    } else if (token === 'opener') {
      const panel = save();
      snapshot.nodes.push(...panel.nodes.filter(n => n.token !== 'root'));
      snapshot.panel = panel.panel; snapshot.domains.panel = panel.domains.panel;
      snapshot.relations.push(...panel.relations); snapshot.panel.acquired = true;
    } else assert.fail('unexpected primitive target ' + token);
    snapshot.epoch++;
  }
  const entries = [['menu.open', 'edit', 'open-menu'], ['menu.expand', 'find', 'open-menu'],
    ['menu.direct', 'command', 'local-command'],
    ['menu.command', 'command', 'local-command'], ['choose.open', 'control', 'open-options'],
    ['choose.select', 'coast', 'local-value'], ['choose.select', 'coastal', 'local-value'],
    ['save.open', 'opener', 'open-save-panel'], ['save.directory', 'directory', 'prepare-field'],
    ['save.basename', 'basename', 'prepare-field']].map(([kind, token]) => createCompoundTransitionContract({
    id: `fixture.${kind}.${token}`, kind, token, controlToken: 'control',
    display: options.valueAsTitle ? 'value-as-title' : 'stable-title',
    dependentChanges: kind === 'choose.select' ? options.dependentChanges ?? [] : [],
    basis: 'Isolated deterministic fake control, no host capability.', qualifies: () => h.qualified,
  }));
  h.effectChecks = [];
  for (const entry of entries) {
    const effect = entry.effect;
    entry.effect = request => {
      const result = effect(request); h.effectChecks.push({ kind: entry.kind, ...result }); return result;
    };
  }
  h.entries = entries; h.contracts = createCompoundContracts(entries);
  h.evidence = new Map(entries.map(e => [e.kind + ':' + e.id.split('.').at(-1), e]));
  h.provider = {
    async inventory() { await h.phase('inventory'); return { complete: true, modals: structuredClone(h.snapshot.modals), panels: h.snapshot.panel ?
      [{ token: h.snapshot.panel.token, pid: h.snapshot.panel.pid, processStart: h.snapshot.panel.processStart,
        attachedTo: h.snapshot.panel.attachedTo, standard: h.snapshot.panel.standard,
        ownerProved: h.snapshot.relations.filter(r => r.kind === 'panel' && r.owner === 'root' && r.child === h.snapshot.panel.token).length === 1 }] : [] }; },
    async read() { await h.phase('read'); const value = structuredClone(h.snapshot); value.readId = (h.nextReadId ?? 1) + 1;
      h.nextReadId = value.readId;
      // Legacy cases exercise menus built on open. The fake app retains its
      // command, but the unopened AX hierarchy does not expose the leaf.
      if (operation === 'menu' && !options.unopened && value.domains.menu.container === 'bar')
        value.nodes = value.nodes.filter(n => n.token !== 'command');
      await h.phase('after-read'); return value; },
    async person() { await h.phase('person'); return { ...h.person, at: h.time, lastInput: h.lastInput, eventSequence: h.sequence }; },
    async resolveDelivered(ref) { await h.phase('resolve-delivered'); assert.deepEqual(ref, { readId: 1, element: 7 });
      return { ...structuredClone(h.node('control')), readId: 1 }; },
    async classify() { await h.phase('classify'); return h.classification; },
    async mechanism(token, kind) { await h.phase('mechanism'); return h.evidence.get(kind + ':' + token); },
    async perform(request) {
      await h.phase('perform'); assert.equal(h.fake, true); h.mutations.push(structuredClone(request));
      assert.ok(['press', 'write'].includes(request.primitive));
      assert.ok(!['commit', 'replace'].includes(request.node), 'Save and Replace are never dispatched');
      h.effects.push({ recipient: h.trueRecipient, effect: h.trueEffect });
      if (!h.suppressEffect) apply(h.snapshot, request.node, request.value);
      await h.phase('performed'); return { delivery: h.delivery ?? 'sent-unverified' };
    },
    async settle() { await h.phase('settle'); return h.settle ?? { settled: true, capped: false, busy: false, personTookOver: false }; },
    phase: h.phase,
    async retire() { await h.phase('retire'); return h.retired; },
  };
  // No fake can accidentally fall through to a real native implementation.
  for (const name of ['activate', 'AXRaise', 'AXMain', 'warpPointer', 'switchSpace', 'requestPermission',
    'capture', 'appleEvent', 'pasteboard', 'nativeMethod', 'rendererAuthority']) h.provider[name] = () => {
    h.forbiddenCalls++; if (name === 'pasteboard') h.clipboardAccesses++; assert.fail('forbidden capability ' + name);
  };
  const authority = createCompoundAuthoritySource(() => h.auth);
  h.authority = authority;
  h.admission = {
    async begin({ intent, execution }) { await h.phase('begin'); h.auth.boundIntent = intent; h.auth.lease.execution = execution; },
    current() { return authority.snapshot(); },
    consume() { h.calls.push('consume'); return h.auth.flow === true; },
    async authorizeRead() { await h.phase('authorize-read'); return !h.invalidated; },
    async admit({ witness }) { await h.phase('admit'); h.flowInputs ??= []; h.flowInputs.push({ kind: witness.kind, value: witness.value }); return true; },
    async observe({ observation }) { await h.phase('observe'); h.flowReads ??= []; h.flowReads.push(observation.readId); return true; },
    async acknowledge() { await h.phase('acknowledge'); return true; },
    invalidate() { h.invalidated = true; },
  };
  h.reservation = {
    async acquire() { await h.phase('reserve'); assert.equal(h.reservationHeld, false); h.reservationHeld = true; return {}; },
    validate() { return h.reservationHeld; },
    dispatched() { h.inFlight = true; }, acknowledged() { h.inFlight = false; },
    async release() { await h.phase('release'); assert.equal(h.retired, true); h.reservationHeld = false; h.inFlight = false; },
  };
  h.parent = createCompoundParent({ admission: h.admission, provider: h.provider, contracts: h.contracts,
    reservation: h.reservation, now: () => h.time, record: async phase => h.phase('record-' + phase), ...options.parent });
  h.run = () => h.parent.run(h.intent, { ...compoundTestBinding });
  h.change = fn => { fn(h); h.snapshot.epoch++; };
  return h;
}

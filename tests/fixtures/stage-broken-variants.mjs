// Each mutation changes runtime behavior. The parent requires an expected-behavior assertion failure.
export const STAGE_BROKEN_VARIANTS = Object.freeze({
  'visible-pointer-fade': s => s.replace('if !badgeApproach && stagePointRect(world.pointer, 40).intersects(next.box)', 'if false && !badgeApproach && stagePointRect(world.pointer, 40).intersects(next.box)'),
  'timeout-only-deletion': s => s.replace('if now >= carryUntil { carrying = false }', 'if now - lastFrame >= 30 { turnTargets = [] }; if now >= carryUntil { carrying = false }'),
  'count-only-eviction': s => s.replaceAll('collapseBusiest(); remember(target, key: key, epoch: epoch, contributor: c); return', 'turnTargets.removeFirst(); remember(target, key: key, epoch: epoch, contributor: c); return'),
  'completion-as-consumption': s => s.replace('guard state == "handback" || state == "done" && !ok else { return }', 'guard state == "handback" || state == "done" else { return }'),
  'missing-window-identity': s => s.replace('let same: (StageTarget) -> Bool = { $0.key == key && $0.epoch == epoch && !$0.outside }', 'let same: (StageTarget) -> Bool = { $0.epoch.bounds == epoch.bounds }'),
  'discarded-drag-typing-pins': s => s.replace('mutating func admitTargets(_ ev: PerchEvent, seq: Int, rect: CGRect?, world: StageWorld?, turnEnd: Bool) {',
    'mutating func admitTargets(_ ev: PerchEvent, seq: Int, rect: CGRect?, world: StageWorld?, turnEnd: Bool) { if ev.state == "drag" || ev.state == "type" { return }'),
  'dropped-admission-acknowledgement': s => s.replace('mutating func admitTargets(_ ev: PerchEvent, seq: Int, rect: CGRect?, world: StageWorld?, turnEnd: Bool) {',
    'mutating func admitTargets(_ ev: PerchEvent, seq: Int, rect: CGRect?, world: StageWorld?, turnEnd: Bool) { if ev.state == "click" || ev.state == "aim" { return }'),
  'accepting-old-turn-completion': s => s.replace('func handSequenceFresh(_ seq: Int, after last: Int) -> Bool { seq > last }',
    'func handSequenceFresh(_ seq: Int, after last: Int) -> Bool { seq >= 0 }'),
  'missing-capacity-hide': s => s.replaceAll('if targetCapacity { return hide("target-capacity", immediate: true) }', ''),
  'discarded-coalesced-contributor': s => s.replace('contributors.append(prior)', '_ = prior'),
  'bounds-as-content-generation': s => s.replace('epoch.content += 1;', 'epoch.content += 0;'),
});
export function breakStage(source, name) {
  const result = STAGE_BROKEN_VARIANTS[name]?.(source);
  if (!result || result === source) throw Error(`missing mutation site: ${name}`);
  return result;
}

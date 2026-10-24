// A bounded turn ledger. It never keeps page text, target labels, typed values or printable keys.
const ACTION = /^(?:click|pressKey|typeText|paste|setValue|scroll|drag|selectText|performSecondaryAction)$/;
const KEY = /^(?:Return|Enter|Escape|Tab|Space|Backspace|Delete|Page_Up|Page_Down|Up|Down|Left|Right)$/i;
// Match the tool's status lines, before its untrusted snapshot. Page prose is not an input status.
export function unconfirmedInput(content) {
  const text = (content ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n')
    .split(/^# (?:Snapshot |Changes since snapshot )/m)[0];
  return /^(?:Operation|Input) outcome (?:is )?unconfirmed[.;]/m.test(text) ||
    /^\d+ (?:click|type|press|select|check|uncheck|hover|scroll|drag|upload|dialog|navigate|back|forward|reload)(?: (?:f\d+)?e\d+| [sx]\d+)?: (?:effect unconfirmed;|submit unconfirmed after \d+ s;|tab closed; its submit is unconfirmed;)/m.test(text) ||
    /^(?:submit: |(?:f\d+)?e\d+: (?:failed: selection )?)unconfirmed\b/m.test(text);
}
export class TurnOutcomes {
  constructor() { this.reset(); }
  reset() { this.count = 0; this.unverified = 0; this.calls = 0; this.shown = 0; this.labels = []; }
  add(label, verified = false, count = 1) {
    this.count += count;
    if (verified) return;
    this.unverified += count;
    if (this.labels.length < 4) { this.labels.push(label + (count > 1 ? ` (${count})` : '')); this.shown += count; }
  }
  unknown(tool) {
    this.calls++;
    if (this.labels.length < 4) {
      this.labels.push(/^(?:browser_(?:act|fill|open|tabs)|menu_bar|notifications|drag|hover|open_file|replay)$/.test(tool) ? tool : 'input call');
      this.shown++;
    }
  }
  native(record) {
    for (const rec of Array.isArray(record?.outcomes) ? record.outcomes : []) {
      if (!rec || !ACTION.test(rec.a) || rec.x === 'refused') continue;
      const label = rec.a + (Number.isSafeInteger(rec.n) && rec.n >= 0 ? ' ' + rec.n : '') +
        (KEY.test(rec.k) ? ' ' + rec.k : '') + (rec.t?.s ? ' (secure field)' : '');
      // A changed window, focus, unrelated lines or a shared read cannot prove this action's intended effect.
      const verified = !rec.x && !rec.g && !rec.t?.s && Array.isArray(rec.f) && rec.f.some(f =>
        f?.o === 'value' && f.m === true || f?.o === 'state' && /^(?:checked|unchecked|selected|unselected|expanded|collapsed)$/.test(f.d));
      this.add(label, verified);
    }
    if (Number.isSafeInteger(record?.dropped) && record.dropped > 0) this.add('unrecorded actions', false, record.dropped);
  }
  text(pending = 0) {
    if (!this.unverified && !this.calls && !pending) return;
    const remaining = this.unverified + this.calls - this.shown;
    return 'sleight turn: ' + (this.count ? `${this.count} actions, ${this.unverified} unverified` : '') +
      (this.calls ? (this.count ? '; ' : '') + `${this.calls} input calls unverified` : '') +
      (this.labels.length ? ': ' + this.labels.join('; ') + (remaining > 0 ? `; ${remaining} more` : '') : '') +
      (pending ? `; ${pending} calls still pending` : '') + '.';
  }
}

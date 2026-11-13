// Specification-only counterexamples. Production exploration lives in strict-text-runtime.swift.
// Non-atomic specification fixture. Hooks are inside operations, precisely after
// the last observation and before destruction, rather than around a fake replace.
export class MicroBoard {
  constructor(bytes = 'O') { this.bytes = bytes; this.version = 40; this.writer = 'owner'; this.reads = 0; this.clears = 0; this.writes = 0; }
  read() { this.reads++; return { bytes: this.bytes, version: this.version, writer: this.writer }; }
  external(bytes) { this.bytes = bytes; this.version++; this.writer = `external:${this.version}`; }
  clear(afterCheck = () => {}) { afterCheck(); this.bytes = ''; this.version++; this.writer = 'legacy'; this.clears++; }
  write(bytes, fail = false) { this.writes++; if (fail) return false; this.bytes = bytes; this.writer = 'legacy'; return true; }
}
// Hypothetical complete conditional interface. It is not passed to production.
export class ConditionalBoard {
  constructor(bytes = 'O') { this.value = { bytes, version: 40 }; this.receipts = new Map(); }
  replaceIfVersion(version, bytes, id, { loseReply = false } = {}) {
    if (this.receipts.has(id)) return this.receipts.get(id);
    if (this.value.version !== version) return { conflict: true };
    this.value = { bytes, version: version + 1 };
    const receipt = { committed: true, version: this.value.version }; this.receipts.set(id, receipt);
    if (loseReply) throw Error('reply lost'); return receipt;
  }
}

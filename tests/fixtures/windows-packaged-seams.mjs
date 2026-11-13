import { createContext, runInContext } from 'node:vm';
import { body, native } from './windows-review-seams.mjs';

// Run production scan and lookup bodies with read-only Win32 providers. Only
// scalar C# declarations change; enumeration, bounds and classification stay.
export function packagedSeams(source = native('DriverInventory.cs')) {
  class Pids extends Set {
    Add(pid) { this.add(pid); }
    Contains(pid) { return this.has(pid); }
  }
  const context = createContext({
    packagedSnapshot: null,
    Lazy: class {
      constructor(scan) { this.scan = scan; }
      get Value() { if (this.scan) { const scan = this.scan; this.scan = null; this.value = scan(); } return this.value; }
    },
    PackagedProcesses: class {
      constructor() { this.Pids = new Pids(); this.PackageUnproved = new Pids(); this.Incomplete = false; }
      Fail(step) { this.Incomplete = true; this.FailureStep ??= step; }
    },
    String: { Equals: (a, b, mode) => mode === 0 ? a?.toLowerCase() === b?.toLowerCase() : a === b },
    StringComparison: { OrdinalIgnoreCase: 0, Ordinal: 1 },
  });
  const method = (signature, args) => runInContext(`(${args.join(',')}) => { ${body(source, signature)
    .replace(/\b(?:var|bool|int|uint|string) (\w+)\s*=/g, 'let $1 =')
    .replace(/new Lazy<PackagedProcesses>\(scan\)/g, 'new Lazy(scan)')} }`, context);
  context.ScanPackagedWindows = method('internal static PackagedProcesses ScanPackagedWindows(', ['api']);
  return {
    scan: context.ScanPackagedWindows,
    has: method('internal static bool HasPackagedWindow(uint target, PackagedApi api)', ['target', 'api']),
    snapshot: method('internal static T WithPackagedSnapshot<T>(Func<T> read, Func<PackagedProcesses> scan)', ['read', 'scan']),
  };
}

export function packagedFixture(rows, { complete = true } = {}) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const calls = [];
  const walk = (values, visit) => { for (const row of values) if (!visit(row.id)) return false; return true; };
  return { calls, api: {
    Windows(visit) { calls.push(['windows']); return walk(rows.filter(row => row.parent === undefined), visit) && complete; },
    Children(root, visit) { calls.push(['children', root]); walk(rows.filter(row => row.parent === root), visit); },
    Pid(id) { calls.push(['pid', id]); return byId.get(id)?.pid ?? 0; },
    ClassName(id) { calls.push(['class', id]); return byId.get(id)?.className ?? null; },
    Executable(id) { calls.push(['image', id]); return byId.get(id)?.image ?? 'Fixture.exe'; },
    Exists(id) { calls.push(['exists', id]); return byId.has(id) && byId.get(id).exists !== false; },
    PackageStatus(pid) { calls.push(['package', pid]); return rows.find(row => row.pid === pid && row.packageStatus !== undefined)?.packageStatus ?? 122; },
  } };
}

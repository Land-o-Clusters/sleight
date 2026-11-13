import assert from 'node:assert/strict';

// C# is compiled on Windows. This deliberately narrow source contract requires
// explicit review for any new native import, message route or dynamic API lookup.
const forbidden = /\b(?:SendInput|SetForegroundWindow|AttachThreadInput|SetFocus|BringWindowToTop|ShowWindow|SwitchToThisWindow|SetActiveWindow|LockSetForegroundWindow|keybd_event|mouse_event|SetCursorPos|SetWindowPos|SetWindowPlacement|ShowWindowAsync|OpenIcon|GetProcAddress|NativeLibrary|GetDelegateForFunctionPointer|DynamicInvoke|LibraryImport|DllImportAttribute)\b|\bAssembly\s*\.\s*Load\w*|\bProcess\s*\.\s*Start|\bSystem\s*\.\s*Windows\s*\.\s*Forms|\.\s*Slot\d+\s*\(/;
const imports = /\[DllImport\s*\(([^\]]+)\)\]\s*(?:(?:internal|public|private)\s+)?static\s+extern\s+\w+\s+(\w+)\s*\([^;]+;/g;
const stripComments = source => source.replace(/@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  token => token.startsWith('/*') || token.startsWith('//') ? token.replace(/[^\n]/g, ' ') : token);
const normalize = source => source.replace(/\s+/g, ' ').trim();

export function inspectDriverSource(file, source, allowed) {
  const code = stripComments(source);
  assert.doesNotMatch(code, forbidden, file);
  // Escaped identifiers and preprocessor-defined aliases cannot hide import names.
  assert.doesNotMatch(code.replace(/@?"(?:\\.|""|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""'), /\\[uU][0-9a-fA-F]|#\s*define|\busing\s+\w+\s*=/, file);
  const declarations = [...code.matchAll(imports)];
  assert.equal((code.match(/\bDllImport\b/g) ?? []).length, declarations.length, file + ': unparsed import');
  for (const match of declarations) {
    const entry = /\bEntryPoint\s*=\s*([^,)]*)/.exec(match[1]);
    const sequence = file === 'DriverClipboard.cs' && match[2] === 'Sequence' && entry?.[1].trim() === '"GetClipboardSequenceNumber"';
    if (entry && !sequence) assert.equal(entry[1].trim(), JSON.stringify(match[2]), file + ': literal entry point must equal method');
    assert.ok(allowed.includes(normalize(match[0])), file + ': unreviewed P/Invoke ' + match[2]);
  }
  if (file === 'DriverClipboard.cs') assert.deepEqual(declarations.map(match => normalize(match[0])), [
    '[DllImport("user32.dll", EntryPoint = "GetClipboardSequenceNumber", SetLastError = true)] static extern uint Sequence();',
    '[DllImport("kernel32.dll")] static extern void SetLastError(uint error);',
  ], 'only the counter read and thread-error reset are reviewed');
  // All sends are literal constants. Post's one variable forwarding site is
  // constrained by RequirePostMessage at runtime, including cleanup/retry paths.
  for (const match of code.matchAll(/\b((?:Post|Send)Message\w*)\s*\(([^;]+?);/g)) {
    if (/^\w+\s+hwnd\s*,\s*uint\s+message/.test(match[2])) continue; // The allowlisted extern declaration.
    if (match[1] === 'PostMessageW') {
      assert.equal(file, 'DriverInput.cs');
      assert.match(match[2], /^hwnd, message, new UIntPtr\(wParam\), lParam\)/);
    } else {
      assert.equal(match[1], 'SendMessageTimeoutW', file + ': unreviewed message API');
      const message = match[2].split(',')[1]?.trim();
      assert.ok(['0', '0x000c', '0x109'].includes(message), file + ': unreviewed send ' + message);
    }
  }
  if (file === 'DriverInput.cs') {
    assert.match(code, /bool validated, bool backpressure, bool idle, PostApi api\)\s*\{\s*RequirePostMessage\(message\);/);
    assert.match(code, /Identity = Check, Person = DriverPerson.Require, Idle = RequireIdle,\s*Send = NativePost/);
    assert.equal((code.match(/\bNativePost\b/g) ?? []).length, 2, 'only the guarded Post seam may use NativePost');
    const policy = /void RequirePostMessage\(uint message\)\s*\{([\s\S]*?)\n    \}/.exec(code)?.[1];
    assert.ok(policy, 'post allowlist missing');
    assert.deepEqual([...policy.matchAll(/case (0x[0-9a-f]+):/g)].map(m => m[1]),
      ['0x100', '0x101', '0x102', '0x103', '0x104', '0x105', '0x109', '0x200', '0x201', '0x202', '0x203', '0x204', '0x205', '0x20a', '0x20e']);
    assert.match(policy, /default: throw new DriverFault\("INVALID_MESSAGE"\);/);
    assert.equal((code.match(/\bPostMessageW\s*\(/g) ?? []).length, 2);
  }
  // Explicit Post call literals cannot introduce activation messages even though
  // the runtime guard would refuse them. Dynamic producers still pass that guard.
  for (const match of code.matchAll(/\bPost\([^,\n]+,[^,\n]+,\s*([^,\n]+),/g)) {
    const expression = match[1];
    if (expression.trim() === 'uint message') continue;
    if (['message', 'down', 'up'].includes(expression.trim())) continue;
    const constants = [...expression.matchAll(/\b0x[0-9a-f]+u?\b/g)].map(m => m[0].replace(/u$/, ''));
    assert.ok(constants.length, file + ': unreviewed Post expression ' + expression);
    for (const value of constants) assert.ok(['0x100', '0x101', '0x102', '0x103', '0x104', '0x105', '0x109',
      '0x200', '0x201', '0x202', '0x203', '0x204', '0x205', '0x20a', '0x20e'].includes(value), file + ': unreviewed Post ' + value);
  }
}

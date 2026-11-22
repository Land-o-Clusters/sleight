import { basename, isAbsolute } from 'node:path';

// ChatGPT 26.1117.41037 (its Codex cache .mcp.json, dated 2026-11-20) starts the engine through a shell that
// exports the variables Codex passes through, then execs node_repl:
//   /bin/sh -c 'export NAME="${NAME-}"; exec "$@"' cua-repl /Applications/ChatGPT.app/…/bin/node_repl
// Only that exact shape unwraps: one or more such exports, then `exec "$@"` and nothing else, a `$0` label and an
// absolute program. Any other shell launch keeps the plain handling, whose file checks fail on the inline script.
const EXEC_WRAPPER = /^(?:export ([A-Z_][A-Z0-9_]*)="\$\{\1-\}"; )+exec "\$@"$/;

export function shellExecWrapper(command, args) {
  if (command !== '/bin/sh' || !Array.isArray(args) || args.length < 4 || args.some(arg => typeof arg !== 'string')) return;
  const [flag, script, label, program, ...programArgs] = args;
  if (flag !== '-c' || !EXEC_WRAPPER.test(script) || !label || !isAbsolute(program)) return;
  return { shell: command, exports: [...script.matchAll(/export ([A-Z_][A-Z0-9_]*)=/g)].map(match => match[1]), label, program, programArgs };
}

// What a launch runs once its wrapper (if any) execs: the runtime and its arguments. `nodeRepl` marks a wrapped
// node_repl, which is the server itself (no script; its path replaces CUA_REPL_NODE_REPL_PATH). Readers use this;
// sessions still spawn the configured command and arguments.
export function unwrappedLaunch(command, args) {
  const wrapper = shellExecWrapper(command, args);
  if (!wrapper) return { runtime: command, args: Array.isArray(args) ? args : [] };
  return { wrapper, runtime: wrapper.program, args: wrapper.programArgs, nodeRepl: basename(wrapper.program) === 'node_repl' };
}

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOwned } from './preapproved-process.mjs';

export const PRIVATE_RUNTIME_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG',
      'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERM', 'NO_COLOR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN', 'BENCH_ROOT', 'BENCH_SUITE', 'SLEIGHT_APPROVAL_PROMPT', 'SLEIGHT_SURFACES']);
export const PRIVATE_LOGGING_OVERRIDES = Object.freeze({ CLAUDE_CODE_ENABLE_TELEMETRY: '0', DISABLE_TELEMETRY: '1',
      OTEL_LOG_RAW_API_BODIES: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '0',
      OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOGS_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none', ENABLE_BETA_TRACING_DETAILED: '0',
      SLEIGHT_TRACE: '', BENCH_HOOK_LOG: '' });
export function privateDriverEnvironment(inherited) {
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => PRIVATE_RUNTIME_KEYS.has(key))), ...PRIVATE_LOGGING_OVERRIDES };
}

export async function runDriver(command, args, { format = 'json', evidenceDir, privateMail = false, privatePolicyCheck, onPermissionRefusal, onStdout, ...options } = {}) {
  if (privateMail) options.env = privateDriverEnvironment(options.env ?? process.env);
  let buffer = '', refused = false;
  const response = await runOwned(command, args, { ...options, onStdout: data => {
    onStdout?.(data);
    if (format !== 'stream-json' || (!onPermissionRefusal && !privatePolicyCheck) || refused) return;
    buffer += String(data);
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (privateMail && event.type === 'system' && event.subtype === 'init') {
        try { privatePolicyCheck?.(); }
        catch { refused = true; onPermissionRefusal?.(); return; }
      }
      if (!Array.isArray(event.message?.content)) continue;
      for (const item of event.message.content) {
        if (item.type !== 'tool_result' || item.is_error !== true) continue;
        const text = typeof item.content === 'string' ? item.content :
          (Array.isArray(item.content) ? item.content.map(block => block.text ?? '').join('\n') : '');
        const browserRefusal = text.includes('Browser Use could not complete this action') && /permission request[^\n]*(dismissed|denied)/i.test(text);
        if (browserRefusal || /Computer Use is not allowed to use the app '[^']+' for safety reasons/.test(text) ||
          /Computer Use was not approved to use [^\n]+/.test(text) ||
          /The user (?:didn't allow|did not allow|did not approve)\b/.test(text) ||
          /^\s*(?:approval declined|permission denied|not approved)\s*$/i.test(text)) {
          refused = true; onPermissionRefusal?.(); return;
        }
      }
    }
  } });
  let out;
  try {
    out = format === 'stream-json'
      ? response.stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(event => event.type === 'result')
      : JSON.parse(response.stdout);
  } catch { out = undefined; }
  if (evidenceDir && !privateMail) writeFileSync(join(evidenceDir, 'transcript.jsonl'), response.stdout, { mode: 0o600 });
  return { code: response.exit.code, out, stderr: response.stderr.slice(-2000), groupClean: response.groupClean,
    timedOut: response.timedOut, cancelled: response.cancelled, spawnError: response.spawnError };
}

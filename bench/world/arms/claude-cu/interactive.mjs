import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { outsideGit, CLAUDE_VERSION, defaultArmRoot } from '../browser.mjs';
import { PRICES, runCost } from '../../../api-auth.mjs';
import { validateAllowedApps, validateAllowedGrants } from './permission.mjs';
import { VirtualTerminal } from './terminal.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
export function interactivePlan({ armDir = join(defaultArmRoot(), 'claude-cu'), workDir, prompt = '', model = 'claude-haiku-5-5',
  effort = 'high', sessionId = randomUUID(), timeoutMs = 300000, command, allowedApps = [], allowedGrants = [], hostEnv = process.env } = {}) {
  allowedApps = validateAllowedApps(allowedApps);
  allowedGrants = validateAllowedGrants(allowedGrants);
  armDir = resolve(armDir); outsideGit(armDir);
  if (existsSync(armDir) && lstatSync(armDir).isSymbolicLink()) throw new Error('arm root must not be a symlink');
  let parent = armDir;
  while (!existsSync(parent)) parent = dirname(parent);
  armDir = join(realpathSync(parent), relative(parent, armDir));
  if (!prompt || /[\x00-\x08\x0b-\x1f\x7f]/.test(prompt)) throw new Error('task prompt is empty or contains terminal control characters');
  if (/^\s*[!/]/.test(prompt)) throw new Error('interactive prompts must start with task text, not a CLI command');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('session ID must be a UUID');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeout must be positive');
  const cwd = workDir ? resolve(workDir) : join(armDir, 'work'), config = join(armDir, 'claude');
  outsideGit(cwd);
  const settingsFile = join(armDir, 'interactive-settings.json'), mcpFile = join(armDir, 'empty-mcp.json');
  const turnFile = join(armDir, `turn-${sessionId}.json`), debugFile = join(armDir, `debug-${sessionId}.log`), nonce = randomUUID();
  const accessFile = join(armDir, `access-${sessionId}.json`);
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'TERM'].filter(k => typeof hostEnv[k] === 'string').map(k => [k, hostEnv[k]]));
  Object.assign(env, { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', TERM: 'xterm-256color',
    CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF: '1', ANTHROPIC_SMALL_FAST_MODEL: model });
  Object.assign(env, { BENCH_CU_ACCESS_FILE: accessFile, BENCH_CU_TURN_RECEIPT: turnFile, BENCH_CU_SESSION: sessionId, BENCH_CU_NONCE: nonce,
    BENCH_CU_ALLOWED_APPS: JSON.stringify(allowedApps), BENCH_CU_ALLOWED_GRANTS: JSON.stringify(allowedGrants), BENCH_CU_CWD: cwd });
  return { armDir, cwd, prompt, model, effort, sessionId, timeoutMs, allowedApps, allowedGrants, env, settingsFile, mcpFile, turnFile, debugFile, accessFile, nonce,
    configFile: join(config, '.claude.json'), command: command ?? join(armDir, 'node_modules/.bin/claude'),
    args: ['--session-id', sessionId, '--model', model, '--effort', effort, '--no-chrome', '--setting-sources', '',
      '--settings', settingsFile, '--strict-mcp-config', '--mcp-config', mcpFile, '--tools', 'ToolSearch,WaitForMcpServers', '--disable-slash-commands',
      '--debug-file', debugFile],
    auth: 'isolated direct-plan login', version: CLAUDE_VERSION };
}

export function interactiveAgentSetup({ dir, prompt, model, effort, task, armDir, hostEnv = process.env } = {}) {
  const browser = { chrome: 'Google Chrome', helium: 'Helium', firefox: 'Firefox', safari: 'Safari' }[task?.browser];
  const allowedApps = task?.allowedApps ?? (task?.app ? [task.app] : browser ? [browser] : []);
  const plan = interactivePlan({ armDir, workDir: dir, prompt, model, effort, allowedApps, allowedGrants: task?.allowedGrants,
    timeoutMs: (task?.budgetSeconds ?? 600) * 1000, hostEnv });
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), '--run', '--parent-lock', '--arm-dir', plan.armDir,
    '--work-dir', plan.cwd, '--prompt', prompt, '--model', plan.model, '--effort', plan.effort, '--timeout-ms', String(plan.timeoutMs),
    '--allowed-apps', JSON.stringify(plan.allowedApps), '--allowed-grants', JSON.stringify(plan.allowedGrants)],
    prompt, env: plan.env, mcpConfig: null, metadata: { interactive: true, auth: plan.auth, claudeVersion: CLAUDE_VERSION } };
}

function ordinary(path) {
  for (let p = path; p !== dirname(p); p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('interactive arm paths must not be symlinks');
  }
}
export function prepareInteractive(plan) {
  outsideGit(plan.armDir); ordinary(plan.armDir); ordinary(plan.env.CLAUDE_CONFIG_DIR); ordinary(plan.configFile);
  ordinary(plan.cwd); ordinary(plan.settingsFile); ordinary(plan.mcpFile);
  ordinary(plan.turnFile);
  if (existsSync(join(plan.env.CLAUDE_CONFIG_DIR, '.config.json'))) throw new Error('legacy arm config needs owner migration before computer use');
  if (transcriptFiles(plan).length) throw new Error('interactive session transcript already exists');
  if (existsSync(plan.turnFile)) throw new Error('interactive session Stop receipt already exists');
  const config = existsSync(plan.configFile) ? JSON.parse(readFileSync(plan.configFile, 'utf8')) : {};
  if (config.cachedGrowthBookFeatures?.tengu_malort_pedway?.enabled !== true) throw new Error('cached computer-use feature is not enabled; owner must refresh the isolated arm login/cache');
  mkdirSync(plan.cwd, { recursive: true, mode: 0o700 }); mkdirSync(plan.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  config.projects ??= {};
  config.projects[plan.cwd] = { ...config.projects[plan.cwd], enabledMcpServers: ['computer-use'], hasTrustDialogAccepted: true };
  writeFileSync(plan.configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(plan.mcpFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  writeFileSync(plan.settingsFile, JSON.stringify({ autoMemoryEnabled: false,
    claudeMdExcludes: ['**', '**/.claude/**', '**/.claude/**/.*'],
    pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'managed-only' } } }, enabledPlugins: {},
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${fileURLToPath(new URL('./turn-ended.mjs', import.meta.url))}"`, timeout: 5 }] }],
      ...Object.fromEntries(['PermissionRequest', 'PreToolUse'].map(event => [event, [{ matcher: '.*', hooks: [{ type: 'command',
        command: `"${process.execPath}" "${fileURLToPath(new URL('./permission.mjs', import.meta.url))}"`, timeout: 5 }] }]])) } }), { mode: 0o600 });
}

function transcriptFiles(plan) {
  const projects = join(plan.env.CLAUDE_CONFIG_DIR, 'projects');
  ordinary(projects);
  if (!existsSync(projects)) return [];
  return readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory())
    .map(d => join(projects, d.name, `${plan.sessionId}.jsonl`)).filter(existsSync);
}

export class SessionTranscript {
  constructor(sessionId) { this.sessionId = sessionId; this.pending = ''; this.messages = new Map(); this.tools = new Set(); this.results = new Set(); this.answer = undefined; this.offset = 0; this.decoder = new StringDecoder('utf8'); }
  append(chunk) {
    this.pending += chunk;
    if (this.pending.length > 16000000) throw new Error('interactive transcript line exceeds 16 MB');
    let end;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.sessionId && event.sessionId !== this.sessionId || event.isSidechain || event.parent_tool_use_id) continue;
      const t = Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : Date.now();
      if (event.type === 'user' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) if (block.type === 'tool_result' && this.tools.has(block.tool_use_id) && !this.results.has(block.tool_use_id)) {
          this.results.add(block.tool_use_id);
          const content = Array.isArray(block.content) ? block.content.filter(c => c.type === 'text') : block.content;
          if (this.foreignPending?.delete(block.tool_use_id)) {
            const text = typeof content === 'string' ? content : (content ?? []).map(c => c.text).join('\n');
            if (!(block.is_error && /No such tool available/.test(text))) this.foreignTool = true;
          }
          this.onEvent?.({ type: 'user', t, message: { content: [{ ...block, content }] }, imagesOmitted: Array.isArray(block.content) && block.content.some(c => c.type === 'image') });
        }
      }
      if (event.type !== 'assistant' || !event.message?.id || !Array.isArray(event.message.content)) continue;
      const m = event.message, prior = this.messages.get(m.id) ?? { usage: {}, model: m.model };
      for (const [key, value] of Object.entries(m.usage ?? {})) if (typeof value === 'number') prior.usage[key] = Math.max(prior.usage[key] ?? 0, value);
      this.messages.set(m.id, prior);
      for (const block of m.content) {
        if (block.type === 'tool_use') {
          if (/request_access$/.test(block.name ?? '') && typeof block.input?.reason === 'string') this.accessReason = block.input.reason;
          if (!this.tools.has(block.id)) this.onEvent?.({ type: 'assistant', t, message: { id: m.id, content: [block], usage: m.usage } });
          this.tools.add(block.id);
          // Claude Code refuses a tool outside --tools with "No such tool available", and Claude carries on, as on every other arm
          // (textedit-calculator #2, 17:30Z: a refused Read stopped the run at 6.9 s). Only a foreign tool that ran, or whose
          // result doesn't arrive within 2 s, stops the harness.
          if (!/^(?:mcp__computer[-_]use__|ToolSearch$|WaitForMcpServers$)/.test(block.name ?? '') && !this.results.has(block.id))
            (this.foreignPending ??= new Map()).set(block.id, Date.now());
        }
        if (block.type === 'text') {
          this.lastText = block.text;
          const matches = [...block.text.matchAll(/^RESULT[^\r\n]*$/gm)];
          if (matches.length) this.answer = matches.at(-1)[0];
        }
      }
    }
  }
  update(plan) {
    if (!this.file) {
      const files = transcriptFiles(plan);
      if (files.length > 1) throw new Error('interactive transcript is ambiguous');
      this.file = files[0];
    }
    if (!this.file) return;
    ordinary(this.file);
    const size = statSync(this.file).size;
    if (size < this.offset) throw new Error('interactive transcript was replaced or truncated');
    const fd = openSync(this.file, 'r'), buffer = Buffer.alloc(65536);
    try {
      while (this.offset < size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!count) break;
        this.offset += count; this.append(this.decoder.write(buffer.subarray(0, count)));
      }
    } finally { closeSync(fd); }
  }
  summary() {
    const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, modelUsage = {};
    for (const m of this.messages.values()) {
      for (const key of Object.keys(usage)) usage[key] += m.usage[key] ?? 0;
      if (m.model) {
        const u = modelUsage[m.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
        for (const [key, source] of Object.entries({ inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadInputTokens: 'cache_read_input_tokens', cacheCreationInputTokens: 'cache_creation_input_tokens' })) u[key] += m.usage[source] ?? 0;
      }
    }
    return { answer: this.answer, lastText: this.lastText, accessReason: this.accessReason, calls: this.tools.size, modelCalls: this.messages.size, usage, modelUsage, foreignTool: !!this.foreignTool || [...(this.foreignPending?.values() ?? [])].some(at => Date.now() - at > 2000) };
  }
}

// The screen as the terminal shows it: a raw string is drawn on a fresh virtual terminal, the live session's terminal is read.
function terminalText(screen, prompt) {
  let text;
  if (typeof screen === 'string') { const term = new VirtualTerminal(); term.write(screen); text = term.render(); }
  else text = screen.render();
  if (prompt) {
    const pending = text.trim().replace(/^❯\s*/, '').replace(/\s+/g, ' ');
    const task = prompt.trim().replace(/\s+/g, ' ');
    if (pending && pending !== task && task.startsWith(pending)) return '';
    const index = text.indexOf(prompt.trim());
    if (index >= 0) text = text.slice(index + prompt.trim().length);
    else if (prompt.length < 4096) {
      const echo = prompt.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = new RegExp(echo).exec(text);
      if (match) text = text.slice(match.index + match[0].length);
    }
  }
  return text;
}

// Lines are compared with whitespace removed: the live 2.1.289 card draws some lines with no spaces between words
// ("Allowforthissession(1app)", 2026-10-17 15:23Z) and ends on a run of spaces rather than a newline.
const squeeze = text => text.replace(/\s+/g, '');
function sessionCard(text, allowedApps, allowedGrants = [], reason, requested) {
  const title = 'Computer Use wants to control these apps', index = text.lastIndexOf(title);
  if (index < 0) return;
  if (!/^[\s│]*$/.test(text.slice(text.lastIndexOf('\n', index) + 1, index)) ||
    !/^[\s│]*(?:\n|$)/.test(text.slice(index + title.length))) return { pending: true };
  // A boxed line before the apps is the request's own reason text, which grants nothing; any other line there refuses.
  const card = text.slice(index + title.length), rows = card.split('\n')
    .map(raw => ({ line: squeeze(raw.replace(/│/g, ' ')), boxed: /^\s*│/.test(raw) }))
    .filter(row => row.line && !/^[─╭╮╰╯]+$/.test(row.line)), lines = rows.map(row => row.line);
  const allow = lines.findIndex(line => /^(?:❯)?Allowforthissession\(\d+apps?\)$/.test(line));
  if (allow < 0 || !/\n\s*$/.test(card)) return { pending: true };
  const deny = lines.findIndex(line => /^(?:❯)?Deny,andtellClaudewhattododifferently\(esc\)$/.test(line));
  const allowed = new Map(allowedApps.map(app => [squeeze(app), app]));
  const names = [], selected = [];
  let appSection = false, flags = false;
  const above = [];
  for (const [i, line] of lines.slice(0, deny < 0 ? allow : deny).entries()) {
    const app = /^([●◉○✔✓])(.+?)(?:\((alreadygranted|notinstalled)\))?$/.exec(line);
    // The reason Claude sent with request_access, drawn above the apps (boxed or not, wrapped across lines): it grants nothing.
    // Unboxed lines there must join, in order, into exactly that reason; anything else refuses.
    if (!appSection && rows[i].boxed) continue;
    if (!appSection && !app) { above.push(line); continue; }
    if (!appSection && above.length && (!reason || above.join('') !== squeeze(reason))) return { blocked: 'unsupported computer-use approval card' };
    if (app && !flags) { appSection = true; names.push(app[2]); if (app[1] === '●' || app[1] === '◉') selected.push(app[2]); }
    else if (appSection && line === 'Alsorequested:' && !flags) flags = true;
    else if (flags && /^·(?:clipboardRead|clipboardWrite|systemKeyCombos)$/.test(line)) {
      if (!allowedGrants.includes(line.slice(1))) return { blocked: 'computer-use approval grant is outside the task allowlist' };
    } else if (appSection && /^\d+otherapps?willbehiddenwhileClaudeworks\.$/.test(line)) continue;
    else if (appSection && /^⚠(?:equivalenttoshellaccess|canread\/writeanyfile|canchangesystemsettings)$/.test(line)) {
      const grant = { '⚠equivalenttoshellaccess': 'shellAccess', '⚠canread/writeanyfile': 'fileAccess', '⚠canchangesystemsettings': 'systemSettings' }[line];
      if (!allowedGrants.includes(grant)) return { blocked: 'computer-use approval grant is outside the task allowlist' };
    } else return { blocked: 'unsupported computer-use approval card' };
  }
  if (!appSection && above.length) return { blocked: 'unsupported computer-use approval card' };
  // When the hook recorded the request, the card must name exactly the apps Claude asked for.
  if (Array.isArray(requested) && requested.some(app => typeof app !== 'string')) return { blocked: 'unsupported computer-use approval card' };
  if (Array.isArray(requested) && names.some(name => !requested.map(squeeze).includes(name) && !requested.map(app => squeeze(allowed.get(squeeze(app)) ?? app)).includes(name)))
    return { blocked: 'computer-use approval is outside the task allowlist or unsupported' };
  const count = Number(/\((\d+)apps?\)$/.exec(lines[allow])[1]);
  if (deny < 0 || allow !== deny + 1 || !names.length || !count || count !== selected.length ||
    new Set(names).size !== names.length || names.some(app => !allowed.has(app)) ||
    /notshown/.test(squeeze(card)) || lines.slice(allow + 1).filter(line => line !== '⏺').some(line => line !== 'Entertoconfirm·Esctocancel'))
    return { blocked: 'computer-use approval is outside the task allowlist or unsupported' };
  const cursors = lines.filter(line => line.startsWith('❯'));
  if (cursors.length !== 1) return { blocked: 'computer-use approval selection is ambiguous' };
  if (lines[allow].startsWith('❯')) return { answer: '\r' };
  // Down and Enter go in one write: Claude Code's select resets to Deny on a re-render within milliseconds of a lone Down (live
  // 15:47 and 15:51Z). With two options, Enter after a reset lands on Deny, so the worst case is a refusal.
  if (lines[deny].startsWith('❯')) return { answer: '\x1b[B\r' };
  return { blocked: 'computer-use approval selection is ambiguous' };
}

export function terminalGate(raw, prompt) { return textGate(terminalText(raw, prompt)); }
function textGate(text) {
  // A dialog draws instead of Claude Code's idle input box (a bare ❯ line with a rule under it), so text above the last such box
  // is Claude's own prose, which can say "try again" or "Enter to confirm" (live 15:55Z).
  const box = [...text.matchAll(/(?:^|\n)[^\S\n]*❯[^\S\n]*(?:Try[^\S\n]*"[^"\n]*"[^\S\n]*)?\n[^\S\n]*─{4,}[^\n]*(?=\n|$)/g)].at(-1);
  const tail = box ? text.slice(box.index + box[0].length) : text;
  const blocked = /Allow for this session|Allow computer use|Allow .*to (?:use|control)|permission.*(?:allow|approve)|Grant Accessibility|Screen Recording|Try again|Enter to (?:confirm|select)|Do you want to (?:allow|proceed|use)/i.test(tail) ? 'approval required'
    : /Do you trust|Trust this folder|trust the files/i.test(tail) ? 'workspace trust required'
    : /(?:^|\n)\s*(?:Sign in to Claude|Log in to Claude|(?:Select |Choose (?:a |your )?)?login method|Pro or Max plan)\s*(?:$|\n|[.:])/i.test(tail) ? 'direct-plan login required' : undefined;
  return { blocked, ready: !blocked && /(?:^|\n)[^\S\n]*❯[^\S\n]*(?:Try[^\S\n]*"[^"\n]*"[^\S\n]*)?(?:\n|$)/.test(text) };
}

export function verifyInteractiveCLI(plan) {
  const version = execFileSync(plan.command, ['--version'], { env: plan.env, encoding: 'utf8', timeout: 10000 }).trim();
  if (version !== `${CLAUDE_VERSION} (Claude Code)`) throw new Error(`interactive arm requires Claude Code ${CLAUDE_VERSION}`);
}
export function launchPty(plan, onOutput, { onSpawn } = {}) {
  const bridge = fileURLToPath(new URL('./pty-bridge.py', import.meta.url));
  const child = spawn('/usr/bin/python3', [bridge, '/usr/bin/script', '-q', '/dev/null', plan.command, ...plan.args],
    { cwd: plan.cwd, env: plan.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let cleanupReceipt = '';
  child.stdout.on('data', data => onOutput(data.toString()));
  child.stderr.on('data', data => { cleanupReceipt = (cleanupReceipt + data).slice(-4096); onOutput(data.toString()); });
  let timer, spawnError;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error.code; });
    child.once('close', code => {
      clearTimeout(timer);
      child.stdin.destroy(); resolve({ code, clean: !spawnError && cleanupReceipt.includes('[sleight-cu-cleanup:ok]') });
    });
  });
  const control = { closed, write: text => child.stdin.write(text), stop: async () => {
    child.stdin.write('\x03'); child.stdin.end();
    timer = setTimeout(() => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 1000);
    await Promise.race([closed, wait(5500)]);
  } };
  if (child.pid) {
    try { onSpawn?.(child.pid); } catch { void control.stop(); }
  }
  return control;
}

// The connect line is logged before the client joins app state, and the turn-1 request takes its tools from that state, so the
// task waits a moment past it. Tool search stays at Claude Code's default (CU2, 2026-10-17: with it off the request had no tools).
export function defaultServerReady(p, settleMs = 2500) {
  if (!p.debugFile || !existsSync(p.debugFile)) return false;
  const line = /^(\S+) \[DEBUG\] MCP server "computer-use": Successfully connected/m.exec(readFileSync(p.debugFile, 'utf8'));
  return !!line && Date.now() - Date.parse(line[1]) >= settleMs;
}

export async function runInteractive(plan, { dryRun = false, prepare = prepareInteractive, verify = verifyInteractiveCLI,
  launch = launchPty, transcript = new SessionTranscript(plan.sessionId), turnEnded = p => {
    if (!existsSync(p.turnFile)) return false;
    ordinary(p.turnFile); const receipt = JSON.parse(readFileSync(p.turnFile, 'utf8'));
    return receipt.sessionId === p.sessionId && receipt.nonce === p.nonce;
  }, serverReady = defaultServerReady,
  connectMs = 15000, pollMs = 100, signal, onSpawn, onEvent } = {}) {
  if (dryRun) return { dryRun: true, plan };
  if (signal?.aborted) return { type: 'result', is_error: true, result: '', reason: 'cancelled', duration_ms: 0, groupClean: true };
  const start = Date.now(); prepare(plan); verify(plan);
  if (signal?.aborted) return { type: 'result', is_error: true, result: '', reason: 'cancelled', duration_ms: Date.now() - start, groupClean: true };
  if (onEvent) transcript.onEvent = onEvent;
  const screen = new VirtualTerminal();
  let tail = '', closed, sent = false, exiting = false, reason, timedOut = false, gateBlocked, approvalBlock, pendingAt, keyRender, lastKey;
  const approvalWaitMs = Math.min(1000, plan.timeoutMs / 2);
  const block = (why, text) => {
    gateBlocked = true; reason = why;
    // Only the card (or the screen's last lines), never the session banner with the account's name and email above it.
    const at = text.lastIndexOf('Computer Use wants to control these apps');
    const shown = at >= 0 ? text.slice(at) : text.split('\n').slice(-20).join('\n');
    const scrubbed = value => value.replaceAll(homedir(), '~').replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
    // The raw tail (escapes kept) shows how the terminal redrew the card, for parser fixes.
    approvalBlock = { reason: why, cardText: scrubbed(shown), rawTail: JSON.stringify(scrubbed(tail)) };
    onEvent?.({ type: 'approval_block', ...approvalBlock });
  };
  // Output is drawn as it arrives, so a redraw overwrites the card in place and the parser sees the whole updated card.
  let agentStartAt, agentEndAt;
  const pty = launch(plan, data => { screen.write(data); tail = (tail + data).slice(-4000); }, { onSpawn });
  pty.closed.then(result => { closed = result; });
  try {
    for (;;) {
      transcript.update?.(plan);
      const state = transcript.summary(), text = terminalText(screen, sent ? plan.prompt : undefined), gate = textGate(text);
      if (state.foreignTool) { reason = 'foreign tool observed'; break; }
      if (signal?.aborted) { reason = 'cancelled'; break; }
      if (closed) { if (!exiting) reason = 'session exited before confirmed RESULT and idle prompt'; break; }
      if (pendingAt !== undefined && Date.now() - pendingAt >= approvalWaitMs) {
        block(keyRender !== undefined ? 'computer-use approval did not render a fresh selection' : 'unsupported or incomplete computer-use approval card', text || keyRender); break;
      }
      if (Date.now() - start >= plan.timeoutMs) {
        if (pendingAt !== undefined) block('unsupported or incomplete computer-use approval card', text || keyRender);
        else { timedOut = true; reason = 'interactive task timeout'; }
        break;
      }
      if (sent && !exiting && !/Grant Accessibility|Screen Recording|Do you trust|Trust this folder|Sign in to Claude/i.test(text)) {
        const render = text.slice(Math.max(0, text.lastIndexOf('Computer Use wants to control these apps'))).trim();
        if (keyRender !== undefined && (!render || render === keyRender)) { await wait(pollMs); continue; }
        let access;
        try { access = plan.accessFile && existsSync(plan.accessFile) ? JSON.parse(readFileSync(plan.accessFile, 'utf8')) : undefined; } catch {}
        const card = sessionCard(text, plan.allowedApps, plan.allowedGrants, access?.reason ?? state.accessReason, access?.apps);
        if (card?.blocked) { block(card.blocked, text); break; }
        // A frame that changed elsewhere (the ⏺ line) can arrive before the redraw a key causes: never send one key twice in a row.
        if (card?.answer && card.answer === lastKey) { await wait(pollMs); continue; }
        if (card?.answer) { pendingAt = Date.now(); keyRender = render; lastKey = card.answer; pty.write(card.answer); await wait(pollMs); continue; }
        if (card?.pending) { pendingAt ??= Date.now(); await wait(pollMs); continue; }
        pendingAt = undefined; keyRender = undefined; lastKey = undefined;
      }
      if (gate.blocked) { block(gate.blocked, text); break; }
      if (!sent && gate.ready && !serverReady(plan)) {
        if (Date.now() - start > connectMs) { reason = 'computer-use server did not connect'; break; }
      } else if (!sent && gate.ready) { sent = true; agentStartAt = Date.now(); pty.write('\x1b[200~' + plan.prompt + '\x1b[201~\r'); }
      else if (sent && (state.answer ?? state.lastText) !== undefined && gate.ready && turnEnded(plan) && !exiting) {
        agentEndAt = Date.now();
        exiting = true; pty.write('\x04'); await wait(50);
        if (!closed) pty.write('\x04');
      }
      await wait(pollMs);
    }
  } catch (error) { reason = error.message; }
  finally { if (!closed) { await pty.stop(); closed = await Promise.race([pty.closed, wait(100).then(() => undefined)]); } }
  const state = transcript.summary(), clean = !reason && closed?.clean === true && closed.code === 0;
  const priced = Object.keys(state.modelUsage).length && Object.keys(state.modelUsage).every(m => PRICES[m]);
  return { type: 'result', subtype: clean ? 'success' : 'error', is_error: !clean, result: state.answer ?? state.lastText ?? '',
    duration_ms: Date.now() - start, num_turns: state.modelCalls, calls: state.calls, usage: state.usage, modelUsage: state.modelUsage,
    agentSeconds: agentEndAt === undefined ? null : (agentEndAt - agentStartAt) / 1000,
    agentTiming: { start: 'ready-prompt-and-mcp-submit', end: 'result-and-idle', startupIncluded: false },
    ...(priced && { total_cost_usd: runCost({ modelUsage: state.modelUsage }) }), groupClean: closed?.clean === true, timedOut,
    ...(gateBlocked && { gateBlocked, approvalBlock }),
    ...(reason && { reason }), requestedModel: plan.model, effort: plan.effort, session_id: plan.sessionId, auth: plan.auth };
}

async function main() {
  try {
    const options = {}, args = process.argv.slice(2); let live = false, dryRun = false, parentLock = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--run') live = true;
      else if (args[i] === '--dry-run') dryRun = true;
      else if (args[i] === '--parent-lock') parentLock = true;
      else if (['--arm-dir', '--work-dir', '--prompt', '--prompt-file', '--model', '--effort', '--timeout-ms', '--allowed-apps', '--allowed-grants'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
        const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); options[key] = args[++i];
      } else throw new Error('unknown or incomplete interactive option');
    }
    if (live && dryRun) throw new Error('choose --run or --dry-run');
    const { promptFile, ...rest } = options;
    if (promptFile && rest.prompt) throw new Error('choose prompt or prompt-file');
    const plan = interactivePlan({ ...rest, ...(rest.allowedApps && { allowedApps: JSON.parse(rest.allowedApps) }),
      ...(rest.allowedGrants && { allowedGrants: JSON.parse(rest.allowedGrants) }),
      ...(rest.timeoutMs && { timeoutMs: Number(rest.timeoutMs) }), prompt: promptFile ? readFileSync(promptFile, 'utf8') : rest.prompt });
    const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    let release, result;
    try {
      if (live) {
        if (existsSync('/tmp/sleight-hold')) throw new Error('timed window is held');
        if (parentLock) {
          if (!existsSync('/tmp/sleight-live.lock') || !statSync('/tmp/sleight-live.lock').isDirectory()) throw new Error('parent benchmark lock is absent');
        } else release = await (await import('../../../live-lock.mjs')).acquireLiveLock();
      }
      result = await runInteractive(plan, { dryRun: !live, signal: controller.signal, onEvent: event => process.stdout.write(JSON.stringify(event) + '\n') });
      console.log(JSON.stringify(result)); if (live && result.is_error) process.exitCode = 1;
    } finally {
      if (release && (!result || result.groupClean)) await release();
      else if (release) console.error('interactive cleanup is unverified; retain the live lock for sleight-arch');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

#!/usr/bin/env node
// What sleight adds to a Claude Code session's start. Times `claude -p` on a one-word task with and without sleight
// (its MCP server and its plugin folder, as bench/fowl/rounds.sh loads them), alternating arms. No tool is called, so
// nothing is driven. Haiku on the API key (LAWS), from a folder outside any git repo, without the host's CLAUDE* env.
// Usage: node bench/fowl/startup-probe.mjs [--runs 5] [--arms bare,mcp,plugin,both]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleightPluginLaunch } from '../sleight-plugin-launch.mjs';

export function startupProbePlan({ arm, repo, mcp, empty, settings, env }) {
  if (!['bare', 'mcp', 'plugin', 'both'].includes(arm)) throw new Error('Unknown startup probe arm');
  const plugin = arm === 'plugin' || arm === 'both';
  const plan = { env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    mcpConfig: { mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp') } } },
    settingsOverrides: { enabledPlugins: { 'sleight@sleight': false } },
    args: ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--no-chrome',
      '--mcp-config', arm === 'mcp' || arm === 'both' ? mcp : empty, '--settings', settings,
      ...(plugin ? ['--plugin-dir', join(repo, 'plugins/sleight')] : [])] };
  return plugin ? sleightPluginLaunch(plan) : plan;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
  const runs = Number(args.runs || 5);
  const arms = (args.arms || 'bare,mcp,plugin,both').split(',');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const key = readFileSync(join(homedir(), '.config/sleight-bench/anthropic-api-key'), 'utf8').trim();
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))), ANTHROPIC_API_KEY: key };
  const dir = mkdtempSync(join(tmpdir(), 'sleight-startup-'));
  const mcp = join(dir, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { 'plugin:sleight:computer': { command: join(repo, 'plugins/sleight/bin/sleight-mcp'), env: { SLEIGHT_SURFACES: 'browser,computer', SLEIGHT_HAND: '0' } } } }));
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, JSON.stringify({ mcpServers: {} }));
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'sleight@sleight': false } }));

  function once(arm) {
    const launch = startupProbePlan({ arm, repo, mcp, empty, settings, env });
    return new Promise((resolve) => {
      const t0 = performance.now(); const at = {}; let buf = '';
      const child = spawn('claude', [...launch.args, 'Reply with the single word OK.'], { cwd: dir, env: launch.env, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let e; try { e = JSON.parse(line); } catch { continue; }
          const now = performance.now() - t0;
          if (e.type === 'system' && e.subtype === 'init') at.init ??= now;
          if (e.type === 'assistant') at.first ??= now;
          if (e.type === 'result') { at.result = now; at.cost = e.total_cost_usd; at.inTokens = (e.usage?.cache_creation_input_tokens || 0) + (e.usage?.cache_read_input_tokens || 0) + (e.usage?.input_tokens || 0); }
        }
      });
      child.on('close', () => resolve({ ...at, exit: performance.now() - t0 }));
    });
  }

  const results = Object.fromEntries(arms.map((a) => [a, []]));
  for (let i = 0; i < runs; i++) for (const arm of arms) results[arm].push(await once(arm));
  const med = (l) => { const s = [...l].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  for (const arm of arms) {
    const r = results[arm];
    const m = (k) => Math.round(med(r.map((x) => x[k] ?? NaN)));
    console.log(`${arm.padEnd(7)} median ms: init ${m('init')}, first message ${m('first')}, result ${m('result')}, exit ${m('exit')}; prompt tokens ${m('inTokens')}; cost $${r.reduce((s, x) => s + (x.cost || 0), 0).toFixed(4)} for ${r.length}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

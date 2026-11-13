#!/usr/bin/env node
// Elicitation hook for benchmark runs only. The decision is also used by the model-free speed map.
import { BENCH_APPS, REAL_APPS, getTasks } from './tasks.mjs';
import { worldPassApps } from './world/tasks.mjs';
import { approvedApps, tasks as batteryTasks } from './battery/tasks.mjs';
import { speedPlan } from './app-speed-map.mjs';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function worldApps(env) {
  try {
    const ids = JSON.parse(env.BENCH_WORLD_TASKS ?? '[]');
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) return [];
    const tasks = getTasks('world');
    if (ids.some(id => !tasks.some(task => task.id === id))) return [];
    return worldPassApps(tasks.filter(task => ids.includes(task.id)));
  } catch { return []; }
}

export function benchmarkDecision(e, env = process.env) {
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(e.message ?? '')?.[1] ??
    /^Allow Claude to (?:drag|hover|open files) in (.+?)\? /.exec(e.message ?? '')?.[1] ??
    /^Allow Claude to use (.+)'s menu bar item\?$/.exec(e.message ?? '')?.[1] ??
    /^Allow Claude to select a window in (.+?)\? /.exec(e.message ?? '')?.[1];
  const generic = Boolean(env.BENCH_ARM_SERVERS);
  const servers = generic ? JSON.parse(env.BENCH_ARM_SERVERS) : ['plugin:sleight:computer', 'lcu'];
  // iPhone Mirroring stays on the owner's real-suite, owner-present boundary.
  const ownerPresentApps = ['iPhone Mirroring', 'com.apple.ScreenContinuity'];
  const speedApps = env.BENCH_SUITE === 'app-speed-map' ? speedPlan({ ownerPresent: env.BENCH_OWNER_PRESENT === '1' }).apps
    .flatMap(app => [app.app, app.bundle, ...(batteryTasks.find(task => task.bundle === app.bundle)?.aliases ?? [])]) : undefined;
  // The real-window browser race (bench/fowl/real-gate.mjs) names its round's apps; only those on the allowlist count.
  const raceApps = env.BENCH_SUITE === 'browser-race' ? (() => {
    try { return JSON.parse(env.BENCH_RACE_APPS ?? '[]').filter(app => [...BENCH_APPS, ...REAL_APPS].includes(app)); } catch { return []; }
  })() : undefined;
  const apps = speedApps ?? raceApps ?? (env.BENCH_SUITE === 'world' ? worldApps(env) : env.BENCH_SUITE === 'battery' ? approvedApps(env.BENCH_OWNER_PRESENT === '1') :
    [...BENCH_APPS, ...(env.BENCH_SUITE === 'real' ? REAL_APPS : []),
    ...(env.BENCH_SUITE === 'real' && env.BENCH_OWNER_PRESENT === '1' ? ownerPresentApps : [])]);
  const choices = e.requested_schema?.properties?.choice?.enum ?? [];
  const supported = (!choices.length || choices.includes('session') || choices.includes('once')) &&
    (!generic || (e.requested_schema?.required ?? []).every(key => key === 'choice' && choices.length));
  if (servers.includes(e.mcp_server_name) && apps.includes(app) && supported && e.mode !== 'url') {
    const content = choices.length ? { choice: choices.includes('session') ? 'session' : 'once' } : {};
    return { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content } };
  }
  if (generic) return { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  if (process.env.BENCH_HOOK_LOG) appendFileSync(process.env.BENCH_HOOK_LOG, JSON.stringify(event) + '\n');
  const decision = benchmarkDecision(event);
  if (decision?.hookSpecificOutput.action === 'decline' && process.env.BENCH_APPROVAL_STOP) writeFileSync(process.env.BENCH_APPROVAL_STOP,
    'unsupported approval: elicitation is outside the benchmark app allowlist or uses an unsupported form\n', { mode: 0o600 });
  if (decision) process.stdout.write(JSON.stringify(decision));
}

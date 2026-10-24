// Offline source audit. No runner, fixture setup, app inspection or model command executes here.
import { createReadStream, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readValidationData, validationDataDir } from './data.mjs';
import { ROOT, EVIDENCE, git, source, harness, sha } from './audit-140.mjs';

// Historical audits retain the runner recorded by their pinned B build.
export function fowlRunnerReference(suite) {
  const commit = suite?.provenance?.fowlbrowser?.commit;
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Missing FowlBrowser commit provenance');
  return `FowlBrowser@${commit}/tools/rounds.mjs`;
}

export async function classify({ data } = {}) {
  const auditPath = join(validationDataDir(data), 'validation-140-a.json');
  const audit = readValidationData('validation-140-a.json', data);
  const bBuild = audit.bBuild;
  const paths = new Set(git('ls-tree', '-r', '--name-only', bBuild).trim().split('\n'));
  const cache = new Map();
  const pinnedSources = new Map();
  const pinned = (build, path) => {
    const key = `${build}:${path}`;
    if (!pinnedSources.has(key)) pinnedSources.set(key, source(build, path));
    return pinnedSources.get(key);
  };
  const text = path => {
    if (!cache.has(path)) cache.set(path, source(bBuild, path));
    return cache.get(path);
  };
  const lineAt = (body, index) => body.slice(0, index).split('\n').length;
  const external = fowlRunnerReference(JSON.parse(text('bench/world/suite.json')));

  // Non-import edges were reviewed at the pinned B source. Branches name the selector that executes them.
  const extra = [
    ['bench/fowl/rounds.sh', 'bench/fowl/accounting.mjs', 'MODEL=$(node', 'browser'],
    ['bench/fowl/rounds.sh', 'bench/fowl/sleight-surface.patch', 'git apply', 'browser'],
    ['bench/fowl/rounds.sh', external, 'node tools/rounds.mjs', 'browser'],
    [external, 'bench/fowl/real-gate.mjs', "bench/fowl/real-gate.mjs", 'browser'],
    ['bench/fowl/real-gate.mjs', 'bench/world/tasks/fowlbrowser.json', 'currentAnswerGraders()', 'browser'],
    ['bench/fowl/real-gate.mjs', 'bench/world/tasks/browser-open-heldout.json', 'args.tasks', 'as3'],
    ['bench/fowl/real-gate-setup.mjs', 'bench/fowl/origin-hook.mjs', "bench/fowl/origin-hook.mjs", 'browser'],
    ['bench/fowl/window-cover.mjs', 'bench/fowl/window-cover.swift', './window-cover.swift', 'browser'],
    ['bench/fowl/safari-browser.mjs', 'bench/fowl/safari-helper.swift', './safari-helper.swift', 'safari'],
    ['bench/turbo/setup.mjs', 'bench/turbo/v3-server.mjs', 'bench/turbo/v3-server.mjs', 'chrome'],
    ['bench/turbo/v3-session.mjs', 'bench/turbo/v3-worker.mjs', './v3-worker.mjs', 'chrome'],
    ['bench/real-fixture.mjs', 'bench/real-fixture.js', './real-fixture.js', 'native'],
  ];

  function traceProfile(id, { native = false, browser, as3 = false }) {
    const root = native ? 'bench/run.mjs' : 'bench/fowl/rounds.sh';
    const active = condition => condition === 'browser' ? !native : condition === 'native' ? native : condition === 'as3' ? as3 : browser === condition;
    const edges = [], excluded = [];
    const traces = new Map([[root, [root]]]);
    for (const [path, trace] of traces) {
      if (!paths.has(path) && path !== external) continue;
      const body = path === external ? text('bench/fowl/sleight-surface.patch') : text(path);
      const candidates = [];
      if (/\.(mjs|js)$/.test(path) && path !== external) {
        // Literal module edges, with source location. Conditional dynamic imports are listed separately below.
        for (const m of body.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
          const to = posix.normalize(posix.join(posix.dirname(path), m[1]));
          if (paths.has(to)) candidates.push({ from: path, to, line: lineAt(body, m.index), kind: 'module' });
        }
      }
      for (const [from, to, needle, condition] of extra) if (from === path) {
        const index = body.indexOf(needle);
        if (index < 0) throw Error(`Missing reviewed execution edge ${from} -> ${to}`);
        const edge = { from, to, line: lineAt(body, index), kind: 'child/data', condition };
        if (active(condition)) candidates.push(edge); else excluded.push({ ...edge, reason: `${condition} branch not selected` });
      }
      for (const edge of candidates) {
        // --suite world never enters the battery runner. The CC and Electron task factories are imported to build
        // the catalog, but their setup/check functions do not run for the ten historical native task ids.
        const reason = edge.to === 'bench/battery/run.mjs' ? '--suite world, not battery'
          : native && edge.to === 'bench/world/cc-held-out.mjs' ? 'getTasks(world) builds CC entries; selectSuiteTasks retains only the ten historical native ids, never their fixtures'
          : native && ['bench/tasks-electron.mjs', 'bench/tasks-iphone.mjs'].includes(edge.to) ? 'tasks-real imports these catalog definitions; selected native ids contain no Electron or iPhone task'
          : !native && edge.to === 'bench/turbo/setup.mjs' && browser !== 'chrome' ? 'realAgentSetup selects the engine arm, not kind sleight-turbo'
          : null;
        if (reason) { excluded.push({ ...edge, reason }); continue; }
        edges.push(edge);
        if (!traces.has(edge.to)) traces.set(edge.to, [...trace, edge.to]);
      }
    }
    const changed = [...new Set(audit.rounds.flatMap(r => r.changedHarnessFiles))];
    const files = Object.fromEntries(changed.map(path => {
      const trace = traces.get(path);
      return [path, trace ? { classification: 'RUNS-THE-TASK', trace }
        : { classification: 'NOT', trace: [root, `closure:${id}`],
          reason: `No selected import, require, data or child edge reaches ${path}. See this profile's edges and excluded boundaries.` }];
    }));
    return { entry: root, selector: { native, browser, as3 }, files, edges, excluded,
      externalSources: native ? [] : [{ path: external, source: 'bench/fowl/sleight-surface.patch',
        trace: 'rounds.sh applies this pinned patch before tools/rounds.mjs; its real-browser dispatch imports real-gate.mjs',
        fixtureRoots: ['FowlBrowser/test/forms/server.mjs', 'FowlBrowser/test/demo/server.mjs'],
        fixtureTrace: 'real-gate.startGateSites(mcpRoot) -> real-gate-sites.startGateForms(mcpRoot/test/forms) -> server.mjs; import(mcpRoot/test/demo/server.mjs). These are upstream fixtures, not bench/fowl/site/server.mjs.' }],
      leaves: 'Node builtins and installed package imports are leaves. Product plugin server/worker code is the A/B treatment; local helper imports are recorded. No selected path runs npm or root package scripts. suite.json is an inventory, not getTasks(world) input.' };
  }

  // Reconstruct browser text using source slices that contain only prompt expressions and pure rewrites.
  // No realAgentSetup/turboSetup function or top-level runner is imported or called.
  function renderBrowser(build, round, task, browser) {
    const native = pinned(build, 'bench/fowl/native-setup.mjs');
    const functions = native.slice(native.indexOf('const browserNames'), native.indexOf('export function nativeBrowserSetup'))
      .replaceAll('export function ', 'function ');
    const turbo = round.kind.startsWith('release');
    const window = runInNewContext(`${functions}\n${turbo ? 'turboWindowPrompt' : 'windowPrompt'}(browser)`, { browser });
    const body = pinned(build, 'bench/fowl/real-gate-setup.mjs');
    const begin = body.indexOf('  const browserName =', body.indexOf('export function realAgentSetup'));
    const end = body.indexOf('\n  if (isCodexSurface', begin);
    if (begin < 0 || end < 0) throw Error('Prompt body source boundary absent');
    const rendered = runInNewContext(`${body.slice(begin, end)}\nprompt`, { task, realBrowser: browser, repo: ROOT, dir: join(posix.dirname(round.path), task.name) });
    let prefix;
    if (!turbo) {
      const s = pinned(build, 'bench/world/arms/browser.mjs');
      const declaration = s.match(/export const WORLD_PROMPT_PREFIX = [^\n]+/)[0].replace('export ', '');
      prefix = runInNewContext(`${declaration}\nWORLD_PROMPT_PREFIX`);
    } else {
      const setup = pinned(build, 'bench/turbo/setup.mjs');
      let slice = setup.slice(setup.indexOf('  const browser ='), setup.indexOf('  const common ='));
      if (!slice) throw Error('Turbo prompt source boundary absent');
      slice = slice.replaceAll('import.meta.url', 'moduleURL');
      const pure = ['screenshot-guidance', ...(setup.includes('requestedSubmitRules(') ? ['requested-submit'] : [])]
        .map(name => pinned(build, `plugins/sleight/lib/${name}.mjs`).replaceAll('export ', '')).join('\n');
      prefix = runInNewContext(`${pure}\n${slice}\ninstalled + '\\n\\n'`, {
        realBrowser: browser, task, env: {}, process: { env: {} }, URL,
        moduleURL: `file:///source/bench/turbo/setup.mjs`,
        readFileSync: url => pinned(build, fileURLToPath(url).slice('/source/'.length)),
      });
    }
    return prefix + window + rendered;
  }

  function promptProof(round) {
    if (round.kind === 'native') return round.tasks.map(task => ({ task: task.task, aRenderedHash: null, bRenderedHash: null,
      reason: 'A JSON has no rendered prompt or complete fixture context. A bench/run.mjs creates randomBytes(4).toString(hex) for each nonce and a stamp/arm/task/run scratch dir. Answers can mention a nonce but do not prove every prepare-mutated context field. No hash equality is claimed.',
      nonceRule: { source: `${round.harnessCommit}:bench/run.mjs`, expression: "randomBytes(4).toString('hex')", templateSources: task.promptSources } }));
    const dir = posix.dirname(round.path), browser = JSON.parse(readFileSync(join(dir, 'browser.json')));
    const current = JSON.parse(pinned(bBuild, round.kind === 'as3' ? 'bench/world/tasks/browser-open-heldout.json' : 'bench/world/tasks/fowlbrowser.json'));
    const rows = JSON.parse(readFileSync(round.path));
    return rows.map(row => {
      const now = current.find(task => task.name === row.task.name);
      const proof = { task: row.task.name, aCatalogHash: sha(row.task.prompt), bCatalogHash: now ? sha(now.prompt) : null,
        binding: 'Both source templates rendered with the recorded browser marker, PID and profile. Historical repo/out bindings held constant to compare text, not fresh random identities.' };
      try {
        const a = renderBrowser(round.harnessCommit, round, row.task, browser);
        const b = now ? renderBrowser(bBuild, round, now, browser) : null;
        return { ...proof, aRenderedHash: sha(a), bRenderedHash: b ? sha(b) : null, equal: !!b && a === b };
      } catch (error) { return { ...proof, aRenderedHash: null, bRenderedHash: null, reason: error.message }; }
    });
  }

  const profiles = {}, rounds = [];
  for (const round of audit.rounds) {
    const browser = round.kind.startsWith('release') ? 'chrome' : round.name.includes('safari') ? 'safari' : 'firefox';
    const id = round.kind === 'native' ? 'native' : `${round.kind === 'as3' ? 'as3' : 'race'}-${browser}`;
    profiles[id] ??= traceProfile(id, { native: round.kind === 'native', browser, as3: round.kind === 'as3' });
    const files = profiles[id].files;
    rounds.push({ name: round.name, fileHash: round.fileHash, harnessCommit: round.harnessCommit, profile: id,
      changedHarnessFiles: round.changedHarnessFiles, counts: Object.fromEntries(['RUNS-THE-TASK', 'NOT'].map(c => [c, round.changedHarnessFiles.filter(path => files[path].classification === c).length])),
      prompts: promptProof(round), model: round.tasks.map(t => ({ task: t.task, models: t.models, effort: t.effort })), engine: round.engine });
  }
  // The logs identify durable result paths. Search those and JSON evidence, never count catalog or proposed plan rows.
  const samples = [], resultPaths = new Set(), searched = [];
  const walk = async dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(json|log)$/.test(path) && !path.endsWith('/vp2.log')) {
        if (/\.log$/.test(path)) {
          const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
          for await (const line of lines) {
            const m = /^results: (.+)$/.exec(line);
            if (m && existsSync(m[1])) resultPaths.add(m[1]);
          }
        }
        if (/\.json$/.test(path)) resultPaths.add(path);
      }
    }
  };
  for (const dir of [EVIDENCE, join(ROOT, '../ledger')]) if (existsSync(dir)) { await walk(dir); searched.push(dir); }
  // Include native runner files even when no race log points to them.
  const worktreeParent = join(ROOT, '..');
  for (const dir of [join(ROOT, '../../sleight'), ...readdirSync(worktreeParent).map(name => join(worktreeParent, name))]) {
    const results = join(dir, 'bench/results');
    if (existsSync(results)) for (const name of readdirSync(results).filter(n => n.endsWith('.json'))) resultPaths.add(join(results, name));
  }
  for (const path of resultPaths) {
    try {
      const bytes = readFileSync(path), raw = JSON.parse(bytes);
      for (const row of raw.results ?? []) if (row.task?.startsWith('cc-') && Number.isFinite(row.seconds) && row.arm === 'sleight') samples.push({
        path, fileHash: sha(bytes), task: row.task, seconds: row.seconds, passed: row.passed === true,
        model: raw.model, effort: raw.effort, engine: raw.engine?.version });
    } catch { /* Logs, incomplete JSON and non-run artifacts are not measured results. */ }
  }
  const bPromptSources = Object.fromEntries([
    'plugins/sleight/skills/drive-mac-apps/SKILL.md', 'plugins/sleight/skills/drive-mac-apps/BROWSERS.turbo-v3.md',
    'plugins/sleight/lib/screenshot-guidance.mjs', 'plugins/sleight/lib/requested-submit.mjs',
  ].map(path => [path, sha(pinned(bBuild, path))]));
  return { schema: 1, bBuild, bHarnessHash: harness(bBuild).hash, bPromptSources, auditHash: sha(readFileSync(auditPath)),
    rule: 'Every changed file must be NOT in the round profile and the rendered prompt, model, effort and engine must match. A reachable changed runner disqualifies the round even when some changed files are unrelated.',
    profiles, rounds, ccMeasurements: samples, ccSearch: { roots: searched, resultFilesInspected: resultPaths.size,
      note: 'Catalog entries and proposed commands in lane logs are not CC smoke results. No timeout allowance substitutes for a measurement.' } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--data' || args[1].startsWith('--'))) throw Error('Use --data DIRECTORY');
    console.log(JSON.stringify(await classify({ data: args[1] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

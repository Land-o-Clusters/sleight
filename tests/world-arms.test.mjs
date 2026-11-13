import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { PRICES } from '../bench/api-auth.mjs';
import { commandSkip } from './requirements.mjs';
import {
  ARMS, CHROME, KEY_DIR, TELEMETRY, armCommand, hasLockfile, parseEvents, resultEvent, runArm,
} from '../bench/world/arms/python.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'bench/world/arms/lib');
const ARM = join(ROOT, 'bench/world/arms/browser-use');
const uvSkip = commandSkip('uv') || (spawnSync('uv', ['python', 'find', '--offline', '--no-python-downloads', '--no-cache', '3.12'],
  { encoding: 'utf8' }).status !== 0 && 'needs an installed Python 3.12 for uv');

function tmp(t) {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-world-arm-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function source(arm) {
  return readFileSync(join(ROOT, 'bench/world/arms', arm, 'run.py'), 'utf8');
}

function py(code) {
  return spawnSync('uv', ['run', '--python', '3.12', '--no-project', '--', 'python', '-c', code], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: LIB },
  });
}

test('Browser Use is the only world arm', () => {
  assert.deepEqual(ARMS, ['browser-use']);
  assert.equal(TELEMETRY.BROWSER_USE_CLOUD_SYNC, 'false');
  assert.equal(TELEMETRY.ANONYMIZED_TELEMETRY, 'false');
  assert.equal(KEY_DIR, '~/.config/sleight-bench');
  assert.equal(CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(hasLockfile('browser-use'), true);
  assert.match(readFileSync(join(ROOT, 'bench/world/arms/browser-use/pyproject.toml'), 'utf8'), /browser-use==0\.13\.11/);
});

test('browser-use live path uses ChatAnthropic, a throwaway profile, and kill()', () => {
  const text = source('browser-use');
  const cli = readFileSync(join(ROOT, 'bench/world/arms/lib/cli.py'), 'utf8');
  assert.match(text, /from browser_use import Agent, Browser, ChatAnthropic/);
  assert.match(text, /ChatAnthropic\(\*\*llm_kwargs/);
  assert.match(text, /user_data_dir=profile/);
  assert.match(text, /browser-use-user-data-dir-/);
  assert.match(text, /llm_timeout=900/);
  assert.match(text, /browser\.kill|getattr\(browser, 'kill'/);
  assert.doesNotMatch(text, /\.stop\(/);
  assert.match(text, /budget_seconds/);
  assert.match(text, /token_cost_service/);
  assert.match(text, /get_usage_summary/);
  assert.doesNotMatch(text, /calculate_cost\s*=\s*True/);
  assert.doesNotMatch(text, /from_system_chrome/);
  assert.doesNotMatch(text, /temperature/);
  assert.doesNotMatch(text, /budget_tokens/);
  assert.doesNotMatch(text, /str\(history\)/);
  assert.doesNotMatch(cli, /claude-opus-4/);
  assert.match(cli, /'thinking'\] = \{'type': 'adaptive'\}/);
  assert.match(cli, /'output_config'\] = \{'effort': effort\}/);
  assert.match(cli, /api-auth\.mjs/);
  assert.match(cli, /BROWSER_USE_CLOUD_SYNC/);
});

test('Browser Use locks patched dependencies despite upstream exact pins', { skip: uvSkip }, () => {
  const ran = py(`
import re, tomllib
from pathlib import Path
arm = Path(${JSON.stringify(ARM)})
project = tomllib.loads((arm / 'pyproject.toml').read_text())
lock = tomllib.loads((arm / 'uv.lock').read_text())
patched = {'anyio': '4.14.2', 'pypdf': '6.19.0', 'mcp': '2.2.0', 'aiohttp': '3.14.4'}
for name, minimum in patched.items():
    packages = [p for p in lock['package'] if p['name'] == name]
    assert len(packages) == 1, (name, packages)
    package = packages[0]
    assert tuple(map(int, package['version'].split('.'))) >= tuple(map(int, minimum.split('.'))), package
    assert f"{name}=={package['version']}" in project['tool']['uv']['override-dependencies']
    assert {'name': name, 'specifier': '==' + package['version']} in lock['manifest']['overrides']
    for artifact in [package['sdist'], *package['wheels']]:
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', artifact['hash']), artifact
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});

test('UsageSummary fakes of the 0.13.11 shape price from PRICES, not total_cost', { skip: uvSkip }, () => {
  const prices = JSON.stringify(PRICES);
  const ran = py(`
from usage import usage_from_browser_use, load_prices
prices = ${prices}
class Usage:
    total_prompt_tokens = 1100
    total_completion_tokens = 50
    total_prompt_cached_tokens = 100
    total_prompt_cache_creation_tokens = 200
    total_cost = 99.0
class History:
    usage = Usage()
u, cost = usage_from_browser_use(History(), 'claude-haiku-5-5', prices)
assert u['input_tokens'] == 1000
assert u['cache_read_input_tokens'] == 100
assert u['cache_creation_input_tokens'] == 200
assert u['output_tokens'] == 50
assert cost != 99.0
# uncached 1000 * 0.10 + 50 * 0.50 + 100 * 0.01 + 200 * 0.10 * 2  all / 1e6
assert abs(cost - 0.000166) < 1e-9, cost
loaded = load_prices()
assert loaded['claude-haiku-5-5']['input'] == 0.10
assert loaded['claude-opus-5-5']['output'] == 20
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.match(ran.stdout, /ok/);
});

test('a run without done or with errors is an error and never stringifies the history', { skip: uvSkip }, () => {
  const ran = py(`
import sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'bench/world/arms/browser-use'))})
from run import history_outcome
class H:
    def __init__(self, **kw):
        self._kw = kw
    def errors(self): return self._kw.get('errors', [])
    def is_done(self): return self._kw.get('done', False)
    def final_result(self): return self._kw.get('answer')
    def __str__(self): return 'HISTORY-REPR'
a, err = history_outcome(H(errors=['boom'], done=True, answer='RESULT: 1815'))
assert not err and a == 'RESULT: 1815' and 'HISTORY' not in a
a, err = history_outcome(H(errors=[None, None], done=False))
assert err and a == 'Browser Use did not call done' and 'HISTORY' not in a
a, err = history_outcome(H(errors=['boom'], done=False))
assert err and a == 'boom' and 'HISTORY' not in a
a, err = history_outcome(H(errors=[], done=True, answer='RESULT: 1815'))
assert not err and a == 'RESULT: 1815'
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});

test('llm_kwargs uses adaptive thinking and output_config effort', { skip: uvSkip }, () => {
  const ran = py(`
from cli import llm_kwargs
class ChatAnthropic:
    def __init__(self, model, api_key=None, thinking=None, output_config=None, max_tokens=8192, timeout=None):
        pass
kw = llm_kwargs(ChatAnthropic, 'haiku', 'high', 'sk-ant-x')
assert kw['model'] == 'claude-haiku-5-5'
assert kw['thinking'] == {'type': 'adaptive'}
assert kw['output_config'] == {'effort': 'high'}
assert kw['max_tokens'] == 64000
assert kw['timeout'] == 900
assert 'temperature' not in kw
assert 'thinking_budget' not in kw
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});

test('fake model dry-run writes the FowlBrowser result event via uv 3.12', { skip: uvSkip }, t => {
  const out = tmp(t);
  const plan = armCommand({
    arm: 'browser-use', out, prompt: 'open wikipedia and tell me when Ada Lovelace was born',
    model: 'opus', effort: 'medium', fake: true,
  });
  assert.equal(plan.command, 'uv');
  assert.ok(plan.args.includes('3.12'));
  assert.ok(plan.args.includes('--no-project'));
  assert.equal(armCommand({
    arm: 'browser-use', out, prompt: 'x', model: 'opus', effort: 'high',
  }).args.includes('--frozen'), true);
  const ran = runArm({
    arm: 'browser-use', out, prompt: 'open wikipedia and tell me when Ada Lovelace was born',
    model: 'opus', effort: 'medium', fake: true,
  });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  const events = ran.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const result = resultEvent(events);
  assert.equal(result.is_error, false);
  assert.equal(result.model, 'claude-opus-5-5');
  assert.match(String(result.result), /claude-opus-5-5/);
  assert.match(ran.stdout, /"type": "result"/);
  assert.equal(existsSync(join(out, 'events.jsonl')), false);
});

test('a missing key still writes events.jsonl with is_error', { skip: uvSkip }, t => {
  const out = tmp(t);
  const ran = py(`
import os, sys, tempfile
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'bench/world/arms/browser-use'))})
os.environ['HOME'] = tempfile.mkdtemp()
from run import fail
from cli import parse_args
args = parse_args(['--prompt', 'x', '--out', ${JSON.stringify(out)}, '--arm', 'browser-use'])
fail(args, SystemExit('missing key'))
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  const result = resultEvent(ran.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)));
  assert.equal(result.is_error, true);
  assert.match(String(result.result), /missing key/);
});

test('rounds.sh stops at $190 and always uses the API key for browser-use', async () => {
  const sh = readFileSync(join(ROOT, 'bench/fowl/rounds.sh'), 'utf8');
  assert.match(sh, /AUTH=\$\(node.*--auth-mode "\$MODEL" "\$SURFACES"\)/);
  const { roundAuth } = await import('../bench/fowl/accounting.mjs');
  assert.equal(roundAuth('opus', ['browser-use']), 'api');
  assert.match(sh, /usd>=190/);
  assert.match(sh, /add-spend\.mjs/);
  assert.match(sh, /api-auth\.mjs/);
});

test('high effort builds a ChatAnthropic request the SDK accepts', { skip: uvSkip }, t => {
  const envDir = tmp(t);
  const hadVenv = existsSync(join(ARM, '.venv'));
  const ran = spawnSync('uv', [
    'run', '--python', '3.12', '--frozen', '--project', ARM,
    '--', 'python', '-c', `
import asyncio, httpx2
from anthropic import AsyncAnthropic, DEFAULT_TIMEOUT
from browser_use import ChatAnthropic
from cli import llm_kwargs
kw = llm_kwargs(ChatAnthropic, 'haiku', 'high', 'sk-ant-test')
assert kw['timeout'] == 900 and kw['max_tokens'] == 64000
llm = ChatAnthropic(**kw)
assert llm._get_client_params()['timeout'] == 900
assert llm._get_client_params()['timeout'] != DEFAULT_TIMEOUT
class T(httpx2.AsyncBaseTransport):
    def __init__(self):
        self.requests = []
    async def handle_async_request(self, request):
        self.requests.append(request)
        return httpx2.Response(200, json={
            'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': 'claude-haiku-5-5',
            'content': [{'type': 'text', 'text': 'ok'}], 'stop_reason': 'end_turn', 'stop_sequence': None,
            'usage': {'input_tokens': 1, 'output_tokens': 1},
        })
transport = T()
client = AsyncAnthropic(api_key='sk-ant-test', timeout=900, http_client=httpx2.AsyncClient(transport=transport))
asyncio.run(client.messages.create(model=kw['model'], max_tokens=kw['max_tokens'], messages=[{'role': 'user', 'content': 'hi'}]))
assert transport.requests, 'SDK sent a request'
print('ok')
`,
  ], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: LIB, UV_PROJECT_ENVIRONMENT: envDir } });
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
  assert.match(ran.stdout, /ok/);
  assert.equal(existsSync(join(ARM, '.venv')), hadVenv);
});

test('kill_browser retries kill and never calls stop', { skip: uvSkip }, () => {
  const ran = py(`
import asyncio, sys
sys.path.insert(0, ${JSON.stringify(ARM)})
from run import kill_browser
class B:
    def __init__(self):
        self.kills = 0
        self.stops = 0
    def kill(self):
        self.kills += 1
        if self.kills == 1:
            raise RuntimeError('first kill failed')
    def stop(self):
        self.stops += 1
        raise AssertionError('stop must not be called')
b = B()
asyncio.run(kill_browser(b))
assert b.kills == 2 and b.stops == 0
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});

test('a Browser constructor error removes the throwaway profile and reports failure', { skip: uvSkip }, t => {
  const out = tmp(t);
  const ran = py(`
import asyncio, contextlib, io, json, shutil, sys, tempfile, types
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(ARM)})
import run
profiles = []
mkdtemp = tempfile.mkdtemp
def profile(**kwargs):
    path = mkdtemp(**kwargs)
    profiles.append(path)
    return path
class ChatAnthropic:
    def __init__(self, model, api_key=None, thinking=None, output_config=None, max_tokens=8192, timeout=None):
        pass
def Browser(**kwargs):
    assert kwargs['user_data_dir'] == profiles[-1]
    raise RuntimeError('constructor failed')
def Agent(**kwargs):
    raise AssertionError('agent must not start')
sys.modules['browser_use'] = types.SimpleNamespace(Agent=Agent, Browser=Browser, ChatAnthropic=ChatAnthropic)
run.CHROME = run.__file__
run.anthropic_key = lambda: 'sk-ant-test'
run.tempfile.mkdtemp = profile
args = run.parse_args(['--prompt', 'fixture', '--out', ${JSON.stringify(out)}, '--arm', 'browser-use', '--model', 'haiku'])
output = io.StringIO()
try:
    with contextlib.redirect_stdout(output):
        try:
            asyncio.run(run.live_async(args))
        except RuntimeError as error:
            assert str(error) == 'constructor failed'
    assert len(profiles) == 1
    assert not Path(profiles[0]).exists(), 'constructor error leaked the profile'
    result = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith('{')][-1]
    assert result['type'] == 'result' and result['is_error']
    assert result['result'] == 'constructor failed'
finally:
    for path in profiles:
        shutil.rmtree(path, ignore_errors=True)
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});

test('timeout and exception paths report spend from token_cost_service', { skip: uvSkip }, () => {
  const ran = py(`
import asyncio, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'bench/world/arms/browser-use'))})
from run import spend
class Usage:
    total_prompt_tokens = 1100
    total_completion_tokens = 50
    total_prompt_cached_tokens = 100
    total_prompt_cache_creation_tokens = 200
class Service:
    def get_usage_summary(self):
        return Usage()
class Agent:
    token_cost_service = Service()
u, cost = asyncio.run(spend(Agent(), 'claude-haiku-5-5'))
assert u['input_tokens'] == 1000
assert abs(cost - 0.000166) < 1e-9, cost
empty, zero = asyncio.run(spend(None, 'claude-haiku-5-5'))
assert empty == {} and zero == 0
print('ok')
`);
  assert.equal(ran.status, 0, ran.stderr + ran.stdout);
});

test('setup.sh --dry-run prints the pin and does not create a venv', t => {
  const cwd = tmp(t);
  const script = join(ROOT, 'bench/world/arms/browser-use/setup.sh');
  const ran = spawnSync('sh', [script, '--dry-run'], { encoding: 'utf8', cwd });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /uv sync --python 3\.12 --frozen/);
  assert.match(ran.stdout, /browser-use==0\.13\.11, security overrides in pyproject\.toml/);
  const listing = spawnSync('/bin/ls', ['-A', cwd], { encoding: 'utf8' });
  assert.equal(listing.stdout.trim(), '');
});

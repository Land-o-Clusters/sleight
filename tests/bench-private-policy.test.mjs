import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertPrivateClaudePolicy } from '../bench/private-policy.mjs';
import { PRIVATE_LOGGING_OVERRIDES } from '../bench/driver.mjs';

test('private flag settings retain all forced logging overrides after CLI config loading', () => {
  const settings = JSON.parse(readFileSync(new URL('../bench/private-settings.json', import.meta.url), 'utf8'));
  assert.deepEqual(settings.env, PRIVATE_LOGGING_OVERRIDES);
  assert.deepEqual(Object.keys(settings.hooks), ['Elicitation']);
});

function fixture(files = {}) {
  return { home: '/fixture', username: 'fixture', stat: path => {
    if (!(path in files)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: Buffer.byteLength(files[path]) };
  }, read: path => files[path], list: () => [] };
}

test('private policy audit accepts absent policy and safe legacy runtime env', () => {
  assert.doesNotThrow(() => assertPrivateClaudePolicy(fixture()));
  assert.doesNotThrow(() => assertPrivateClaudePolicy(fixture({ '/fixture/.claude.json': JSON.stringify({ env: {
    CLAUDE_CODE_OAUTH_TOKEN: 'invented auth', OTEL_LOG_RAW_API_BODIES: 'file:/fixture/debug' }, projects: {} }) })));
});

test('private policy audit refuses managed settings and cached server policy before app setup', () => {
  for (const path of ['/Library/Application Support/ClaudeCode/managed-settings.json',
    '/Library/Managed Preferences/fixture/com.anthropic.claudecode.plist',
    '/Library/Managed Preferences/com.anthropic.claudecode.plist', '/fixture/.claude/remote-settings.json']) {
    assert.throws(() => assertPrivateClaudePolicy(fixture({ [path]: '{"env":{"OTEL_LOG_RAW_API_BODIES":"file:/fixture/debug"}}' })), /PRIVATE_MAIL_POLICY_UNPROVED/);
  }
});

test('private policy audit refuses unknown env destinations, executable configuration and ambiguous reads', () => {
  for (const config of [{ env: { PRIVATE_UNKNOWN_LOG: '/fixture/debug' } }, { env: { PATH: '/fixture/bin' } },
    { env: { HOME: '/fixture/redirected' } }, { env: { BENCH_ROOT: '/fixture/redirected' } },
    { env: { SLEIGHT_SURFACES: 'browser' } }, { env: { constructor: 'inherited prototype key' } }, { hooks: { PostToolUse: [] } },
    { policyHelper: '/fixture/helper' }, { policyHelpers: [] }, { processWrapper: '/fixture/wrapper' }]) {
    assert.throws(() => assertPrivateClaudePolicy(fixture({ '/fixture/.claude.json': JSON.stringify(config) })), /PRIVATE_MAIL_POLICY_UNPROVED/);
  }
  assert.throws(() => assertPrivateClaudePolicy(fixture({ '/fixture/.claude.json': 'invalid' })), /PRIVATE_MAIL_POLICY_UNPROVED/);
  const denied = fixture(); denied.stat = () => { throw Object.assign(new Error('private error text'), { code: 'EACCES' }); };
  assert.throws(() => assertPrivateClaudePolicy(denied), error => error.message === 'PRIVATE_MAIL_POLICY_UNPROVED');
});

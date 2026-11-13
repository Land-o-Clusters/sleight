import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_OPERATIONS } from '../bench/windows/uc3f-collect.mjs';

function contract(source) {
  const bound = source.split('function Bound($f) {')[1].split('function HasField')[0];
  assert.match(bound, /if \(\(Birth \$p\) -cne \$f\.processStart\) \{ throw 'FIXTURE_BIRTH_CHANGED' \}/);
  assert.match(bound, /if \(\$p\.SessionId -ne \[Diagnostics\.Process\]::GetCurrentProcess\(\)\.SessionId -or \$p\.Path -ine \$f\.image\) \{/);
  for (const field of ['operation=$r.operation', 'target=$r.fixture.target', 'image=$p.Path', 'expectedImage=$f.image',
    'sessionId=$p.SessionId', 'expectedSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId']) assert.ok(bound.includes(field), field);
  assert.match(bound, /Join-Path \$r\.bank 'raw'/);
  assert.match(bound, /\[IO\.FileMode\]::CreateNew/);
  assert.match(bound, /catch \{ \}\s+throw 'FIXTURE_IDENTITY_CHANGED'/);
  assert.ok(bound.indexOf("throw 'FIXTURE_IDENTITY_CHANGED'") < bound.indexOf('return $p'));
}
test('fixture mismatch retains session and image evidence while every refusal stays in place', () => contract(GUEST_OPERATIONS));
for (const [name, before, after] of [
  ['session check', '$p.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId', '$false'],
  ['image check', '$p.Path -ine $f.image', '$false'],
  ['birth check', "throw 'FIXTURE_BIRTH_CHANGED'", 'return $p'],
  ['refusal', "throw 'FIXTURE_IDENTITY_CHANGED'", 'return $p'],
  ['image evidence', 'expectedImage=$f.image', 'other=$f.image'],
  ['session evidence', 'sessionId=$p.SessionId', 'other=$p.SessionId'],
]) test(`identity diagnostic rejects missing ${name}`, () => {
  assert.ok(GUEST_OPERATIONS.includes(before));
  assert.throws(() => contract(GUEST_OPERATIONS.replace(before, after)), assert.AssertionError);
});

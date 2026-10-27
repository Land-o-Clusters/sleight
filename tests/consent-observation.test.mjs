import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectConsent, checkConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';
import { consentDOM } from './fixtures/consent-dom.mjs';

test('one inspection scans an ordinary control label once', () => {
  const f = consentDOM(), target = f.node('button', 'Open details', {}, [f.node('span', 'Details')]);
  assert.deepEqual(inspectConsent(target, {}, f.read), { blocked: false });
  assert.equal(f.scans.get(target), 1);
});

test('a later inspection reads changed labels and still blocks acceptance', async () => {
  const f = consentDOM(), target = f.node('button', 'Open details');
  f.node('div', '', { id: 'onetrust-banner' }, [target]);
  const loc = f.locator(target);
  assert.equal(await checkConsent(loc, 'click', {}), false);
  target.attrs['aria-label'] = 'Accept all';
  await assert.rejects(checkConsent(loc, 'click', {}), /Cookie acceptance blocked/);
  assert.equal(f.scans.get(target), 2);
});

for (const variant of ['visible', 'aria', 'pseudo', 'label', 'child']) test(`acceptance in ${variant} still overrides a decline name`, () => {
  const f = consentDOM(), target = f.node('button', 'Reject all');
  f.node('div', '', { id: 'onetrust-banner' }, [target]);
  if (variant === 'visible') { target.innerText = 'Accept all'; target.attrs['aria-label'] = 'Reject all'; }
  if (variant === 'aria') target.attrs['aria-label'] = 'Accept all';
  if (variant === 'pseudo') target.pseudo['::after'] = '"Accept all"';
  if (variant === 'label') target.labels = [f.node('label', 'Accept all')];
  if (variant === 'child') { const child = f.node('img', '', { alt: 'Accept all' }); child.parentElement = target; target.childNodes.push(child); }
  const result = f.inspect(target);
  assert.equal(result.blocked, true); assert.equal(result.decline, false);
});

test('reject suggestions keep disabled and nested-boundary controls excluded', () => {
  const f = consentDOM(), accept = f.node('button', 'Accept all'), disabled = f.node('button', 'Reject all');
  disabled.disabled = true;
  const nested = f.node('button', 'Reject all'), usable = f.node('button', 'Only necessary');
  f.node('div', '', { id: 'onetrust-banner' }, [accept, disabled, f.node('section', '', { role: 'region' }, [nested]), usable]);
  assert.equal(f.inspect(accept).reject, 'Only necessary');
  assert.equal(f.scans.get(usable), 1);
});

test('a later closure verification does not reuse a visible observation', () => {
  const f = consentDOM(), wall = f.node('div');
  assert.deepEqual(f.inspect(wall, { after: true }), { closed: false });
  wall.isConnected = false;
  assert.deepEqual(f.inspect(wall, { after: true }), { closed: true });
});

test('ordinary consent words outside a shaped wall remain usable', () => {
  const f = consentDOM(), target = f.node('button', 'Accept invitation');
  f.node('main', '', {}, [target]);
  assert.deepEqual(f.inspect(target), { blocked: false });
});

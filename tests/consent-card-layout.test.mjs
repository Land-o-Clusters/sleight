import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewConsentCards, previewOrdinaryCards } from '../scripts/preview-consent-card.mjs';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('ordinary approval labels fit without changing flow or review geometry', { skip: macCommandSkip('osascript') }, t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ordinary-layout-'))));
  const cards = previewOrdinaryCards(directory);
  const labels = Object.fromEntries(cards.map(card => [card.mode, card.buttons.toSorted((a, b) => a.x - b.x).map(button => button.title)]));
  assert.deepEqual(labels.approval, ["Don't allow", 'Allow this session']);
  assert.deepEqual(labels.always, ["Don't allow", 'Allow this session', 'Always allow']);
  assert.deepEqual(labels.once, ["Don't allow", 'Allow once'], 'body text cannot turn a one-action grant into a session label');
  assert.deepEqual(labels['always-once'], ["Don't allow", 'Allow once', 'Always allow']);
  assert.deepEqual(labels.flow, ["Don't allow", 'Allow once']);
  assert.deepEqual(labels.review, ['Later', 'Undo', 'Keep']);
  for (const card of cards) {
    assert.equal(card.visible, false);
    for (const button of card.buttons) {
      assert.ok(button.width >= button.intrinsicWidth, `${card.mode}: ${button.title} clipped`);
      assert.equal(button.y, 20);
    }
  }
  for (const card of cards.filter(card => ['flow', 'review'].includes(card.mode))) {
    assert.equal(card.width, 680); assert.equal(card.height, 481);
  }
});

test('real cards keep choices on one row and expand details and feedback without retargeting consent', { skip: macCommandSkip('xcrun') }, t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-card-layout-'))));
  const { cards, tracking, answers } = previewConsentCards(directory);
  assert.deepEqual(answers, []);
  for (const record of tracking) {
    assert.ok(record.restingAccents.every(accent => !accent), `${record.name}: Allow once must not stay accented while the session button is tracked`);
    assert.deepEqual(record.highlighted, record.name === 'electron-three' ? [false, false, true] : [false, false, true, false]);
  }
  assert.equal(tracking.length, 2);
  const labels = Object.fromEntries(cards.map(card => [card.name, card.buttons.map(button => button.title)]));
  assert.deepEqual(labels.ordinary, ["Don't allow", 'Allow this session']);
  assert.deepEqual(labels['electron-three-collapsed'], ["Don't allow", 'Allow once', 'Allow this session']);
  assert.deepEqual(labels['electron-four-collapsed'], ["Don't allow", 'Allow once', 'Allow this session', 'Always allow']);
  assert.deepEqual(labels.relaunch, ['Cancel', 'Quit and reopen']);
  for (const card of cards) {
    assert.equal(card.visible, false, 'fixture must remain offscreen');
    assert.equal(card.hidesOnDeactivate, false);
    assert.equal(new Set(card.buttons.map(button => button.frame.y)).size, 1, `${card.name}: choices must be in one row`);
    const edge = card.frame.width === 480 && card.buttons.length === 4 ? 8 : 20;
    for (const button of card.buttons) {
      assert.ok(button.frame.width >= button.intrinsicWidth, `${card.name}: ${button.title} clipped`);
      assert.ok(button.frame.x >= edge && button.frame.x + button.frame.width <= card.frame.width - edge);
      assert.equal(button.default, false);
      assert.equal(button.restingAccent, false, `${card.name}: ${button.title} must be neutral at rest`);
      assert.equal(button.highlighted, false);
    }
    const sorted = card.buttons.toSorted((a, b) => a.frame.x - b.frame.x);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].frame.x >= sorted[i - 1].frame.x + sorted[i - 1].frame.width + 8);
    if (!card.name.includes('feedback')) assert.equal(card.buttons[0].frame.y, 20, 'no empty feedback reserve');
  }
  assert.ok(cards.find(card => card.name === 'ordinary').frame.height < 180);
  for (const card of cards.filter(card => card.name.startsWith('maximum-identity'))) {
    assert.ok(card.windowFrame.x >= 0 && card.windowFrame.y >= 0);
    assert.ok(card.windowFrame.x + card.windowFrame.width <= 480);
    assert.ok(card.windowFrame.y + card.windowFrame.height <= 480);
    if (!card.name.endsWith('collapsed')) {
      assert.equal(card.detailsHidden, false, `${card.name}: opening Details must expose the identity`);
      assert.ok(card.detailsViewport.height >= 96, `${card.name}: Details must have a usable scroll viewport`);
      assert.equal(card.detailsViewport.y, 0, 'Details starts at the first identity line');
      assert.ok(card.detailsDocument.height > card.detailsViewport.height, 'long identity scrolls');
      assert.ok(card.detailsFrame.y >= card.buttons[0].frame.y + card.buttons[0].frame.height + 8);
      assert.ok(card.detailsFrame.y + card.detailsFrame.height <= card.summaryFrame.y - 22);
    }
  }
  for (const card of cards.filter(card => card.name.startsWith('narrow-display'))) {
    assert.ok(card.windowFrame.x >= 0 && card.windowFrame.y >= 0);
    assert.ok(card.windowFrame.x + card.windowFrame.width <= 480);
    assert.ok(card.windowFrame.y + card.windowFrame.height <= 480);
    if (card.name.includes('feedback') && card.detailsFlipped) assert.equal(card.detailsViewport.y, 0, 'expanded identity starts at its first line');
  }
  for (const card of cards.filter(card => card.name.startsWith('long-name-small-display'))) {
    assert.ok(card.frame.width <= 640 && card.frame.height <= 480, 'small display must contain the card');
    assert.ok(card.windowFrame.x >= 0 && card.windowFrame.y >= 0);
    assert.ok(card.windowFrame.x + card.windowFrame.width <= 640);
    assert.ok(card.windowFrame.y + card.windowFrame.height <= 480);
    for (const field of card.fields.filter(field => !field.text.includes('Profile:'))) {
      assert.ok(field.frame.y >= 0 && field.frame.y + field.frame.height <= card.frame.height, 'main explanation must stay visible');
    }
  }
  for (const count of ['three', 'four']) {
    const collapsed = cards.find(card => card.name === `electron-${count}-collapsed`);
    const expanded = cards.find(card => card.name === `electron-${count}-expanded`);
    const feedback = cards.find(card => card.name === `electron-${count}-feedback`);
    const reclosed = cards.find(card => card.name === `electron-${count}-feedback-collapsed`);
    assert.ok(expanded && feedback && reclosed, 'Details must open and close');
    assert.ok(collapsed.frame.height < 320);
    assert.ok(expanded.frame.height > collapsed.frame.height);
    assert.ok(feedback.frame.height > expanded.frame.height);
    assert.ok(reclosed.frame.height < feedback.frame.height);
    assert.ok(collapsed.fields.some(field => field.text.includes('invalid.fixture.editor')), 'meaningful identity stays visible');
    assert.ok(!collapsed.fields.some(field => field.text.includes('long-profile-segment')));
    assert.ok(expanded.fields.some(field => field.text.includes('long-profile-segment')));
    if (count === 'three') assert.ok(!collapsed.fields.some(field => field.text.includes('Always allow')));
    const message = feedback.fields.find(field => field.text === 'This button needs your own click or key press.');
    assert.ok(message);
    assert.ok(message.frame.y >= 20 && message.frame.y + message.frame.height <= feedback.buttons[0].frame.y - 8);
  }
});

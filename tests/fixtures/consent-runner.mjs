import assert from 'node:assert/strict';
import { fixture } from './cr4-real.mjs';
import { createActionRunner } from '../../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../../plugins/sleight/lib/direct-browser/tools.mjs';
import { snapshot, acknowledgeSnapshot } from '../../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { backgroundClick } from '../../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3Context, createV3TurnBinding } from '../../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { check, inspectElement, deliverSnapshot } from '../../plugins/sleight/lib/direct-browser/rules.mjs';
import { createFillFields } from '../../plugins/sleight/lib/direct-browser/fill.mjs';

export async function consentFixture(t, html, routes = {}, runnerOptions = {}) {
  const f = await fixture(t, html, routes);
  const binding = createV3TurnBinding({ source: 'user', session: 'g11c', turn: 'fixture', id: 'read', text: 'Read the page.' }, () => true);
  const ctx = createV3Context({ binding, browser: 'bfixture' });
  t.after(() => ctx.dispose());
  const runSteps = createActionRunner({ check, snapshot, backgroundClick, ...runnerOptions });
  const dispatch = createToolDispatcher({ pages: f.registry, snapshot, runSteps, ctx,
    fillFields: createFillFields({ check, runSteps, inspectElement }),
    deliverSnapshot: (state, capture) => { acknowledgeSnapshot(capture.page, capture.number); return deliverSnapshot(state, capture); } });
  const call = async (name, args = {}) => {
    const result = await dispatch.call({ name, arguments: { tab: f.entry.tab, ...args } });
    dispatch.delivered(result);
    assert.equal(result.isError, false, result.text);
    return result.text;
  };
  const read = () => call('browser_read');
  const ref = (text, name) => /\[ref=(\w+)\]/.exec(text.split('\n').find(line => line.includes('"' + name + '"') && line.includes('[ref=')) ?? '')?.[1];
  const act = async (name, extra = {}) => {
    const text = await read(), target = ref(text, name);
    assert.ok(target, `missing ${name}: ${text}`);
    return call('browser_act', { steps: [{ do: 'click', ref: target, ...extra }] });
  };
  return { ...f, call, read, ref, act };
}

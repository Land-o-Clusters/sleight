import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

// Model the pinned in-process bridge at the unit boundary. Real-page tests use
// the actual utility context. The existing fake owns each supported DOM reader.
export function utilityLocator(locator) {
  locator._connection = { toImpl: handle => {
    assert.equal(handle._connection, locator._connection);
    return { _frame: { utilityContext: async () => ({ world: 'utility',
      async evaluateExpression(source, options, args) {
        assert.equal(options.isFunction, true);
        // These unit fixtures model ordinary controls, with no consent wall.
        // Consent readers are exercised against real DOM in the headless suite.
        if (source.startsWith('([el, arg]) => { return (function inspectConsent(')) return { blocked: false };
        const match = /^\(\[el, arg\]\) => \(([\s\S]*?)\)\(el, arg, \(function nativeReader\(/.exec(source);
        assert.ok(match, 'only the trusted reader template is supported');
        return locator.evaluate(runInNewContext('(' + match[1] + ')'), args[1]);
      },
    }) } };
  } };
  return locator;
}

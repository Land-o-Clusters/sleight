// Frozen PS5-base await diagnostic, with only the callback-mask import redirected.
import { withoutPageCallbacks } from './ps5-page-callbacks-legacy.mjs';
export function unawaitedAction(code) { return unawaitedCall(code)?.method; }

const INPUT_METHODS = 'click|drag|dragTo|scroll|selectText|setValue|performSecondaryAction|paste|press|pressKey|typeText|pickFromList';
const HANDLE_METHODS = `${INPUT_METHODS}|doubleClick|rightClick|getAXState|getAXStateAndScreenshot|getScreenshot|waitFor|getJsDialog`;
const UNAWAITED_CALL = new RegExp(String.raw`(?:^|[;{}\n])\s*((?:(?:const|let|var)\s+)?[A-Za-z_$][\w$]*\s*=\s*)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:${INPUT_METHODS})\()`, 'g');

function unawaitedCall(code) {
  code = withoutPageCallbacks(code);
  const bare = code.replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`/g, literal => literal.replace(/[^\r\n]/g, ' '));
  for (const m of bare.matchAll(UNAWAITED_CALL)) {
    let end = m.index + m[0].length - 1, chained = false;
    for (;;) {
      let depth = 0;
      for (; end < bare.length; end++) {
        if (bare[end] === '(') depth++;
        else if (bare[end] === ')' && --depth === 0) break;
      }
      const chain = /^\s*\.\s*(?:then|catch|finally)\s*\(/.exec(bare.slice(end + 1));
      if (!chain) break;
      chained = true;
      end += chain[0].length;
    }
    if (m[1] ? chained : bare.slice(end + 1).replace(/^\s*;?/, '').trim()) {
      const start = m.index + m[0].lastIndexOf(m[2]);
      return { method: m[2], line: bare.slice(0, start).split('\n').length };
    }
  }
}

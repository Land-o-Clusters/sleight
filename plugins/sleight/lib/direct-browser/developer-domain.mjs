import { readFileSync } from 'node:fs';
import { domainToASCII } from 'node:url';

// Frozen Public Suffix List, including private suffixes, wildcard rules and
// exceptions. No network lookup occurs while reading developer metadata.
let suffixes;
function rules() {
  return suffixes ??= new Set(readFileSync(new URL('./public-suffix-list.dat', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(line => line && !line.startsWith('//')).map(line => {
      const prefix = line.startsWith('!') ? '!' : line.startsWith('*.') ? '*.' : '';
      return prefix + domainToASCII(line.slice(prefix.length));
    }));
}

export function hasDeveloperSuffix(hostname) {
  const last = hostname.toLowerCase().split('.').at(-1);
  if (['localhost', 'local', 'internal', 'invalid', 'test', 'example'].includes(last)) return true;
  try { return rules().has(last) || rules().has('*.' + last); }
  catch { return true; } // A missing list must fail closed in the URL scrubber.
}

export function scrubDeveloperHost(hostname) {
  if (/^(?:\d+\.){3}\d+$/.test(hostname) || hostname.startsWith('[')) return '[ip]';
  const names = hostname.replace(/\.$/, '').split('.');
  let keep = 0;
  if (names.at(-1) === 'localhost') keep = 1;
  else if (names.length > 1) {
    let suffix = 1;
    const list = rules();
    for (let i = 0; i < names.length; i++) {
      const tail = names.slice(i).join('.'), length = names.length - i;
      if (list.has('!' + tail)) { suffix = length - 1; break; }
      if (list.has(tail)) suffix = Math.max(suffix, length);
      if (i > 0 && list.has('*.' + tail)) suffix = Math.max(suffix, length + 1);
    }
    if (names.length > suffix) keep = suffix + 1;
  }
  return names.map((name, i) => i < names.length - keep || !/^[a-z-]{1,63}$/i.test(name) ? '[sub]' : name).join('.');
}

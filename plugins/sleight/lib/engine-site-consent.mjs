import { createHash } from 'node:crypto';
import { escapeLabel } from './direct-browser/consent-ui.mjs';

// These markers can expire a user's answer; they never prove a site or grant access.
// Include address-field values for browsers without web areas, including Firefox.
export function siteConsentKey(window, text) {
  const markers = String(text ?? '').split(/\r?\n/).flatMap(line => {
    const area = /^(?:[+-] )?\t*\d+ HTML [Cc]ontent\b.*?\bURL: (\S+)/.exec(line);
    const address = /^(?:[+-] )?\t*\d+ .*?\bValue: (https?:\/\/\S+)/i.exec(line);
    const title = /^(?:[+-] )?(Window: .*|0 standard window[^\r\n]*)\r?$/.exec(line);
    const field = /^(?:[+-] )?(?:URL: |0 .*?\bURL: )(\S+)/.exec(line);
    return [area?.[1], address?.[1], title?.[1], field?.[1]].filter(Boolean);
  });
  return createHash('sha256').update(JSON.stringify([window.appId, window.app, window.title, window.url,
    window.rootId, window.windowNumber, window.nativeIdentity?.pid, window.nativeIdentity?.processStart,
    [...new Set(markers)].sort()])).digest('hex');
}

export function siteConsentQuestion(window) {
  const app = escapeLabel(String(window.app ?? window.appId).slice(0, 128));
  const title = window.title ? ` Page title (untrusted text): "${escapeLabel(window.title.slice(0, 160))}".` : '';
  return `Allow sleight to act on this page in ${app}? It can't confirm the site because this window has no URL field.${title} Your site limits still apply. Allow only if this page is permitted.`;
}

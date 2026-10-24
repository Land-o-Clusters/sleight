import { isV3Context } from './v3-context.mjs';
import { trustedLocatorRead } from './trusted-dom.mjs';
import { downloadRequest } from './downloads.mjs';

// Only a pinned observed HTTP(S) link. No onclick handler, form submit, URL argument or page-supplied destination.
function linkData(el, unused, read) {
  const tag = read(el, 'localName'), href = read(el, 'getAttribute')('href');
  if (!['a', 'area'].includes(tag) || href === null) return null;
  const url = new URL(href, read(read(el, 'ownerDocument'), 'baseURI'));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  return { url: url.href, suggested: read(el, 'getAttribute')('download') || undefined };
}
export async function downloadLink(tab, step, ctx, { download, siteCheck, allowed } = {}) {
  if (!isV3Context(ctx) || typeof download !== 'function') throw Error('trusted browser download unavailable');
  const message = ctx.userMessage(); downloadRequest(message);
  const target = { page: tab.page, state: tab.state, ref: step.ref, locator: tab.page.getByRef(step.ref), do: 'click' };
  let valid = true;
  const revoked = () => { valid = false; };
  tab.page.on('framenavigated', revoked); tab.page.on('close', revoked);
  const current = () => valid && ctx.userMessage()?.id === message.id;
  try {
    const blocked = siteCheck?.(); if (blocked) throw Error(blocked);
    const verdict = await ctx.check('click', target);
    if (verdict?.verdict !== 'allow' || target.element?.payment || target.element?.submit || target.prior?.payment || target.prior?.submit)
      throw Error('download needs a plain document link, without a payment or submit');
    const link = await trustedLocatorRead(target.locator, linkData);
    if (!link || !current()) throw Error('download needs an observed HTTP(S) link');
    return await download({ ...link, session: message.session, message, current, allowed: url => current() && allowed?.(url) === true });
  } finally {
    tab.page.off('framenavigated', revoked); tab.page.off('close', revoked);
    await ctx.releaseTarget(target);
  }
}

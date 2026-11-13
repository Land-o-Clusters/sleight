import { setTouch, restoreTouch } from './touch.mjs';
// Reset and release remove emulation so the tab follows its current window and system preferences.
const original = new WeakMap();

async function innerSize(page) {
  let session, timer;
  try {
    session = await page.context().newCDPSession(page);
    const { cssLayoutViewport } = await Promise.race([session.send('Page.getLayoutMetrics'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('size read timed out')), 1500); })]);
    const { clientWidth: width, clientHeight: height } = cssLayoutViewport ?? {};
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;
  } catch { return null; }
  finally { clearTimeout(timer); await session?.detach().catch(() => {}); }
}

async function cssSize(page, size) {
  let requested = { ...size }, measured;
  // Browser zoom scales CDP's requested dimensions. Correct against native CSS metrics, never page getters.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.setViewportSize(requested);
    measured = await innerSize(page);
    if (!measured || Math.abs(measured.width - size.width) <= 1 && Math.abs(measured.height - size.height) <= 1) break;
    requested = { width: Math.round(requested.width * size.width / measured.width), height: Math.round(requested.height * size.height / measured.height) };
    if (![requested.width, requested.height].every(n => n > 0 && n <= 50000)) throw Error('viewport zoom compensation exceeds the size limit');
  }
  if (measured && (Math.abs(measured.width - size.width) > 1 || Math.abs(measured.height - size.height) > 1))
    throw Error('viewport could not reach the requested CSS size; read before retrying');
  return measured;
}

async function restoreSizeAndMedia(page, { release = false } = {}) {
  const saved = original.get(page);
  if (!saved) return 'viewport unchanged: no size was set on this tab';
  // Emulation belongs to the session that installed it, not a fresh CDP session.
  const impl = page._connection?.toImpl?.(page);
  const owner = impl?.delegate?._mainFrameSession?._client;
  const session = owner ?? await page.context().newCDPSession(page);
  try {
    if (Object.hasOwn(saved, 'size')) {
      await session.send('Emulation.clearDeviceMetricsOverride');
      // Forget the pinned Playwright's cache too, including its same-size fast path.
      impl?._setEmulatedSize?.(undefined);
      if (impl?.delegate?._mainFrameSession) impl.delegate._mainFrameSession._metricsOverride = undefined;
      page._viewportSize = null;
    }
    if (saved.media) {
      const clearMedia = client => client.send('Emulation.setEmulatedMedia', { media: '', features: [] });
      if (impl?.delegate?._forAllFrameSessions)
        await impl.delegate._forAllFrameSessions(frame => clearMedia(frame._client));
      else await clearMedia(session);
      // Undefined falls back to Playwright's light/no-preference defaults on a new renderer.
      if (impl) impl._emulatedMedia = { media: 'no-override', colorScheme: 'no-override',
        reducedMotion: 'no-override', forcedColors: 'no-override', contrast: 'no-override' };
    }
    original.delete(page);
    const measured = !release && Object.hasOwn(saved, 'size') ? await innerSize(page) : null;
    return (release ? 'viewport overrides cleared' : measured
      ? `viewport restored to ${measured.width}x${measured.height}` : 'viewport restored')
      + (saved.size === null ? '; previous size unknown' : '') + (saved.media ? '; media cleared' : '');
  } finally { if (!owner) await session.detach().catch(() => {}); }
}

export async function restoreViewport(page, options) {
  // Each override remains independently restorable if the other operation fails.
  const results = await Promise.allSettled([restoreSizeAndMedia(page, options), restoreTouch(page)]);
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
  const [size, touch] = results.map(result => result.value);
  return touch ? size + '; ' + touch : size;
}

export async function setViewport(page, { width, height, color_scheme, reduced_motion, touch }) {
  const media = { ...(color_scheme === undefined ? {} : { colorScheme: color_scheme }),
    ...(reduced_motion === undefined ? {} : { reducedMotion: reduced_motion ? 'reduce' : 'no-preference' }) };
  if (width === undefined && !Object.keys(media).length && touch === undefined) return restoreViewport(page);
  if (width === undefined && !Object.keys(media).length) return 'viewport ' + await setTouch(page, touch);
  // A refused touch request must not resize the page or change its media.
  const touchNote = touch === undefined ? null : await setTouch(page, touch);
  const before = width === undefined ? null : await innerSize(page);
  let saved = original.get(page);
  if (!saved) { saved = { media: false }; original.set(page, saved); }
  // null records a failed first read. A later read is already resized and cannot replace the baseline.
  if (width !== undefined && !Object.hasOwn(saved, 'size')) saved.size = before;
  let sizeNote;
  if (width !== undefined) {
    const measured = await cssSize(page, { width, height });
    sizeNote = `viewport ${measured ? measured.width + 'x' + measured.height : width + 'x' + height}`
    + (before && saved.size ? process.env.SLEIGHT_MT !== '0'
      ? ` (was ${before.width}x${before.height}; a viewport step with no size restores it). [offscreen] means outside this viewport; [partly offscreen] means cut off by it.`
      : ` (was ${before.width}x${before.height}); a viewport step with no size restores ${saved.size.width}x${saved.size.height}`
      : '; previous size unknown');
  }
  if (Object.keys(media).length) {
    saved.media = true;
    await page.emulateMedia(media);
  }
  return [sizeNote, color_scheme === undefined ? null : 'color_scheme ' + color_scheme,
    reduced_motion === undefined ? null : 'reduced_motion ' + reduced_motion,
    touchNote].filter(Boolean).join('; ');
}

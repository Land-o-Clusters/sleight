// The viewport step of browser_act: set a size and report the old one, or give the original back.
// The original size and media stay private to this page until reset or release.
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

export async function restoreViewport(page, { release = false } = {}) {
  const saved = original.get(page);
  if (!saved || saved.reset && !release) return 'viewport unchanged: no size was set on this tab';
  if (release) {
    if (Object.hasOwn(saved, 'size')) {
      // CDP emulation belongs to the session that installed it. A separate session cannot clear Playwright's override.
      const impl = page._connection?.toImpl?.(page);
      const owner = impl?.delegate?._mainFrameSession?._client;
      const session = owner ?? await page.context().newCDPSession(page);
      try { await session.send('Emulation.clearDeviceMetricsOverride'); }
      finally { if (!owner) await session.detach().catch(() => {}); }
      // The pinned Playwright also caches emulation for future renderer sessions and size requests.
      impl?._setEmulatedSize?.(undefined);
      if (impl?.delegate?._mainFrameSession) impl.delegate._mainFrameSession._metricsOverride = undefined;
      page._viewportSize = null;
    }
    const cleared = Object.fromEntries(Object.keys(saved.media).map(key => [key, null]));
    if (Object.keys(cleared).length) await page.emulateMedia(cleared);
    original.delete(page);
    return 'viewport overrides cleared' + (saved.size === null ? '; previous size unknown' : '')
      + (Object.keys(cleared).length ? '; media cleared' : '');
  }
  if (saved.size === null) throw Error('viewport previous size unknown; release the tab to clear its size override');
  if (saved.size) await cssSize(page, saved.size);
  if (Object.keys(saved.media).length) await page.emulateMedia(saved.media);
  // A reset uses fixed emulation too. Retain the touched fields until ownership release clears them.
  saved.reset = true;
  return (saved.size ? `viewport restored to ${saved.size.width}x${saved.size.height}` : 'viewport restored')
    + (Object.keys(saved.media).length ? '; media restored' : '');
}

export async function setViewport(page, { width, height, color_scheme, reduced_motion }) {
  const media = { ...(color_scheme === undefined ? {} : { colorScheme: color_scheme }),
    ...(reduced_motion === undefined ? {} : { reducedMotion: reduced_motion ? 'reduce' : 'no-preference' }) };
  if (width === undefined && !Object.keys(media).length) return restoreViewport(page);
  const before = width === undefined ? null : await innerSize(page);
  let saved = original.get(page);
  if (!saved) { saved = { media: {} }; original.set(page, saved); }
  saved.reset = false;
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
    const prior = page._connection?.toImpl?.(page)?.emulatedMedia?.() ?? {};
    for (const key of Object.keys(media)) if (!Object.hasOwn(saved.media, key)) saved.media[key] = prior[key] === 'no-override' ? null : prior[key] ?? null;
    await page.emulateMedia(media);
  }
  return [sizeNote, color_scheme === undefined ? null : 'color_scheme ' + color_scheme,
    reduced_motion === undefined ? null : 'reduced_motion ' + reduced_motion].filter(Boolean).join('; ');
}

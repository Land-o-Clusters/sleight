// A temporary owned target receives one HTTP GET. Fetch pauses the final response before
// rendering, streams it as data and aborts the navigation. Browser download settings stay untouched.
export async function receiveDownload({ createTarget, closeTarget, url, current, allowed, receive, timeoutMs = 30000 }) {
  let targetId, cdp, requestId, stream, timer, handler, done = false, redirects = 0;
  const live = () => { if (done || !current()) throw Error('download authority expired'); };
  const check = value => { live(); const parsed = new URL(value); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || allowed(parsed.href) !== true) throw Error('download URL refused'); };
  check(url);
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Attach a handler immediately, including while setup is still awaiting CDP.
  result.catch(() => {});
  try {
    ({ targetId, cdp } = await createTarget()); live();
    const send = (method, params) => { live(); return cdp.send(method, params); };
    handler = event => {
      (async () => {
        requestId = event.requestId;
        check(event.request.url);
        if (event.request.method !== 'GET' || event.resourceType !== 'Document' || event.responseErrorReason) throw Error('download request failed');
        const status = event.responseStatusCode;
        if (status >= 300 && status < 400) {
          if (++redirects > 10) throw Error('too many download redirects');
          const location = event.responseHeaders?.find(h => h.name.toLowerCase() === 'location')?.value;
          if (!location) throw Error('download redirect has no destination');
          check(new URL(location, event.request.url).href);
          await send('Fetch.continueRequest', { requestId }); requestId = undefined; return;
        }
        if (!(status >= 200 && status < 300) || status === 204 || status === 206) throw Error('download HTTP response refused');
        const headers = Object.create(null);
        for (const { name, value } of event.responseHeaders ?? []) headers[name.toLowerCase()] = value;
        ({ stream } = await send('Fetch.takeResponseBodyAsStream', { requestId }));
        async function* chunks() {
          for (;;) {
            live();
            const part = await send('IO.read', { handle: stream, size: 65536 }); live();
            yield Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
            if (part.eof) return;
          }
        }
        await receive(headers, chunks()); live();
        resolve();
      })().catch(reject);
    };
    cdp.on('Fetch.requestPaused', handler);
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }] });
    timer = setTimeout(() => reject(Error('download timed out after 30 s')), timeoutMs);
    live();
    // Navigation remains paused until the response has been copied or refused. Its failure is expected on abort.
    send('Page.navigate', { url }).then(value => { if (value.errorText) reject(Error('download navigation failed')); }, () => reject(Error('download navigation failed')));
    await result;
  } finally {
    done = true; clearTimeout(timer);
    if (handler) cdp.off('Fetch.requestPaused', handler);
    if (stream) await cdp.send('IO.close', { handle: stream }).catch(() => {});
    if (requestId) await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
    if (targetId) await closeTarget(targetId);
  }
}

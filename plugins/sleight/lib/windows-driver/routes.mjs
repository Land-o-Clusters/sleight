// This opt-in belongs to one client call. There is no session-wide foreground mode.
export async function foregroundFallback({ action, identity, args, background, verify, foreground }) {
  if (foreground !== undefined && typeof foreground !== 'function')
    throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' });
  try { return await background(); }
  catch (error) {
    // A failure after any attempted input is not permission to replay it elsewhere.
    if (error?.code !== 'BACKGROUND_UNAVAILABLE' || error.unhealthy || !foreground || /input may have landed/i.test(error.message)) throw error;
    await verify();
    try {
      const result = await foreground({ action, identity: { ...identity }, args: structuredClone(args) });
      return { ...result, confirmation: result?.confirmation ?? 'unconfirmed', action,
        route: 'foreground', foregroundRoute: result?.route ?? 'caller', tookFocus: true };
    } catch (cause) {
      throw Object.assign(new Error(`${action}: foreground adapter failed; focus may have changed. ${cause?.message ?? ''}`, { cause }),
        { code: cause?.code ?? 'FOREGROUND_UNCONFIRMED', route: 'foreground', tookFocus: true });
    }
  }
}

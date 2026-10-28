// No model-supplied app, decision, credential or completion assertion. The
// relay binds this to its last engine-confirmed native app and owns acquisition.
export const NATIVE_HANDOFF_TOOL = Object.freeze({
  name: 'app_handoff',
  description: "Non-browser app sign-in only. Present: await user's Continue; reread same app, new windows too. Away: end turn, ask user to sign in and reply. Never request passwords/codes. Cancel keeps app open.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

// Separate private consent pipe, even when turbo owns the shared host's pipe.
// The source-bound helper compiler and native GB12 guard are the same ones.
export async function openNativeHandoffUi() {
  const { appleToolsPresent, prepareHandoffUi } = await import('./direct-browser/host.mjs');
  if (!await appleToolsPresent()) throw Error('TRUSTED_UI_UNAVAILABLE');
  return prepareHandoffUi();
}

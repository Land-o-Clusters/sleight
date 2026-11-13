// Host stamping for offline fixtures that represent mod calls, never model calls.
export const MOD_ID = 'toolu_plugin_' + '0123456789abcdef'.repeat(2);
export const MODEL_ID = 'toolu_0123456789aBcDeFgHiJkLmN';
export const MOD_META = { 'claudecode/toolUseId': MOD_ID };
export function modCall(message) {
  if (message.method !== 'tools/call' || message.params?.name !== 'turn_ended') return message;
  return { ...message, params: { ...message.params, _meta: { ...message.params._meta, ...MOD_META } } };
}

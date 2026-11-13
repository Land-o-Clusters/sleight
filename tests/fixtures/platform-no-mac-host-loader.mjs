export function resolve(specifier, context, next) {
  const url = new URL(specifier, context.parentURL ?? import.meta.url).href;
  if (url.endsWith('/direct-browser/host.mjs')) throw Error('MAC_HOST_LOADED');
  return next(specifier, context);
}

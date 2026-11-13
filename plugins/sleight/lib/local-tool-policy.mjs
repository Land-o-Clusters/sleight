import { forbiddenTargetWarning, isForbiddenSettingsWindow, refusalNotice } from './blocked-apps.mjs';

export const LOCAL_TOOL_ARGUMENT_NOTICE = 'Invalid local tool arguments; follow the advertised inputSchema.';

// Validate the advertised schema before approvals, target lookup or private
// relay augmentation. Description-only schemas (drag endpoints) accept JSON.
export function validateLocalArguments(tool, args) {
  if (!tool?.inputSchema) throw Error(LOCAL_TOOL_ARGUMENT_NOTICE);
  function check(value, schema, path = 'arguments', depth = 0) {
    if (depth > 12) throw Error('Local arguments are too deep');
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (!['object', 'array', 'null', 'string', 'boolean', 'number'].includes(type) ||
        type === 'number' && !Number.isFinite(value)) throw Error(`${path} requires JSON`);
    const types = [].concat(schema.type ?? []);
    if (types.length && !types.includes(type) && !(types.includes('integer') && Number.isInteger(value)))
      throw Error(`${path} has an invalid type`);
    if (schema.enum && !schema.enum.includes(value)) throw Error(`${path} has an unsupported value`);
    if (type === 'object') {
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw Error(`${path} needs ${key}`);
      for (const [key, item] of Object.entries(value)) {
        if (schema.additionalProperties === false && !Object.hasOwn(properties, key)) throw Error(`${path} has an unknown field`);
        check(item, properties[key] ?? {}, `${path}.${key}`, depth + 1);
      }
    } else if (type === 'array') {
      if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw Error(`${path} has an invalid length`);
      for (const item of value) check(item, schema.items ?? {}, path, depth + 1);
    } else if (type === 'string') {
      if ([...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity)) throw Error(`${path} has an invalid length`);
    } else if (type === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)))
      throw Error(`${path} is out of range`);
  }
  try { check(args, tool.inputSchema); }
  catch (cause) { throw new Error(LOCAL_TOOL_ARGUMENT_NOTICE, { cause }); }
}

export function localTargetPolicy(name, args, resolved, allowForbidden = false) {
  if (name === 'notifications' || name === 'menu_bar' && args.op === 'apps') return {};
  // Check the literal and resolved identities independently. An alias never
  // hides a forbidden bundle, and a bundle cannot erase a literal refusal.
  const warning = forbiddenTargetWarning(resolved?.appId) ?? forbiddenTargetWarning(resolved?.app) ?? forbiddenTargetWarning(args.app);
  if (!warning) return {};
  if (allowForbidden !== true) return { refusal: refusalNotice(resolved?.appId || resolved?.app || args.app) };
  const title = args.title ?? args.windowTitle;
  const window = [resolved, { app: args.app, title }, { ...resolved, title }].find(isForbiddenSettingsWindow);
  if (window) return { refusal: `${window.app}'s settings window is refused, so Claude can't change its approval or safety settings. Close it or read another window.` };
  return { warning };
}

// Private protocol validation. No tools, notices, desktop access or registration.
export const SEMANTIC_METHODS = Object.freeze(['setValue', 'selectText', 'performSecondaryAction', 'paste']);
const invalid = () => { throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, empty = true) => typeof value === 'string' && (empty || value.length > 0) && value.length <= 1_048_576 && Buffer.byteLength(value, 'utf8') <= 1_048_576;
const target = value => Number.isSafeInteger(value) && value >= 0 || object(value) && Object.keys(value).length === 1 &&
  (value.focused === true || ['id', 'label'].some(key => text(value[key], false) && value[key].length <= 16_384));
export function validateSemanticArguments(method, args) {
  if (!SEMANTIC_METHODS.includes(method)) return;
  if (!Array.isArray(args)) return invalid();
  if (method === 'setValue') {
    if (args.length !== 2 || !target(args[0]) || !(text(args[1]) || typeof args[1] === 'boolean' || typeof args[1] === 'number' && Number.isFinite(args[1]))) return invalid();
  } else if (method === 'selectText') {
    if (![2, 3].includes(args.length) || !target(args[0]) || !text(args[1], false)) return invalid();
    if (args.length === 3) {
      const options = args[2];
      if (!object(options) || Object.keys(options).some(key => !['prefix', 'suffix', 'selectionType'].includes(key)) ||
          ['prefix', 'suffix'].some(key => Object.hasOwn(options, key) && !text(options[key])) ||
          Object.hasOwn(options, 'selectionType') && !['text', 'cursor_before', 'cursor_after'].includes(options.selectionType)) return invalid();
    }
  } else if (method === 'performSecondaryAction') {
    if (args.length !== 2 || !target(args[0]) || !text(args[1], false)) return invalid();
  } else {
    if (![1, 2].includes(args.length) || !text(args[0])) return invalid();
    if (args.length === 2 && (!object(args[1]) || Object.keys(args[1]).some(key => key !== 'format') ||
        Object.hasOwn(args[1], 'format') && !['text', 'md', 'html'].includes(args[1].format))) return invalid();
  }
}

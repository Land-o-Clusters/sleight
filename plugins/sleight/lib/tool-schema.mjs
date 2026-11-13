// Some Claude Code versions (2.1.289 measured, 2026-11-09) drop a tool whose input schema has oneOf or anyOf at its
// root. The ChatGPT engine 26.1103.41825 gave js exactly that shape ("code" or "completion_summary"), so on those
// versions the model got no js tool at all. sleight advertises one flat object instead: every branch's properties,
// with only the fields every branch requires. The engine still checks each call against its own schema.
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function flatRootSchema(schema) {
  if (!isObject(schema)) return schema;
  const key = Array.isArray(schema.oneOf) ? 'oneOf' : Array.isArray(schema.anyOf) ? 'anyOf' : undefined;
  // A root allOf would still be a root combinator after merging, so such a schema is left as it is.
  if (!key || schema.oneOf && schema.anyOf || schema.allOf) return schema;
  const branches = schema[key];
  if (!branches.length || !branches.every(b => isObject(b) && (b.type === undefined || b.type === 'object') &&
    (b.properties === undefined || isObject(b.properties)) && (b.required === undefined || Array.isArray(b.required)) &&
    !b.oneOf && !b.anyOf && !b.allOf && !b.$ref)) return schema;
  if (schema.type !== undefined && schema.type !== 'object') return schema;
  const properties = { ...(isObject(schema.properties) ? schema.properties : {}) };
  for (const branch of branches) {
    for (const [name, value] of Object.entries(branch.properties ?? {})) {
      // Two branches that disagree on one field can't be merged honestly; leave the engine's schema as it is.
      if (Object.hasOwn(properties, name) && !same(properties[name], value)) return schema;
      properties[name] = value;
    }
  }
  const everyBranch = branches.map(b => new Set(b.required ?? []));
  const required = [...new Set([...(schema.required ?? []),
    ...[...everyBranch[0]].filter(name => everyBranch.every(set => set.has(name)))])];
  const closed = schema.additionalProperties === false || branches.every(b => b.additionalProperties === false);
  const { oneOf, anyOf, required: _required, ...rest } = schema;
  const flat = { ...rest, type: 'object', properties };
  if (required.length) flat.required = required;
  if (closed) flat.additionalProperties = false;
  return flat;
}

// The flat schema lets a model send fields from two branches at once (Haiku sent code, title and completion_summary
// together on 2026-11-10, and the engine refused every such call). Before forwarding, keep the first branch, in the
// engine's order, whose required fields are all present, and drop the fields that branch doesn't allow. A closed
// branch allows only its own properties, even where the root lists more (the engine's js root lists all four).
// sleight_ fields are the mod's private frames, which the relay reads and removes itself before forwarding.
// missing lists every branch's required fields when the call meets no branch.
export function fitBranch(schema, args) {
  const branches = isObject(schema) ? schema.oneOf ?? schema.anyOf : undefined;
  if (!Array.isArray(branches) || !isObject(args)) return { args, dropped: [] };
  const branch = branches.find(b => isObject(b) && (b.required ?? []).every(name => Object.hasOwn(args, name)));
  if (!branch) return { args, dropped: [], missing: branches.flatMap(b => (isObject(b) && b.required) || []) };
  if (branch.additionalProperties !== false) return { args, dropped: [] };
  const allowed = new Set(Object.keys(branch.properties ?? {}));
  const dropped = Object.keys(args).filter(name => !allowed.has(name) && !name.startsWith('sleight_'));
  if (!dropped.length) return { args, dropped };
  return { args: Object.fromEntries(Object.entries(args).filter(([name]) => !dropped.includes(name))), dropped };
}

// log gets one line when a root oneOf or anyOf stays, since Claude Code 2.1.289 then drops the tool without a word.
export function flatTool(tool, log = () => {}) {
  if (!isObject(tool) || !isObject(tool.inputSchema)) return tool;
  const inputSchema = flatRootSchema(tool.inputSchema);
  if (inputSchema !== tool.inputSchema) return { ...tool, inputSchema };
  const kept = ['oneOf', 'anyOf'].filter(key => Object.hasOwn(tool.inputSchema, key));
  if (kept.length) log(`sleight: ${tool.name} keeps its root ${kept.join(' and ')} schema, which Claude Code 2.1.289 drops from the tool list.`);
  return tool;
}

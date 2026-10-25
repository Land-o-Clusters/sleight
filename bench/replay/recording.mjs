import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { evidenceRoots } from '../evidence.mjs';

export function toolAddress(name, server) {
  if (server) {
    if (!['plugin_sleight_computer', 'plugin:sleight:computer', 'sleight-turbo'].includes(server)) throw Error(`Unsupported server: ${server}`);
    return { server: server === 'plugin_sleight_computer' ? 'plugin:sleight:computer' : server, name };
  }
  const match = /^mcp__(plugin_sleight_computer|sleight-turbo)__(\w+)$/.exec(name);
  if (!match) throw Error(`Unsupported recorded tool: ${name}`);
  return toolAddress(match[2], match[1]);
}

export function parseRecording(source) {
  const events = source.trim().split('\n').filter(Boolean).map((line, i) => {
    try { return JSON.parse(line); } catch { throw Error(`Invalid transcript JSON on line ${i + 1}`); }
  });
  const calls = [], pending = new Map(), seen = new Set();
  const start = call => {
    if (!call.id || seen.has(call.id)) throw Error(`Duplicate or missing call id: ${call.id}`);
    // Replay serializes tool-use emission order, even if the original host overlapped calls.
    if (typeof call.arguments === 'string') {
      try { call.arguments = JSON.parse(call.arguments); } catch { throw Error(`Invalid tool arguments: ${call.id}`); }
    }
    if (!call.arguments || Array.isArray(call.arguments) || typeof call.arguments !== 'object') throw Error(`Invalid tool arguments: ${call.id}`);
    seen.add(call.id); calls.push(call); pending.set(call.id, call);
  };
  const finish = (id, result) => {
    const call = pending.get(id);
    if (!call) throw Error(`Unpaired result: ${id}`);
    call.result = result; pending.delete(id);
  };
  for (const event of events) {
    if (event.parent_tool_use_id) throw Error('Nested agent transcripts are unsupported');
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block.type === 'tool_use') start({ id: block.id, ...toolAddress(block.name), arguments: block.input });
      if (block.type === 'tool_result') finish(block.tool_use_id, {
        content: typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content,
        isError: block.is_error === true || event.tool_use_result?.isError === true,
      });
    }
    const item = event.item;
    if (item?.type !== 'mcp_tool_call') continue;
    if (event.type === 'item.started') start({ id: item.id, ...toolAddress(item.tool, item.server), arguments: item.arguments });
    if (event.type === 'item.completed') {
      if (!pending.has(item.id)) throw Error(`Missing item.started: ${item.id}`);
      finish(item.id, { ...(item.result ?? { content: [{ type: 'text', text: JSON.stringify(item.error) }] }),
        isError: item.status === 'failed' || !!item.error || item.result?.isError === true });
    }
  }
  if (pending.size) throw Error(`Missing recorded result: ${[...pending.keys()].join(', ')}`);
  if (!calls.length) throw Error('No replayable tool calls');
  return calls;
}

const json = file => JSON.parse(readFileSync(file, 'utf8'));
export function loadRecording(input, { task, arm, run, evidence } = {}) {
  input = resolve(input);
  let row, metadata, folder, folders, transcript;
  if (input.endsWith('.json')) {
    metadata = json(input);
    const rows = Array.isArray(metadata) ? metadata : metadata.results ?? (metadata.task ? [metadata] : undefined);
    const selected = rows?.filter(r => (!task || (typeof r.task === 'string' ? r.task : r.task?.name) === task) &&
      (!arm || r.arm === arm || r.surface === arm) && (!run || r.run === run));
    if (selected?.length !== 1) throw Error('Select exactly one results row with --task, --arm and --run');
    row = selected[0];
    if (evidence) folder = resolve(evidence);
    else if (typeof row.task === 'object') folder = basename(input) === 'run.json' ? dirname(input) : join(dirname(input), row.task.name);
    else {
      if (!metadata.stamp) throw Error('Native results need a stamp or --evidence');
      folders = evidenceRoots().map(base => join(base, metadata.stamp, `${row.arm}-${row.task}-${row.run}`));
    }
  } else {
    folder = input.endsWith('.jsonl') ? dirname(input) : input;
    row = existsSync(join(folder, 'run.json')) ? json(join(folder, 'run.json')) : undefined;
    metadata = row;
  }
  folders ??= [folder];
  transcript = folders.flatMap(dir => [join(dir, 'events.jsonl'), join(dir, 'transcript.jsonl')]).find(existsSync);
  if (!transcript) throw Error(`Transcript missing in ${folders.join('; ')}; native transcripts are written by bench/driver.mjs to the benchmark home's evidence folder, with legacy temp recordings in sleight-real-evidence`);
  folder = dirname(transcript);
  const source = readFileSync(transcript, 'utf8'), calls = parseRecording(source);
  const race = typeof row?.task === 'object';
  const browserFile = join(dirname(folder), 'browser.json');
  return { folder, transcript, transcriptSHA256: createHash('sha256').update(source).digest('hex'), row, metadata, calls, kind: race ? 'race' : 'native',
    task: race ? row.task : { id: row?.task ?? basename(folder) },
    browser: race && existsSync(browserFile) ? json(browserFile) : undefined };
}

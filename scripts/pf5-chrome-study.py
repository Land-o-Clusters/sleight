#!/usr/bin/env python3
"""Read retained Chrome events. No models, servers, browser or host operations."""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
from statistics import mean, median


def stamp(value):
    return round(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def union(intervals):
    total, end = 0, 0
    for start, stop in sorted(intervals):
        assert stop >= start
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def read_task(path):
    raw = (path / 'events.jsonl').read_bytes()
    events = [json.loads(line) for line in raw.splitlines() if line]
    run = json.loads((path / 'run.json').read_text())
    calls, first_input, messages = {}, None, set()
    for line, event in enumerate(events, 1):
        message = event.get('message', {})
        if event['type'] == 'assistant':
            messages.add(message['id'])
            if first_input is None:
                usage = message.get('usage', {})
                first_input = sum(usage.get(k, 0) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))
        for item in message.get('content', []):
            if not isinstance(item, dict):
                continue
            if item.get('type') == 'tool_use':
                assert item['id'] not in calls
                calls[item['id']] = dict(id=item['id'], line=line, start=stamp(event['timestamp']),
                    tool=item['name'].split('__')[-1], input=item['input'])
            if item.get('type') == 'tool_result':
                call = calls[item['tool_use_id']]
                content = item.get('content', '')
                text = content if isinstance(content, str) else '\n'.join(c.get('text', '') for c in content)
                call.update(end=stamp(event['timestamp']), result_line=line, result=text,
                    result_bytes=len(text.encode()), error=item.get('is_error', False))
    calls = list(calls.values())
    for c in calls:
        c['ms'] = c['end'] - c['start']
    result = run['run']['result']
    usage = result.get('usage', {})
    metrics = [json.loads(line) for line in (path / 'turbo-metrics.jsonl').read_text().splitlines()]
    # The same run can open several tabs. Match the first call's ordinal,
    # never the last phase with that name to the first transcript call.
    phases = {m['phase']: stamp(m['t']) for m in metrics if 't' in m and m.get('call') == 1}
    open_start, open_end = phases.get('browser-open-start'), phases.get('browser-open-end')
    open_call = next((c for c in calls if c['tool'] == 'browser_open'), None)
    tools = union([(c['start'], c['end']) for c in calls])
    wall, agent = run['wallMs'], round(run['agentSeconds'] * 1000)
    return dict(round=path.parent.name, task=path.name, wall=wall, agent=agent,
        tools=tools, outside=agent-tools, harness=wall-agent, api=result['duration_api_ms'],
        turns=result['num_turns'], messages=len(messages), first_input=first_input,
        output=usage.get('output_tokens', 0), thinking=usage.get('output_tokens_details', {}).get('thinking_tokens', 0),
        result_bytes=sum(c['result_bytes'] for c in calls), calls=calls,
        open_ms=open_end-open_start if open_end and open_start else None,
        pre_open_ms=open_start-open_call['start'] if open_start and open_call else None,
        post_open_ms=open_call['end']-open_end if open_end and open_call else None,
        capture_ms=phases['browser-open-capture-end']-phases['browser-open-capture-start'] if 'browser-open-capture-end' in phases else None,
        outcome=run.get('outcome'), grade=run.get('grade'), permission=events[0].get('permissionMode'),
        sha256=hashlib.sha256(raw).hexdigest())


def summary(rows):
    for task in sorted({r['task'] for r in rows}):
        sides = {}
        for side in 'AB':
            group = [r for r in rows if r['task'] == task and f'-{side}-r' in r['round']]
            sides[side] = {k: round(mean(r[k] for r in group), 3) for k in
                ('wall', 'agent', 'tools', 'outside', 'harness', 'api', 'turns', 'first_input', 'output', 'thinking', 'result_bytes')}
            sides[side].update(walls=[r['wall'] for r in group], median=median(r['wall'] for r in group),
                calls=[len(r['calls']) for r in group], turns_list=[r['turns'] for r in group],
                outcomes=[r['outcome'] for r in group],
                tool_counts=dict(Counter(c['tool'] for r in group for c in r['calls'])))
            passes = sorted(r['wall'] for r in group if r['outcome']['ok'])
            sides[side]['score_median'] = passes[(len(passes)-1)//2] if passes else None
            sides[side]['residual'] = round(sides[side]['outside']-sides[side]['api'], 3)
        yield dict(task=task, **sides)


def markdown(rows):
    print('| Task | Side | Wall s | Outside calls s | API s | Tool union s | Harness s | Turns | Calls |')
    print('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    summaries = list(summary(rows))
    for item in summaries:
        for side in 'AB':
            r = item[side]
            values = ' | '.join(f'{r[k]/1000:.3f}' for k in ('wall', 'outside', 'api', 'tools', 'harness'))
            print(f"| {item['task']} | {side} | {values} | {r['turns']:.1f} | {sum(r['calls'])} |")
    print('\n| Task | A wall s, r1 to r5 | B wall s, r1 to r5 | Score median A/B s | B slower pairs |')
    print('| --- | --- | --- | --- | ---: |')
    for item in summaries:
        a, b = item['A'], item['B']
        samples = [' / '.join(f'{v/1000:.3f}' for v in item[side]['walls']) for side in 'AB']
        print(f"| {item['task']} | {' | '.join(samples)} | {a['score_median']/1000:.3f} / {b['score_median']/1000:.3f} | {sum(y>x for x,y in zip(a['walls'], b['walls']))}/5 |")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bank', type=Path)
    parser.add_argument('--task')
    parser.add_argument('--calls', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--markdown', action='store_true')
    args = parser.parse_args()
    paths = sorted(args.bank.glob('*/' + (args.task or '*') + '/run.json'))
    rows = [read_task(path.parent) for path in paths if '-A-r' in path.parent.parent.name or '-B-r' in path.parent.parent.name]
    if args.markdown:
        markdown(rows)
    elif args.json:
        print(json.dumps(rows, indent=2))
    elif args.calls:
        for row in rows:
            print(row['round'], row['task'], 'wall', row['wall'], 'api', row['api'], 'turns', row['turns'])
            for call in row['calls']:
                print(call['line'], call['tool'], call['ms'], json.dumps(call['input']),
                    json.dumps(call['result'].split('\n# ')[0][:700]))
    else:
        for row in summary(rows):
            print(json.dumps(row))

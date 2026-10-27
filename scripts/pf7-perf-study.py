#!/usr/bin/env python3
"""Offline PF7 evidence census and uncertainty analysis. Never imports a runner."""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import random
import re
import statistics as st


def millis(value):
    return round(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def lower(values):
    values = sorted(values)
    return values[(len(values) - 1) // 2] if values else None


def union(intervals):
    end = total = 0
    for start, stop in sorted(intervals):
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def read_run(path):
    run = json.loads((path / 'run.json').read_text())
    raw = (path / 'events.jsonl').read_bytes()
    events = [json.loads(line) for line in raw.splitlines() if line]
    calls, turns, first_input, thinking = {}, {}, None, 0
    for line, event in enumerate(events, 1):
        message = event.get('message', {})
        if event.get('type') == 'assistant':
            key = message.get('id', event.get('uuid', str(line)))
            turns.setdefault(key, {'start': millis(event['timestamp']), 'calls': []})
            # Stream-json may split one message into multiple content events.
            turns[key]['thinking'] = max(turns[key].get('thinking', 0), event.get('thinking_duration_ms', 0))
            if first_input is None:
                usage = message.get('usage', {})
                first_input = sum(usage.get(k, 0) for k in ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
        for item in message.get('content', []):
            if not isinstance(item, dict):
                continue
            if item.get('type') == 'tool_use':
                calls[item['id']] = dict(tool=item['name'].split('__')[-1], args=item['input'], start=millis(event['timestamp']), line=line, turn=key)
                turns[key]['calls'].append(item['id'])
            elif item.get('type') == 'tool_result':
                call = calls[item['tool_use_id']]
                content = item.get('content', '')
                text = content if isinstance(content, str) else '\n'.join(x.get('text', '') for x in content)
                call.update(end=millis(event['timestamp']), text=text, bytes=len(text.encode()), error=bool(item.get('is_error')))
    rows = list(calls.values())
    tool_ms = union([(c['start'], c['end']) for c in rows])
    counts = Counter(c['tool'] for c in rows)
    gaps = []
    for turn in turns.values():
        previous = [c['end'] for c in rows if c['end'] <= turn['start']]
        if previous:
            gaps.append(turn['start'] - max(previous))
    categories = Counter()
    for turn in turns.values():
        cs = [calls[c] for c in turn['calls']]
        if cs and all(c['tool'] == 'browser_read' for c in cs):
            categories['read_only'] += 1
        if any(any(s.get('do') == 'wait' for s in c['args'].get('steps', [])) for c in cs):
            categories['with_wait'] += 1
        if any(c['error'] or ': not run:' in c['text'] for c in cs):
            categories['with_refusal'] += 1
        if any('unknown or releasing' in c['text'] or 'stale ref' in c['text'] or 'only for a stuck tab' in c['text'] for c in cs):
            categories['recovery_trigger'] += 1
    read_after, popup_reads, form_batches = [], [], []
    for i, call in enumerate(rows):
        if call['tool'] != 'browser_read' or i == 0:
            continue
        previous = rows[i-1]
        options = set(call['args']) - {'tab', 'max_chars', 'text'}
        if previous['tool'] in ['browser_act', 'browser_fill'] and call['args'].get('tab') == previous['args'].get('tab') and not options and call['start'] >= previous['end']:
            read_after.append({'line': call['line'], 'previous_line': previous['line'], 'ms': call['end']-previous['end'],
                               'none': previous['args'].get('observe') == 'none', 'bytes': call['bytes']})
        opened = re.findall(r'opened background tab (t[A-Za-z0-9_-]+)', previous['text'])
        if previous['tool'] == 'browser_act' and len(opened) == 1 and call['args'].get('tab') == opened[0] and not options and call['start'] >= previous['end']:
            solo = len(turns[call['turn']]['calls']) == 1
            popup_reads.append({'line': call['line'], 'solo_turn': solo, 'gap_ms': call['start']-previous['end'],
                                'read_ms': call['end']-call['start'], 'child_bytes': call['bytes'],
                                # browser_read's text switch does not change its snapshot;
                                # require the same 8000-character budget as the eager read.
                                'candidate': call['args'].get('max_chars', 8000) == 8000 and previous['args'].get('observe') not in ['none','screenshot']})
    for i, call in enumerate(rows):
        if i == 0 or call['tool'] != 'browser_fill': continue
        previous = rows[i-1]
        if previous['tool'] == 'browser_fill' and previous['args'].get('tab') == call['args'].get('tab') and call['start'] >= previous['end']:
            form_batches.append({'line': call['line'], 'previous_line': previous['line'],
                                 'gap_ms': call['start']-previous['end'], 'fields': len(call['args'].get('fields',[])),
                                 'previous_fields': len(previous['args'].get('fields',[]))})
    result = run['run']['result']
    phases = [json.loads(line) for line in (path / 'turbo-metrics.jsonl').read_text().splitlines()]
    captures = {}
    for phase in phases:
        if phase['phase'] == 'browser-open-capture-start': captures[phase['call']] = millis(phase['t'])
    capture_ms = sum(millis(p['t'])-captures[p['call']] for p in phases if p['phase'] == 'browser-open-capture-end' and p['call'] in captures)
    return {'task': path.name, 'side': path.parent.name.split('-')[-2], 'round': int(path.parent.name.rsplit('r', 1)[1]),
            'wall_ms': run['wallMs'], 'passed': run['outcome']['ok'], 'tool_ms': tool_ms,
            'host_outer_ms': run['wallMs']-round(run['agentSeconds']*1000),
            'outside_tools_ms': round(run['agentSeconds']*1000)-tool_ms,
            'api_ms': result['duration_api_ms'], 'thinking_ms': sum(t.get('thinking', 0) for t in turns.values()),
            'turns': len(turns), 'sdk_turns': result['num_turns'], 'calls': len(rows), 'counts': dict(counts), 'categories': dict(categories),
            'gaps_ms': gaps, 'bytes': sum(c['bytes'] for c in rows), 'first_input': first_input,
            'output_tokens': result['usage']['output_tokens'], 'capture_ms': capture_ms,
            'read_after': read_after, 'popup_reads': popup_reads, 'adjacent_fills': form_batches,
            'full_calls': sum(c['args'].get('observe') == 'full' for c in rows),
            'wait_steps': sum(s.get('do') == 'wait' for c in rows for s in c['args'].get('steps', [])),
            'wait_result_ms': [int(m) for c in rows for m in re.findall(r'(?:condition (?:not )?met|settled|page quiet|page activity still pending) after (\d+) ms', c['text'])],
            'wait_not_reached': sum(len(re.findall(r'\d+ wait: not reached', c['text'])) for c in rows),
            'screenshot_calls': sum(c['args'].get('screenshot') is True or c['args'].get('observe') == 'screenshot' for c in rows),
            'source_sha256': hashlib.sha256(raw).hexdigest(),
            'run_sha256': hashlib.sha256((path / 'run.json').read_bytes()).hexdigest(),
            'metrics_sha256': hashlib.sha256((path / 'turbo-metrics.jsonl').read_bytes()).hexdigest(),
            'trajectory': [{'line': c['line'], 'tool': c['tool'], 'ops': [s.get('do') for s in c['args'].get('steps', [])],
                            'fields': len(c['args'].get('fields', [])), 'observe': c['args'].get('observe'),
                            'ms': c['end']-c['start'], 'error': c['error'], 'bytes': c['bytes']} for c in rows]}


def score(cells):
    totals = {s: sum(lower([r['wall_ms'] for r in rows if r['passed']]) for (t, side), rows in cells.items() if side == s) for s in 'AB'}
    return totals['B']/totals['A']-1


def bootstrap(cells, draws, cluster):
    rng = random.Random(71027 + cluster)
    values, empty = [], 0
    for _ in range(draws):
        pair = [rng.randrange(5) for _ in range(5)]
        sample = {key: [rows[i] for i in (pair if cluster else [rng.randrange(5) for _ in range(5)])] for key, rows in cells.items()}
        if any(not any(r['passed'] for r in rows) for rows in sample.values()):
            empty += 1
            continue
        values.append(score(sample))
    values.sort()
    log_se = st.stdev(math.log1p(v) for v in values)
    margin = math.log((1+score(cells))/1.08)
    # Local normal approximation for planning only. A pilot of five cannot identify tail behavior.
    planning = {label: math.ceil(5*((1.6448536269514722+0.8416212335729143)*log_se/gap)**2)
                for label, gap in [('separate_9pct_from_8pct', margin), ('certify_flat_below_8pct', math.log(1.08)),
                                   ('certify_5pct_win_below_flat', -math.log(.95))]}
    return {'draws': draws, 'unscorable': empty, 'ci95': [values[int(.025*len(values))], values[int(.975*len(values))]],
            'sd_percentage_points': st.stdev(values)*100, 'fraction_over_8pct': sum(v>.08 for v in values)/len(values),
            'log_se': log_se, 'planning_runs_per_side_per_task_80pct_power_one_sided_5pct': planning}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('bank', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--score', type=Path, help='Optional frozen score receipt to cross-check, never execute')
    parser.add_argument('--draws', type=int, default=20000)
    args = parser.parse_args()
    runs = [read_run(p.parent) for p in sorted(args.bank.glob('rerun-chrome-haiku-*/**/run.json'))]
    assert len(runs) == 130, len(runs)
    tasks = sorted({r['task'] for r in runs})
    cells = {(t,s): sorted([r for r in runs if r['task']==t and r['side']==s], key=lambda r:r['round']) for t in tasks for s in 'AB'}
    assert all(len(v)==5 for v in cells.values())
    summary = []
    for task in tasks:
        row = {'task': task}
        for side in 'AB':
            rs = cells[task, side]
            row[side] = {'samples_s': [r['wall_ms']/1000 for r in rs], 'passes': sum(r['passed'] for r in rs),
                         'score_s': lower([r['wall_ms'] for r in rs if r['passed']])/1000,
                         'best_s': min(r['wall_ms'] for r in rs if r['passed'])/1000,
                         'mean_s': st.mean(r['wall_ms']/1000 for r in rs),
                         **{k: sum(r[k] for r in rs) for k in ['wall_ms','tool_ms','host_outer_ms','outside_tools_ms','api_ms','thinking_ms','turns','sdk_turns','calls','bytes','full_calls','wait_steps']},
                         'categories': dict(sum((Counter(r['categories']) for r in rs), Counter())),
                         'counts': dict(sum((Counter(r['counts']) for r in rs), Counter())),
                         'read_after_count': sum(len(r['read_after']) for r in rs),
                         'read_after_exposed_ms': sum(x['ms'] for r in rs for x in r['read_after']),
                         'popup_read_turns': sum(p['solo_turn'] and p['candidate'] for r in rs for p in r['popup_reads']),
                         'popup_gap_ms': sum(p['gap_ms'] for r in rs for p in r['popup_reads'] if p['solo_turn'] and p['candidate']),
                         'wait_result_ms': sum(sum(r['wait_result_ms']) for r in rs),
                         'wait_not_reached': sum(r['wait_not_reached'] for r in rs)}
        summary.append(row)
    simulations = {}
    for label, popup, capture_proxy in [('popup_gap_only', True, 0), ('capture_25ms_proxy', False, 25), ('both', True, 25)]:
        adjusted = {key: [{**r, 'wall_ms': r['wall_ms'] - (sum(p['gap_ms'] for p in r['popup_reads'] if p['solo_turn'] and p['candidate']) if popup and key[1] == 'B' else 0)
                          - (capture_proxy*r['full_calls'] if key[1] == 'B' else 0)} for r in rows] for key, rows in cells.items()}
        simulations[label] = {'score': score(adjusted), 'B_score_s': sum(lower([r['wall_ms'] for r in rs if r['passed']]) for (t,s),rs in adjusted.items() if s == 'B')/1000,
                              'per_task_B_score_s': {t: lower([r['wall_ms'] for r in adjusted[t,'B'] if r['passed']])/1000 for t in tasks}}
    answer = {'statistic': 'sum of passing lower medians; failures retained separately', 'score': score(cells),
              'simulation_warning': 'Conditional transcript arithmetic, not measured speed or a prediction. Full capture costs use an unmeasured 25 ms proxy.',
              'simulations': simulations,
              'bootstrap_independent_cells': bootstrap(cells,args.draws,False),
              'bootstrap_paired_round_clusters': bootstrap(cells,args.draws,True), 'summary': summary, 'runs': runs}
    if args.score:
        raw = args.score.read_bytes()
        receipt_text = raw.decode()
        receipt = json.loads(receipt_text if receipt_text.lstrip().startswith('{') else receipt_text.split('\n', 1)[1])
        verdict = next(v for v in receipt['verdicts'] if v['kind'] == 'chrome-haiku')
        assert math.isclose(verdict['slowdown'], answer['score'], abs_tol=1e-12)
        for side in 'AB':
            assert sum(r[side]['passes'] for r in summary) == verdict['pass'+side]
            assert math.isclose(sum(r[side]['score_s'] for r in summary), verdict[side.lower()+'Total'], abs_tol=1e-9)
        assert {r['task'] for r in summary} == {r['task'] for r in verdict['tasks']}
        for item in verdict['tasks']:
            row = next(r for r in summary if r['task'] == item['task'])
            assert math.isclose(row['B']['score_s']/row['A']['score_s']-1, item['slowdown'], abs_tol=1e-12)
        answer['frozen_score'] = {'sha256': hashlib.sha256(raw).hexdigest(), 'identity': receipt['identity'],
                                  'aggregate_and_13_task_crosscheck': 'passed'}
    args.out.write_text(json.dumps(answer, indent=2)+'\n')
    print(json.dumps({k:v for k,v in answer.items() if k not in ['summary','runs']}, indent=2))
    print('task | score A/B | best either | calls A/B | tool s A/B | outside s A/B | host s A/B | read-after A/B')
    for row in summary:
        a,b=row['A'],row['B']
        print(f"{row['task']} | {a['score_s']:.3f}/{b['score_s']:.3f} | {min(a['best_s'],b['best_s']):.3f} | {a['calls']}/{b['calls']} | "
              f"{a['tool_ms']/5000:.2f}/{b['tool_ms']/5000:.2f} | {a['outside_tools_ms']/5000:.2f}/{b['outside_tools_ms']/5000:.2f} | "
              f"{a['host_outer_ms']/5000:.2f}/{b['host_outer_ms']/5000:.2f} | {a['read_after_count']}/{b['read_after_count']}")


if __name__ == '__main__':
    main()

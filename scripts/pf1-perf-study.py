#!/usr/bin/env python3
"""Summarize saved Claude tool events. Reads files only; never starts an arm."""

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path


def timestamp(value):
    return round(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def content_text(content):
    if isinstance(content, str):
        return content
    return "\n".join(item.get("text", "") for item in content if isinstance(item, dict))


def union_ms(intervals):
    total, end = 0, 0
    for start, stop in sorted(intervals):
        total += max(0, stop - max(start, end))
        end = max(end, stop)
    return total


def operation(args):
    # No URLs, field values, page text or model reasoning go into this report.
    if "steps" in args:
        counts = Counter(step.get("do", "unknown") for step in args["steps"])
        return ", ".join(f"{op}:{count}" for op, count in counts.items())
    if "fields" in args:
        return f"fields:{len(args['fields'])}"
    if "do" in args:
        return args["do"] + (" wait" if args.get("wait") else "")
    return "read/open"


def task_summary(path):
    files = {name: (path / name).read_bytes() for name in ["run.json", "events.jsonl"]}
    run = json.loads(files["run.json"])
    events = [json.loads(line) for line in files["events.jsonl"].splitlines() if line]
    calls, first_input = {}, None
    for event in events:
        message = event.get("message", {})
        if first_input is None and event.get("type") == "assistant":
            usage = message.get("usage", {})
            first_input = sum(usage.get(key, 0) for key in
                              ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])
        for item in message.get("content", []):
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use":
                calls[item["id"]] = {"tool": item["name"].split("__")[-1],
                                     "operation": operation(item["input"]),
                                     "start": timestamp(event["timestamp"])}
            elif item.get("type") == "tool_result":
                call = calls.get(item["tool_use_id"])
                if call is None:
                    raise ValueError(f"Unmatched tool result in {path.name}")
                text = content_text(item.get("content", ""))
                call.update(end=timestamp(event["timestamp"]), chars=len(text),
                            bytes=len(text.encode()), error=bool(item.get("is_error")),
                            not_run=text.count(": not run:"),
                            retained_open="tab retained; opening did not finish" in text)
    rows = sorted(calls.values(), key=lambda row: row["start"])
    intervals = [(row["start"], row["end"]) for row in rows if "end" in row]
    tool_ms = union_ms(intervals)
    result = run.get("run", {}).get("result") or {}
    usage = result.get("usage", {})
    metrics = path / "turbo-metrics.jsonl"
    phases = []
    if metrics.exists():
        files[metrics.name] = metrics.read_bytes()
        phases = [json.loads(line) for line in files[metrics.name].splitlines() if line]
    open_phases = [row for row in phases if row.get("phase", "").startswith("browser-open-")]
    return {"round": path.parent.name, "task": path.name, "wall_ms": run["wallMs"],
            "agent_ms": round(run["agentSeconds"] * 1000), "tool_union_ms": tool_ms,
            "outside_tool_ms": run["wallMs"] - tool_ms,
            "api_ms": result.get("duration_api_ms"), "first_input_tokens": first_input,
            "usage": usage, "calls": rows, "open_phases": open_phases,
            "outcome": run.get("outcome"),
            "sha256": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}


def markdown(rows):
    print("| Round | Task | Wall s | Calls | Tool interval union s | Outside tools s | First input tokens | Result chars | Output tokens |")
    print("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in rows:
        print(f"| {row['round']} | `{row['task']}` | {row['wall_ms']/1000:.3f} | {len(row['calls'])} | "
              f"{row['tool_union_ms']/1000:.3f} | {row['outside_tool_ms']/1000:.3f} | {row['first_input_tokens']} | "
              f"{sum(c.get('chars', 0) for c in row['calls'])} | {row['usage'].get('output_tokens', '')} |")
    for row in rows:
        print(f"\n### {row['round']}, `{row['task']}`\n")
        print("| Call | Tool | Operations | Start after first call s | Duration s | Result chars | Not run lines |")
        print("| ---: | --- | --- | ---: | ---: | ---: | ---: |")
        # Start is relative to the first call; this does not infer SDK startup phases.
        for n, call in enumerate(row["calls"], 1):
            duration = (call["end"] - call["start"]) / 1000 if "end" in call else None
            start = (call["start"] - row["calls"][0]["start"]) / 1000
            print(f"| {n} | {call['tool']} | {call['operation']} | {start:.3f} | "
                  f"{duration if duration is not None else 'pending'} | {call.get('chars', '')} | {call.get('not_run', '')} |")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bank", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    rows = [task_summary(path.parent) for path in sorted(args.bank.glob("chrome-*-r*/*/run.json"))]
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        markdown(rows)


if __name__ == "__main__":
    main()

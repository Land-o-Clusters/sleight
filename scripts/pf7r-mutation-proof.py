"""Run PF7R guard mutations offline, restoring each source before the next run."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
ACT = "plugins/sleight/lib/direct-browser/act.mjs"
TOOLS = "plugins/sleight/lib/direct-browser/tools.mjs"
ACT_TEST = "tests/direct-browser-v3-act.test.mjs"
POPUP_TEST = "tests/direct-browser-popup-observe.test.mjs"
GATE = Path.home() / "Projects/sleight-wt/ledger/vc/night/lanes-may-test"
MUTATIONS = [
    ("page-no-change-text", ACT, "!fullOnce && /no (?:visible )?changes?/i", "/no (?:visible )?changes?/i", ACT_TEST),
    ("parent-action-pending", TOOLS, "!entry.state.actionPending && !entry.state.dialog && !entry.state.stuck", "!entry.state.dialog && !entry.state.stuck", POPUP_TEST),
    ("parent-dialog", TOOLS, "!entry.state.actionPending && !entry.state.dialog && !entry.state.stuck", "!entry.state.actionPending && !entry.state.stuck", POPUP_TEST),
    ("parent-stuck", TOOLS, "!entry.state.actionPending && !entry.state.dialog && !entry.state.stuck", "!entry.state.actionPending && !entry.state.dialog", POPUP_TEST),
    ("screenshot-exclusion", TOOLS, "a.observe !== 'screenshot' && !motion &&", "!motion &&", POPUP_TEST),
    ("motion-exclusion", TOOLS, "a.observe !== 'screenshot' && !motion &&", "a.observe !== 'screenshot' &&", POPUP_TEST),
    ("popup-notice-membership", TOOLS, "!parent.popups.includes(notice) || notice.closed", "notice.closed", POPUP_TEST),
    ("turn-ended-before-combine", TOOLS, "if (!ended && !childResult.isError)", "if (!childResult.isError)", POPUP_TEST),
    ("early-full-marker", ACT, "let fullObservation = false;", "let fullObservation = fullOnce;", ACT_TEST),
]


def counts(tap):
    return {name: int(value) for name, value in re.findall(
        r"^# (tests|pass|fail|cancelled|skipped) (\d+)$", tap, re.M
    )}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    originals = {name: (ROOT / name).read_bytes() for name in (ACT, TOOLS)}
    evidence = {"source_sha256": {name: hashlib.sha256(data).hexdigest() for name, data in originals.items()}, "runs": []}
    failures = 0
    for name, source, before, after, test in MUTATIONS:
        while not GATE.exists():
            time.sleep(30)
        path = ROOT / source
        original = originals[source]
        text = original.decode()
        if text.count(before) != 1:
            raise RuntimeError(f"{name}: expected exactly one mutation target")
        if path.read_bytes() != original:
            raise RuntimeError(f"{name}: source changed outside this proof")
        log = args.output.parent / f"pf7r-mutant-{name}.tap"
        command = ["nice", "-n", "20", "node", "--test", "--test-reporter=tap", "--test-concurrency=1", "--test-name-pattern=^PF7 ", test]
        try:
            path.write_text(text.replace(before, after))
            with tempfile.TemporaryDirectory(prefix="lane-claude-", dir="/tmp") as config, log.open("w") as output:
                env = {**os.environ, "CLAUDE_CONFIG_DIR": config}
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
        finally:
            path.write_bytes(original)
        tap = log.read_text()
        numbers = counts(tap)
        # An assertion must kill the mutant. A parse error or crash is not proof.
        killed = result.returncode == 1 and numbers.get("fail", 0) > 0 and "ERR_ASSERTION" in tap
        failures += not killed
        failed_tests = re.findall(r"^not ok \d+ - (.+)$", tap, re.M)
        evidence["runs"].append({"name": name, "source": source, "before": before, "after": after,
                                 "command": command, "exit": result.returncode, "counts": numbers,
                                 "failed_tests": failed_tests, "killed": killed, "log": str(log)})
        print(f"{name}: exit {result.returncode}, {numbers}, killed={killed}", flush=True)
    evidence["restored"] = all((ROOT / name).read_bytes() == data for name, data in originals.items())
    evidence["mutants"] = len(MUTATIONS)
    evidence["killed"] = sum(run["killed"] for run in evidence["runs"])
    args.output.write_text(json.dumps(evidence, indent=2) + "\n")
    return int(bool(failures) or not evidence["restored"])


if __name__ == "__main__":
    raise SystemExit(main())

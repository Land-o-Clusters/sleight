// Pure telemetry checks, no hook installation, Windows API, UIA or drawing.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace Sleight.Driver
{
internal static class DriverCheckpointChecks
{
    static int passed;
    static void Check(bool condition) { if (!condition) throw new Exception("checkpoint check " + passed); passed++; }
    public static int Main()
    {
        try {
            var buffer = new DriverCheckpointBuffer(2);
            var first = Json.Map();
            var empty = Json.Object(buffer.Snapshot(0, first));
            Check((int)empty["sampled"] == 0 && ((object[])empty["samples"]).Length == 0 && first.Count == 0);
            buffer.Record(DriverCheckpointTimings.Kind.BudgetCheck, 10);
            buffer.Record(DriverCheckpointTimings.Kind.BudgetCheck, 20);
            buffer.Record(DriverCheckpointTimings.Kind.BudgetCheck, 30);
            var value = Json.Object(buffer.Snapshot(0, first));
            Check(buffer.Count == 2 && (int)value["omitted"] == 1);
            Check((int)value["capacity"] == 2 && (int)value["start"] == 0);
            Check((double)Json.Object(first["budget-check"])["elapsedMs"] == 10 * (1000.0 / Stopwatch.Frequency));
            var samples = (object[])value["samples"];
            Check(samples.Length == 2);
            Check((double)Json.Object(samples[1])["elapsedMs"] == 20 * (1000.0 / Stopwatch.Frequency));
            Check(!Json.Codec.Serialize(value).Contains("beforeMs"));
            first.Clear(); value = Json.Object(buffer.Snapshot(1, first));
            Check(((object[])value["samples"]).Length == 1 && (int)value["start"] == 1);
            Check((double)Json.Object(first["budget-check"])["elapsedMs"] == 20 * (1000.0 / Stopwatch.Frequency));
            DriverCheckpointTimings.Current = null;
            DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.BudgetCheck).Finish();
            Check(DriverCheckpointTimings.Current == null);
            var owner = new DriverTurn { Timings = new DriverCheckpointTimings() };
            Check(owner.Timings.Checks.Capacity == 65536 && owner.Timings.Lifecycle.Capacity == 256);
            var cursor = new DriverCheckpointTimings.Cursor(owner);
            DriverCheckpointTimings.Current = owner.Timings;
            foreach (DriverCheckpointTimings.Kind kind in Enum.GetValues(typeof(DriverCheckpointTimings.Kind))) {
                if (kind == DriverCheckpointTimings.Kind.HookInstall || kind == DriverCheckpointTimings.Kind.HookRemove)
                    owner.Timings.Lifecycle.Record(kind, 1);
                else DriverCheckpointTimings.Start(kind).Finish();
            }
            owner.OwnSamples.Record(5);
            var result = Json.Map("outcome", "unchanged"); cursor.Attach(result);
            Check((string)result["outcome"] == "unchanged");
            var timings = Json.Object(result["checkpointTimings"]);
            Check(timings.Count == 8);
            foreach (DriverCheckpointTimings.Kind kind in Enum.GetValues(typeof(DriverCheckpointTimings.Kind)))
                Check((double)Json.Object(timings[DriverCheckpointTimings.Name(kind)])["elapsedMs"] >= 0);
            Check((double)Json.Object(timings["hook-callback"])["elapsedUs"] == 5 * (1000000.0 / Stopwatch.Frequency));
            var rows = Json.Object(result["checkpointTimingSamples"]);
            Check(((object[])Json.Object(rows["checks"])["samples"]).Length == 5);
            Check(((object[])Json.Object(rows["hookLifecycle"])["samples"]).Length == 2);
            var next = new DriverCheckpointTimings.Cursor(owner);
            result = Json.Map(); next.Attach(result);
            Check(Json.Object(result["checkpointTimings"]).Count == 0);
            Check(((object[])Json.Object(Json.Object(result["checkpointTimingSamples"])["checks"])["samples"]).Length == 0);
            var disabled = Json.Map("outcome", "unchanged");
            new DriverCheckpointTimings.Cursor(new DriverTurn()).Attach(disabled);
            Check(disabled.Count == 1);
            // Finish on an unset span and Attach on a non-map never alter outcome.
            new DriverCheckpointTimings.Span().Finish(); cursor.Attach(new object()); Check(true);
            buffer.Reset(); first.Clear(); value = Json.Object(buffer.Snapshot(0, first));
            Check(buffer.Count == 0 && (int)value["omitted"] == 0);
            var standalone = new DriverCheckpointTimings();
            var readCursor = new DriverCheckpointTimings.Cursor(null, standalone);
            standalone.Checks.Record(DriverCheckpointTimings.Kind.SessionProbe, 1);
            var read = Json.Map("outcome", "read"); readCursor.Attach(read);
            Check(Json.Object(read["checkpointTimings"]).ContainsKey("session-probe"));
            var large = Json.Map("text", new string('x', Json.OutputLimit / 2));
            readCursor.Attach(large);
            Check(!large.ContainsKey("checkpointTimings") && !large.ContainsKey("checkpointTimingSamples"));
            Check(((string)large["text"]).Length == Json.OutputLimit / 2);
            string nonce = new string('a', 64);
            var frame = Json.Map("protocol", Driver.Protocol, "nonce", nonce, "id", 1,
                "method", "getState", "params", Json.Map(), "deadline", Driver.Now() + 5000);
            Check(!Request.Parse(Json.Codec.Serialize(frame), nonce, 0).CheckpointTimings);
            frame["checkpointTimings"] = true;
            Check(Request.Parse(Json.Codec.Serialize(frame), nonce, 0).CheckpointTimings);
            foreach (object bad in new object[] { false, 1, "true", null }) {
                frame["checkpointTimings"] = bad;
                try { Request.Parse(Json.Codec.Serialize(frame), nonce, 0); throw new Exception(); }
                catch (DriverFault e) { Check(e.Code == "INVALID_PARAMS"); }
            }
            frame["checkpointTimings"] = true;
            foreach (string method in new[] { "ping", "cancel" }) {
                frame["method"] = method;
                try { Request.Parse(Json.Codec.Serialize(frame), nonce, 0); throw new Exception(); }
                catch (DriverFault e) { Check(e.Code == "INVALID_PARAMS"); }
            }
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false)));
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        finally { DriverCheckpointTimings.Current = null; }
    }
}
}

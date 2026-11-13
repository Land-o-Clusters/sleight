// Synthetic providers only. This entry point never creates UIA or a window.
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Linq;
using System.Text;
namespace Sleight.Driver
{
internal static class DriverChecks
{
    static int passed;
    static void Check(bool value) { if (!value) throw new Exception("Check " + (passed + 1)); passed++; }
    sealed class Tree { internal int Depth, Index; }
    static int TelemetryChecks()
    {
        int rows = 0;
        Action<bool> check = value => { if (!value) throw new Exception("Telemetry row " + (rows + 1)); rows++; };
        var counters = new DriverOperationCounters();
        DriverOperationCounters.Current = counters;
        try {
            var initial = Json.Object(counters.JsonValue());
            check(initial.Count == 5 && initial.Values.All(v => (long)v == 0));
            foreach (DriverOperationCounters.Kind kind in Enum.GetValues(typeof(DriverOperationCounters.Kind))) DriverOperationCounters.Mark(kind);
            check(Json.Object(counters.JsonValue()).Values.All(v => (long)v == 1));
            try { DriverUia.Effect(() => { throw new DriverFault("PERSON_TOOK_OVER"); }, () => check(false)); }
            catch (DriverFault e) { check(e.Code == "PERSON_TOOK_OVER"); }
            check((long)Json.Object(counters.JsonValue())["patternCalls"] == 1);
            int effects = 0;
            DriverUia.Effect(() => {}, () => effects++);
            DriverUia.ExpandCollapse(() => 1, () => {}, () => effects++, () => effects++);
            check(effects == 2 && (long)Json.Object(counters.JsonValue())["patternCalls"] == 3);
            var api = new DriverInput.PostApi {
                Identity = (w,h) => {}, Person = w => {}, Send = (h,m,k,d) => true,
                Error = () => 0, Pause = () => {}, Idle = () => {}
            };
            DriverInput.Post(new WindowRecord(), new IntPtr(1), 0x0102, 65, IntPtr.Zero, false, false, false, false, api);
            check((long)Json.Object(counters.JsonValue())["postedMessages"] == 1);
            api.Person = w => { throw new DriverFault("PERSON_TOOK_OVER"); };
            try { DriverInput.Post(new WindowRecord(), new IntPtr(1), 0x0102, 65, IntPtr.Zero, false, false, false, false, api); check(false); }
            catch (DriverFault e) { check(e.Code == "PERSON_TOOK_OVER"); }
            check((long)Json.Object(counters.JsonValue())["postedMessages"] == 1);
            var turn = new DriverTurn();
            var reply = Json.Map("ok", true);
            DriverOperationCounters.Attach(reply, counters, turn);
            check((int)reply["escapeStops"] == 0 && Json.Object(reply["counters"]).Count == 5);
            turn.Escape = 1;
            DriverOperationCounters.Attach(reply, counters, turn);
            check((int)reply["escapeStops"] == 1);
            check(new DriverTurn().Escaped == false && DriverOperationCounters.EscapeStops(null) == 0);
            reply = Json.Map(); DriverOperationCounters.Attach(reply, null, null);
            check(!reply.ContainsKey("counters") && !reply.ContainsKey("escapeStops"));
            reply = Json.Map("ok", true); DriverOperationCounters.Attach(reply, null, turn);
            check(reply.Count == 1 && (bool)reply["ok"]);
            foreach (object result in new object[] { null, true, 1, "done", new object[0] }) {
                DriverOperationCounters.Attach(result, counters, turn);
                check(true);
            }
            check(Json.Object(new DriverOperationCounters().JsonValue()).Values.All(v => (long)v == 0));
        } finally { DriverOperationCounters.Current = null; }
        DriverOperationCounters.Mark(DriverOperationCounters.Kind.PostedMessage);
        check((long)Json.Object(counters.JsonValue())["postedMessages"] == 1);
        string savedFlag = Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS");
        try {
            foreach (string flag in new string[] { null, "0", "1" }) {
                Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS", flag);
                using (var hook = new DriverHook()) {
                    hook.BeginTurn(1);
                    var ended = Json.Object(hook.EndTurn(1));
                    check(ended.ContainsKey("escapeStops") == (flag == "1"));
                }
            }
        } finally { Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS", savedFlag); }
        return rows;
    }
    static int TurnChecks()
    {
        int rows = 0;
        Action<bool> check = value => { if (!value) throw new Exception("Turn row " + (rows + 1)); rows++; };
        // No Activate reaches installation: null, escaped and stale owners only.
        var hook = new DriverHook();
        using (hook) {
            try { hook.Activate(null); check(false); } catch (DriverFault e) { check(e.Code == "TURN_INACTIVE"); }
            hook.BeginTurn(1); var old = hook.CurrentTurn;
            hook.BeginTurn(1); check(Object.ReferenceEquals(old, hook.CurrentTurn));
            old.Escape = 1; hook.BeginTurn(1); check(old.Escaped);
            try { hook.Activate(old); check(false); } catch (DriverFault e) { check(e.Code == "USER_STOPPED"); }
            try { hook.BeginTurn(2); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
            var ended = Json.Object(hook.EndTurn(1));
            check(old.Active == 0 && hook.CurrentTurn == null && !(bool)ended["active"]);
            try { hook.BeginTurn(1); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
            try { hook.BeginTurn(0); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
            hook.BeginTurn(2); check(!Object.ReferenceEquals(old, hook.CurrentTurn) && !hook.CurrentTurn.Escaped);
            try { hook.Activate(old); check(false); } catch (DriverFault e) { check(e.Code == "TURN_INACTIVE"); }
            hook.EndTurn(2); check(hook.CurrentTurn == null);
            try { hook.EndTurn(2); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
        }
        try { hook.BeginTurn(3); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
        return rows;
    }
    static int SampleChecks()
    {
        int rows = 0;
        Action<bool> check = value => { if (!value) throw new Exception("Sample row " + (rows + 1)); rows++; };
        var samples = new DriverHookSamples();
        var empty = Json.Object(samples.JsonValue());
        check((int)empty["callbacks"] == 0 && empty["p50Us"] == null && empty["p99Us"] == null && empty["maxUs"] == null);
        for (int i = 1; i <= 50; i++) samples.Record(i);
        samples.Drain();
        for (int i = 51; i <= 100; i++) samples.Record(i);
        var result = Json.Object(samples.JsonValue());
        double us = 1000000.0 / System.Diagnostics.Stopwatch.Frequency;
        check((int)result["callbacks"] == 100 && (int)result["sampled"] == 100 && (int)result["omitted"] == 0);
        var values = (double[])result["samplesUs"];
        check(values.Length == 100 && values[0] == us && values[99] == 100 * us);
        check((double)result["p50Us"] == 50 * us && (double)result["p99Us"] == 99 * us);
        check((double)result["maxUs"] == 100 * us);
        for (int i = 101; i <= DriverHookSamples.Capacity + 3; i++) samples.Record(i);
        result = Json.Object(samples.JsonValue());
        check((int)result["sampled"] == 8192 && (int)result["omitted"] == 3);
        check((double)result["maxUs"] == 8195 * us && (double)result["p99Us"] == 8111 * us);
        values = (double[])result["samplesUs"];
        check(values.Length == 8192 && values[0] == us && values[8191] == 8192 * us);
        return rows;
    }
    static int StopChecks()
    {
        int rows = 0;
        Action<bool> check = value => { if (!value) throw new Exception("Stop row " + (rows + 1)); rows++; };
        // Consent.cs keyboard flag rows, plus Escape's code/message/key boundary.
        check(DriverHook.HardwareEscape(0, 0x100, 27, 0));
        check(!DriverHook.HardwareEscape(0, 0x100, 27, 16));
        check(!DriverHook.HardwareEscape(0, 0x100, 27, 2));
        check(!DriverHook.HardwareEscape(0, 0x100, 27, 18));
        check(!DriverHook.HardwareEscape(-1, 0x100, 27, 0));
        check(!DriverHook.HardwareEscape(0, 0x101, 27, 0));
        check(!DriverHook.HardwareEscape(0, 0x104, 27, 0));
        check(!DriverHook.HardwareEscape(0, 0x100, 13, 0));
        string nonce = new string('a', 64);
        var pending = new ConcurrentDictionary<long, Driver.Job>();
        var job = new Driver.Job(); pending.TryAdd(1, job);
        var frame = Json.Map("protocol", Driver.Protocol, "nonce", nonce, "id", 2, "method", "cancel",
            "params", Json.Map("id", 1), "deadline", Driver.Now() + 1000);
        var request = Request.Parse(Json.Codec.Serialize(frame), nonce, 1);
        var result = Json.Object(Driver.CancelRequest(request, pending));
        check((long)result["cancelled"] == 1 && (bool)result["inFlight"]);
        check(job.Cancel == (int)DriverInput.StopReason.Cancel);
        job.Stop(DriverInput.StopReason.Deadline);
        check(job.Cancel == (int)DriverInput.StopReason.Cancel);
        job.Finished = 1; job.Done.Set();
        check(!(bool)Json.Object(Driver.CancelRequest(request, pending))["inFlight"]);
        request.Params["id"] = 99;
        check(!(bool)Json.Object(Driver.CancelRequest(request, pending))["inFlight"]);
        request.Params["id"] = 1.5;
        try { Driver.CancelRequest(request, pending); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
        request.Params["id"] = 1; request.Params["extra"] = true;
        try { Driver.CancelRequest(request, pending); check(false); } catch (DriverFault e) { check(e.Code == "INVALID_PARAMS"); }
        foreach (var reason in new[] { DriverInput.StopReason.Cancel, DriverInput.StopReason.Escape }) {
            DriverInput.Cancelled = () => reason;
            foreach (bool sent in new[] { false, true }) {
                DriverInput.InputAttempted = sent; DriverInput.Typed = sent ? 17 : 0;
                try { DriverInput.EnsureBudget(); check(false); }
                catch (DriverFault e) {
                    check(e.Code == "USER_STOPPED" && (string)e.Disposition["reason"] == (reason == DriverInput.StopReason.Escape ? "escape" : "cancel"));
                    check((string)e.Disposition["delivery"] == (sent ? "sent-unverified" : "not-sent") && (int)e.Disposition["typed"] == DriverInput.Typed);
                    check(DriverSession.IsSafety(e));
                }
            }
        }
        DriverInput.Cancelled = null; DriverInput.InputAttempted = false; DriverInput.Typed = 0;
        DriverInput.EnsureNotCancelled(); check(true);
        job.Done.Dispose();
        return rows;
    }
    // Separate counter preserves the existing provider/traversal receipt's 777
    // checks. These pure tables do not activate UIA, call P/Invoke or draw.
    static int Safety()
    {
        int rows = 0;
        Action<bool> check = value => { if (!value) throw new Exception("Safety row " + (rows + 1)); rows++; };
        check(DriverPerson.Decide(0, 41, 42, 41) == "person-active");
        check(DriverPerson.Decide(499, 41, 42, 41) == "person-active");
        check(DriverPerson.Decide(500, 41, 41, 41) == null);
        check(DriverPerson.Decide(501, 41, 41, 41) == null);
        check(DriverPerson.Decide(600, 41, 41, 41) == null);
        check(DriverPerson.Decide(100, 42, 41, 41) == "person-active");
        check(DriverPerson.Decide(100, 42, 43, 41) == null);
        check(DriverPerson.Decide(0x80000000u, 41, 41, 41) == "person-unknown");
        check(DriverPerson.Decide(0xffffffffu, 41, 41, 41) == "person-unknown");
        check(DriverPerson.Decide(100, 0, 42, 41) == "person-unknown");
        check(DriverPerson.Decide(100, 42, 0, 41) == "person-unknown");
        check(DriverPerson.Decide(100, 42, 43, 0) == "person-unknown");
        check(DriverPerson.Decide(unchecked(0x10u - 0xfffffff0u), 41, 43, 41) == "person-active");
        check(DriverSession.Decide(false, 0, 1, true, "Default") == "session-unknown");
        check(DriverSession.Decide(true, 0, -1, true, "Default") == "session-unknown");
        check(DriverSession.Decide(true, 0, 2, true, "Default") == "session-unknown");
        check(DriverSession.Decide(true, 4, 1, true, "Default") == "session-disconnected");
        check(DriverSession.Decide(true, 1, 1, true, "Default") == "session-disconnected");
        check(DriverSession.Decide(true, 0, 0, true, "Winlogon") == "session-locked");
        check(DriverSession.Decide(true, 0, 0, true, "Default") == "session-locked");
        check(DriverSession.Decide(true, 0, 1, true, "Default") == null);
        check(DriverSession.Decide(true, 0, 1, true, "Screen-saver") == "screensaver");
        check(DriverSession.Decide(true, 0, 1, true, "Winlogon") == "secure-desktop");
        check(DriverSession.Decide(true, 0, 1, false, null) == "secure-desktop");
        check(DriverSession.Decide(true, 0, 1, true, "Other") == "input-desktop-unavailable");
        check(DriverSession.Decide(true, 0, 1, true, null) == "input-desktop-unavailable");
        check(DriverSession.Decide(true, 0, 1, true, "default") == "input-desktop-unavailable");
        foreach (string pair in new[] { "\ud83e\ude84", "\r\n" }) {
            int last = 0;
            DriverInput.PumpText("a" + String.Concat(Enumerable.Repeat(pair, 100)), true, (message, code, cleanup) => { },
                () => { check(DriverInput.Typed - last <= 64); last = DriverInput.Typed; }, () => { });
            check(DriverInput.Typed - last <= 64 && DriverInput.Typed == 201);
        }
        foreach (int state in new[] { 0, 1 }) {
            bool observed = false; int mutations = 0;
            try {
                DriverUia.ExpandCollapse(() => { observed = true; return state; },
                    () => { check(observed); throw new DriverFault("SCREEN_LOCKED"); }, () => mutations++, () => mutations++);
                throw new Exception("Missing Expand/Collapse refusal");
            } catch (DriverFault fault) { check(fault.Code == "SCREEN_LOCKED" && mutations == 0); }
        }
        return rows;
    }
    static void Providers()
    {
        var sensitive = new HashSet<int> { 50003, 50004, 50025, 50030, 50033, -1, 50041 };
        var types = Enumerable.Range(50000, 41).Concat(new[] { -1, 50041 });
        foreach (int type in types) foreach (object flag in new object[] { new object(), null, false, true }) {
            int strings = 0;
            bool? passwordIgnore = null, enabledIgnore = null;
            var node = DriverUia.Node((property, ignore) => {
                if (property == DriverUia.ControlType) return type;
                if (property == DriverUia.IsPassword) { passwordIgnore = ignore; return flag; }
                if (property == DriverUia.IsEnabled) { enabledIgnore = ignore; return flag; }
                if (property == DriverUia.Name || property == DriverUia.HelpText || property == DriverUia.ValueValue) {
                    strings++; return "provider secret";
                }
                return null;
            }, 0);
            bool mask = flag is bool ? (bool)flag : sensitive.Contains(type);
            Check(node.Password == mask && passwordIgnore == sensitive.Contains(type));
            Check(node.Enabled == (!(flag is bool) || (bool)flag) && enabledIgnore == true);
            Check(strings == (mask ? 0 : 3));
            var map = new Dictionary<int, DriverNode>(); bool truncated;
            string text = DriverUia.Serialize("Fixture", "Fixture", new[] { node }, map, out truncated);
            Check(text.Contains("provider secret") == !mask && text.Contains("<redacted>") == mask);
        }
    }
    static void IdentityAndInventory()
    {
        var before = new WindowRecord { Handle = new IntPtr(101), Pid = 2, ProcessStart = "3", Image = "app.exe", Title = "old" };
        var after = new WindowRecord { Handle = new IntPtr(101), Pid = 2, ProcessStart = "3", Image = "app.exe", Title = "new" };
        Check(before.SameIdentity(after)); Check(!before.SameIdentity(null));
        after.Handle = new IntPtr(102); Check(!before.SameIdentity(after)); after.Handle = before.Handle;
        after.Pid++; Check(!before.SameIdentity(after)); after.Pid = before.Pid;
        after.ProcessStart = "4"; Check(!before.SameIdentity(after)); after.ProcessStart = before.ProcessStart;
        after.Image = "other.exe"; Check(!before.SameIdentity(after));
        foreach (string refusal in new[] { "TARGET_UNAVAILABLE", "ELEVATED_TARGET", "OTHER_SESSION", "MINIMIZED_PACKAGED_WINDOW" }) {
            var row = new WindowRecord { Handle = new IntPtr(101), Pid = 2, ProcessStart = "3", Refused = refusal,
                Title = "private title", Image = "private path", Aumid = "private aumid", App = "private app", ClassName = "private class" };
            string json = Json.Codec.Serialize(DriverInventory.State(new[] { row }));
            Check(!json.Contains("private title") && !json.Contains("private aumid") && !json.Contains("private class") &&
                (refusal == "ELEVATED_TARGET" ? json.Contains("private app") && json.Contains("private path") : !json.Contains("private")) && json.Contains(refusal));
            Check((string)row.JsonValue()["windowId"] == "101" && (uint)row.JsonValue()["pid"] == 2);
            foreach (string selector in new[] { row.Title, row.Image, row.Aumid, row.App, "absent" }) {
                try { DriverInventory.Resolve(selector, new[] { row }); Check(false); }
                catch (DriverFault fault) { Check(fault.Code == (refusal == "ELEVATED_TARGET" && (selector == row.App || selector == row.Image || selector == row.Aumid) ? "ELEVATED_TARGET" : "WINDOW_NOT_FOUND")); }
            }
        }
    }
    static void Limits()
    {
        foreach (char fill in new[] { 'x', '\u4e00', '\u0001', '"' }) {
            var nodes = Enumerable.Range(0, 100).Select(i => new DriverNode { Depth = 1, Role = "text",
                Name = new string(fill, 16384), Id = new string(fill, 16384), Help = new string(fill, 16384), Value = new string(fill, 16384) }).ToList();
            var map = new Dictionary<int, DriverNode>(); bool truncated;
            string text = DriverUia.Serialize("Fixture", "Fixture", nodes, map, out truncated);
            Check(truncated && Encoding.UTF8.GetByteCount(text) <= 1048576);
            Check(map.Count > 0 && map.Count < 100 && text.Split('\n').Length == map.Count + 1);
            Check(map.Keys.SequenceEqual(Enumerable.Range(0, map.Count)));
        }
        var response = Json.Map("protocol", Driver.Protocol, "nonce", new string('a', 64), "id", 17, "ok", true,
            "result", new string('x', 8388608));
        var refused = Json.Object(Json.Codec.DeserializeObject(Driver.ResponseLine(response)));
        Check((int)refused["id"] == 17 && (string)refused["nonce"] == new string('a', 64) && !(bool)refused["ok"]);
        var error = Json.Object(refused["error"]);
        Check((string)error["code"] == "OUTPUT_LIMIT" && !(bool)error["unhealthy"] && !refused.ContainsKey("result"));
        response["result"] = response; // Serializer failure must also return a complete refusal.
        Check(Driver.ResponseLine(response).Contains("OUTPUT_LIMIT"));
        response["id"] = 18; response["result"] = "next";
        Check(Driver.ResponseLine(response).Contains("\"ok\":true"));
    }
    static void Traversal()
    {
        int seen = 0, calls = 0, childCalls = 0;
        // A lazy 50,000-sibling provider cannot allocate or fetch its entire child array.
        bool partial = DriverUia.Walk(new Tree(), n => { childCalls++; return n.Depth == 0 ? new Tree { Depth = 1 } : null; },
            n => n.Index < 49999 ? new Tree { Depth = 1, Index = n.Index + 1 } : null,
            (n, depth) => { seen++; return true; }, () => seen < 3000 && calls++ < 6000);
        Check(partial && seen == 3000 && calls <= 6000 && childCalls < 3000);
        seen = calls = 0;
        partial = DriverUia.Walk(new Tree(), n => new Tree { Depth = n.Depth + 1 }, n => null,
            (n, depth) => { Check(depth == n.Depth); seen++; return true; }, () => calls++ < 6000);
        Check(partial && seen == 33 && calls < 100);
        seen = calls = 0;
        partial = DriverUia.Walk(new Tree(), n => { throw new Exception("pruned child"); }, n => null,
            (n, depth) => { seen++; return false; }, () => { calls++; return true; });
        Check(!partial && seen == 1 && calls == 0);
        seen = 0;
        partial = DriverUia.Walk(new Tree(), n => { throw new Exception("expired fetch"); }, n => null,
            (n, depth) => { seen++; return true; }, () => false);
        Check(partial && seen == 1);
        seen = calls = 0;
        // Each new explicit read gets one bounded pass with no restart or replay.
        for (int run = 0; run < 2; run++) {
            int count = 0;
            partial = DriverUia.Walk(new Tree(), n => n.Depth == 0 ? new Tree { Depth = 1 } : null,
                n => n.Index < 2 ? new Tree { Depth = 1, Index = n.Index + 1 } : null,
                (n, depth) => { count++; return true; }, () => true);
            Check(!partial && count == 4);
        }
    }
    public static int Main()
    {
        try {
            Providers(); IdentityAndInventory(); Limits(); Traversal();
            int safetyRows = Safety();
            int stopRows = StopChecks();
            int turnRows = TurnChecks(), sampleRows = SampleChecks(), telemetryRows = TelemetryChecks();
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "providerRows", 172, "safetyRows", safetyRows, "stopRows", stopRows,
                "turnRows", turnRows, "sampleRows", sampleRows, "telemetryRows", telemetryRows, "drawing", false)));
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
}

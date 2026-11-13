// C# 5, .NET Framework 4.8. No window creation in this binary.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Sleight.Driver
{
internal sealed class DriverFault : Exception
{
    internal readonly string Code;
    internal readonly string Step;
    internal Dictionary<string, object> Disposition;
    internal DriverFault(string code) : this(code, code, null) { }
    internal DriverFault(string code, string message) : this(code, message, null) { }
    internal DriverFault(string code, string message, string step) : base(Detail(code, message, step))
    { Code = code; Step = FailureStep(code, step); }
    internal static string FailureStep(string code, string step)
    {
        if (code != "TARGET_UNAVAILABLE" && code != "HOSTED_APP_UNRESOLVED") return null;
        var steps = new[] { "identity", "process", "birth", "image", "version", "session", "integrity", "catalog",
            "desktop", "desktop-owner", "frame", "frame-scan", "frame-class", "frame-pid", "frame-child", "frame-limit", "frame-package" };
        return Array.IndexOf(steps, step) >= 0 ? step : code == "HOSTED_APP_UNRESOLVED" ? "frame" : "identity";
    }
    static string Detail(string code, string message, string step)
    {
        string value = FailureStep(code, step);
        return value == null ? message : message + ": step=" + value;
    }
}
internal static class Json
{
    internal const int Limit = 64 * 1024 * 1024;
    internal const int OutputLimit = 8 * 1024 * 1024;
    [ThreadStatic] static JavaScriptSerializer codec;
    internal static JavaScriptSerializer Codec {
        get { return codec ?? (codec = new JavaScriptSerializer { MaxJsonLength = Limit, RecursionLimit = 100 }); }
    }
    internal static Dictionary<string, object> Map(params object[] pairs)
    {
        var value = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) value.Add((string)pairs[i], pairs[i + 1]);
        return value;
    }
    internal static Dictionary<string, object> Object(object value)
    {
        var result = value as Dictionary<string, object>;
        if (result == null) throw new DriverFault("INVALID_PARAMS");
        return result;
    }
    internal static void Keys(Dictionary<string, object> value, string required, string optional = "")
    {
        var need = required.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        var allowed = new HashSet<string>(need.Concat(optional.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)));
        if (need.Any(k => !value.ContainsKey(k)) || value.Keys.Any(k => !allowed.Contains(k))) throw new DriverFault("INVALID_PARAMS");
    }
    internal static string Text(object value)
    {
        var result = value as string;
        if (result == null) throw new DriverFault("INVALID_PARAMS");
        return result;
    }
    internal static long Integer(object value, long min, long max)
    {
        if (!(value is int || value is long || value is decimal || value is double)) throw new DriverFault("INVALID_PARAMS");
        try {
            decimal number = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
            if (number < min || number > max || number != Decimal.Truncate(number)) throw new DriverFault("INVALID_PARAMS");
            return (long)number;
        } catch { throw new DriverFault("INVALID_PARAMS"); }
    }
    internal static void UniqueKeys(string line)
    {
        // JavaScriptSerializer accepts duplicate keys. Refuse them before deserialization,
        // including escaped spellings of the same key and nested parameter objects.
        var stack = new Stack<HashSet<string>>();
        for (int i = 0; i < line.Length; i++) {
            char c = line[i];
            if (c == '{' || c == '[') {
                if (stack.Count >= 100) throw new DriverFault("INVALID_PARAMS");
                stack.Push(c == '{' ? new HashSet<string>() : null);
            } else if (c == '}' || c == ']') {
                if (stack.Count == 0) throw new DriverFault("INVALID_PARAMS");
                stack.Pop();
            } else if (c == '"') {
                int begin = i++;
                while (i < line.Length && line[i] != '"') { if (line[i] == '\\') i++; i++; }
                if (i >= line.Length) throw new DriverFault("INVALID_PARAMS");
                int next = i + 1;
                while (next < line.Length && Char.IsWhiteSpace(line[next])) next++;
                if (next < line.Length && line[next] == ':') {
                    if (stack.Count == 0 || stack.Peek() == null) throw new DriverFault("INVALID_PARAMS");
                    string key = Text(Codec.DeserializeObject(line.Substring(begin, i - begin + 1)));
                    if (!stack.Peek().Add(key)) throw new DriverFault("INVALID_PARAMS");
                }
            }
        }
    }
    internal static string Read(Stream input)
    {
        using (var bytes = new MemoryStream()) {
            int b;
            while ((b = input.ReadByte()) != -1 && b != 10) {
                if (bytes.Length == Limit) throw new DriverFault("INVALID_PARAMS");
                bytes.WriteByte((byte)b);
            }
            if (b == -1) { if (bytes.Length != 0) throw new DriverFault("INVALID_PARAMS"); return null; }
            return new UTF8Encoding(false, true).GetString(bytes.ToArray());
        }
    }
}
// Optional sitting telemetry. Each lane has one writer and publishes data before
// its count. No timing path allocates, locks, logs or changes a safety decision.
internal sealed class DriverCheckpointBuffer
{
    internal readonly int Capacity;
    readonly int[] kinds;
    readonly long[] ticks;
    int published, omitted;
    internal DriverCheckpointBuffer(int capacity) { Capacity = capacity; kinds = new int[capacity]; ticks = new long[capacity]; }
    internal int Count { get { return Volatile.Read(ref published); } }
    internal void Record(DriverCheckpointTimings.Kind kind, long duration)
    {
        int index = published;
        if (index == Capacity) { if (omitted < Int32.MaxValue) Volatile.Write(ref omitted, omitted + 1); return; }
        kinds[index] = (int)kind; ticks[index] = duration;
        Volatile.Write(ref published, index + 1);
    }
    // Only the worker resets Checks, before an action starts recording.
    internal void Reset() { published = 0; omitted = 0; }
    internal object Snapshot(int start, Dictionary<string, object> first)
    {
        int count = Count;
        var samples = new object[count - start];
        for (int i = start; i < count; i++) {
            string name = DriverCheckpointTimings.Name((DriverCheckpointTimings.Kind)kinds[i]);
            double elapsed = ticks[i] * (1000.0 / Stopwatch.Frequency);
            samples[i - start] = Json.Map("checkpoint", name, "elapsedMs", elapsed);
            if (!first.ContainsKey(name)) first[name] = Json.Map("elapsedMs", elapsed);
        }
        return Json.Map("capacity", Capacity, "start", start, "sampled", count, "omitted", Volatile.Read(ref omitted), "samples", samples);
    }
}
internal sealed class DriverCheckpointTimings
{
    internal enum Kind { SessionProbe, LockCheck, DesktopCheck, PersonInput, BudgetCheck, HookInstall, HookRemove }
    internal readonly DriverCheckpointBuffer Checks = new DriverCheckpointBuffer(65536);
    internal readonly DriverCheckpointBuffer Lifecycle = new DriverCheckpointBuffer(256);
    [ThreadStatic] internal static DriverCheckpointTimings Current;
    internal static string Name(Kind kind)
    {
        switch (kind) {
        case Kind.SessionProbe: return "session-probe";
        case Kind.LockCheck: return "lock-check";
        case Kind.DesktopCheck: return "desktop-check";
        case Kind.PersonInput: return "person-input";
        case Kind.BudgetCheck: return "budget-check";
        case Kind.HookInstall: return "hook-install";
        default: return "hook-remove";
        }
    }
    internal struct Span
    {
        internal DriverCheckpointBuffer Buffer;
        internal Kind Kind;
        internal long Started;
        internal void Finish()
        {
            try { if (Buffer != null) Buffer.Record(Kind, Stopwatch.GetTimestamp() - Started); } catch { }
        }
    }
    internal static Span Start(Kind kind) { return Start(Current == null ? null : Current.Checks, kind); }
    internal static Span Start(DriverCheckpointBuffer buffer, Kind kind)
    {
        try { if (buffer != null) return new Span { Buffer = buffer, Kind = kind, Started = Stopwatch.GetTimestamp() }; } catch { }
        return new Span();
    }
    internal sealed class Cursor
    {
        readonly DriverTurn owner;
        readonly DriverCheckpointTimings timings;
        readonly int checks, lifecycle, callbacks;
        internal Cursor(DriverTurn turn, DriverCheckpointTimings standalone = null)
        {
            owner = turn; timings = standalone ?? (turn == null ? null : turn.Timings);
            if (timings != null) { checks = timings.Checks.Count; lifecycle = timings.Lifecycle.Count; callbacks = turn == null ? 0 : turn.OwnSamples.Count; }
        }
        internal void Attach(object result)
        {
            // Telemetry failure cannot replace a completed action's outcome.
            var value = result as Dictionary<string, object>;
            try {
                if (timings == null || value == null) return;
                var first = Json.Map();
                object checkSamples = timings.Checks.Snapshot(checks, first);
                object hookSamples = timings.Lifecycle.Snapshot(lifecycle, first);
                double elapsedUs;
                if (owner != null && owner.OwnSamples.FirstSince(callbacks, out elapsedUs)) first["hook-callback"] = Json.Map("elapsedUs", elapsedUs);
                value["checkpointTimings"] = first;
                value["checkpointTimingSamples"] = Json.Map("checks", checkSamples, "hookLifecycle", hookSamples);
                // Preserve the action result when optional telemetry would crowd the 8 MiB envelope.
                if (Encoding.UTF8.GetByteCount(Json.Codec.Serialize(value)) > Json.OutputLimit / 2) {
                    value.Remove("checkpointTimings"); value.Remove("checkpointTimingSamples");
                }
            } catch {
                if (value != null) { value.Remove("checkpointTimings"); value.Remove("checkpointTimingSamples"); }
            }
        }
    }
}
// Report-only counts at the native operation boundaries. A request owns its
// counters so the reply reader can snapshot them even after a deadline.
internal sealed class DriverOperationCounters
{
    [ThreadStatic] internal static DriverOperationCounters Current;
    internal enum Kind { PostedMessage, PatternCall, UiaFetch, Capture, FinalRead }
    readonly long[] counts = new long[5];
    long identityCount, identityTicks, identityMax;
    internal void IdentityCheck(long started)
    {
        long elapsed = Stopwatch.GetTimestamp() - started;
        identityCount++; identityTicks += elapsed;
        if (elapsed > identityMax) identityMax = elapsed;
    }
    internal static void Mark(Kind kind) { var current = Current; if (current != null) Interlocked.Increment(ref current.counts[(int)kind]); }
    internal object JsonValue() {
        return Json.Map("postedMessages", Interlocked.Read(ref counts[0]), "patternCalls", Interlocked.Read(ref counts[1]),
            "uiaFetches", Interlocked.Read(ref counts[2]), "captures", Interlocked.Read(ref counts[3]), "finalReads", Interlocked.Read(ref counts[4]));
    }
    internal static int EscapeStops(DriverTurn turn) { return turn != null && turn.Escaped ? 1 : 0; }
    internal static void Attach(object result, DriverOperationCounters counters, DriverTurn turn) {
        var value = result as Dictionary<string, object>;
        try {
            if (counters == null || value == null) return;
            var snapshot = counters.JsonValue();
            value["escapeStops"] = EscapeStops(turn);
            value["counters"] = snapshot;
            value["identityChecks"] = Json.Map("count", counters.identityCount,
                "totalMs", counters.identityTicks * (1000.0 / Stopwatch.Frequency),
                "maxMs", counters.identityMax * (1000.0 / Stopwatch.Frequency));
        } catch {
            // Optional telemetry cannot replace the outcome of completed input.
            if (value != null) { value.Remove("escapeStops"); value.Remove("counters"); value.Remove("identityChecks"); }
        }
    }
}
internal sealed class Request
{
    internal long Id, Deadline;
    internal string Method;
    internal bool CheckpointTimings;
    internal Dictionary<string, object> Params;
    internal static Request Parse(string line, string nonce, long previous)
    {
        Json.UniqueKeys(line);
        var d = Json.Object(Json.Codec.DeserializeObject(line));
        Json.Keys(d, "protocol nonce id method params deadline", "checkpointTimings");
        if (Json.Text(d["protocol"]) != Driver.Protocol || Json.Text(d["nonce"]) != nonce) throw new DriverFault("INVALID_PARAMS");
        var r = new Request { Id = Json.Integer(d["id"], 1, 9007199254740991), Method = Json.Text(d["method"]),
            Deadline = Json.Integer(d["deadline"], 0, 9007199254740991), Params = Json.Object(d["params"]) };
        if (r.Id <= previous || r.Method.Length == 0 || r.Deadline > Driver.Now() + 30000) throw new DriverFault("INVALID_PARAMS");
        if (d.ContainsKey("checkpointTimings")) {
            if (!(d["checkpointTimings"] is bool) || !(bool)d["checkpointTimings"] ||
                r.Method == "ping" || r.Method == "cancel") throw new DriverFault("INVALID_PARAMS");
            r.CheckpointTimings = true;
        }
        return r;
    }
}
public static class Driver
{
    internal const string Protocol = "sleight.windows-driver/1";
    internal static readonly string[] Methods = new[] { "ping", "getState", "listApps", "getApp", "getAXState",
        "getScreenshot", "getAXStateAndScreenshot", "verifyWindowIdentity", "stuckMenuEscape", "cancel", "turn-start", "turn-end" }.Concat(DriverActionPlan.Methods).ToArray();
    internal static long Now() { return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000; }
    internal sealed class Job
    {
        internal Request Request;
        internal object Result;
        internal Exception Error;
        internal int Cancel, Finished;
        internal DriverTurn Turn;
        internal DriverOperationCounters Counters;
        internal readonly DriverInput.ProgressRecord Progress = new DriverInput.ProgressRecord();
        internal readonly ManualResetEvent Done = new ManualResetEvent(false);
        internal void Stop(DriverInput.StopReason reason) { Interlocked.CompareExchange(ref Cancel, (int)reason, 0); }
    }
    internal static object CancelRequest(Request request, ConcurrentDictionary<long, Job> pending)
    {
        Json.Keys(request.Params, "id");
        long id = Json.Integer(request.Params["id"], 1, 9007199254740991);
        Job target;
        bool inFlight = pending.TryGetValue(id, out target) && Volatile.Read(ref target.Finished) == 0;
        if (inFlight) target.Stop(DriverInput.StopReason.Cancel);
        return Json.Map("cancelled", id, "inFlight", inFlight);
    }
    static readonly object writer = new object();
    [ThreadStatic] static DriverHook actionHook;
    [ThreadStatic] static DriverTurn actionTurn;
    static object Dispatch(Request request, ref DriverUia reader)
    {
        try {
            DriverInput.EnsureNotCancelled();
            object result = DispatchCore(request, ref reader);
            if (request.Method != "ping") DriverSession.Require();
            DriverInput.EnsureNotCancelled();
            return result;
        } catch (DriverFault fault) {
            if (fault.Code == "IDENTITY_CHANGED" && DriverLifecycleRing.Enabled && request.Params.ContainsKey("windowId")) {
                try {
                    object events = DriverInventory.Lifecycle(DriverInventory.Hwnd(Json.Text(request.Params["windowId"])));
                    if (events != null) {
                        if (fault.Disposition == null) fault.Disposition = Json.Map();
                        fault.Disposition["lifecycleEvents"] = events;
                    }
                } catch { }
            }
            if (DriverSession.IsSafety(fault)) throw DriverSession.WireFault(fault);
            throw;
        }
    }
    static object DispatchCore(Request request, ref DriverUia reader)
    {
        var p = request.Params;
        if (request.Method == "ping") { Json.Keys(p, ""); return Json.Map("protocol", Protocol, "methods", Methods); }
        // Only real input in this request contributes to its delivery disposition.
        DriverInput.InputAttempted = false; DriverInput.Typed = 0; DriverInput.PostedMessages = 0;
        DriverActionPlan plan = null;
        // Validate before any native observation, even when the request skipped cua.mjs.
        if (request.Method == "getState" || request.Method == "listApps") {
            Json.Keys(p, "");
        } else if (request.Method == "getApp") {
            Json.Keys(p, "selector");
            var selector = p["selector"] as Dictionary<string, object>;
            if (selector != null) { Json.Keys(selector, "windowId"); DriverInventory.Hwnd(Json.Text(selector["windowId"])); }
            else {
                string name = Json.Text(p["selector"]);
                if (String.IsNullOrWhiteSpace(name) || name.Length > 32768) throw new DriverFault("INVALID_PARAMS");
            }
        } else if (request.Method == "getAXState" || request.Method == "getScreenshot" ||
            request.Method == "getAXStateAndScreenshot" || request.Method == "verifyWindowIdentity") {
            DriverIdentity.Binding(p);
        } else if (request.Method == "stuckMenuEscape") {
            plan = DriverActionPlan.Parse("pressKey", p);
            var args = p["args"] as object[];
            if (args == null || args.Length != 1 || Json.Text(args[0]) != "Escape") throw new DriverFault("INVALID_PARAMS");
            plan.StuckEscape = true;
        } else if (DriverActionPlan.Methods.Contains(request.Method)) {
            plan = DriverActionPlan.Parse(request.Method, p);
        } else throw new DriverFault("METHOD_NOT_FOUND");
        DriverSession.Require();
        DriverIdentity.BeginRequest();
        DriverInventory.BeginLifecycleRequest();
        using (var dpi = new DriverDpiScope()) {
            if (plan != null) {
                actionHook.Activate(actionTurn);
                DriverInput.EnsureBudget();
                if (reader == null) throw new DriverFault("STALE_READ");
                return reader.Action(plan, request.Deadline);
            }
            if (request.Method == "getState" || request.Method == "listApps") return DriverInventory.State(DriverInventory.Windows());
            var inventory = request.Method == "getApp" || request.Method == "getAXState" || request.Method == "getAXStateAndScreenshot"
                ? DriverInventory.Windows() : null;
            WindowRecord window = request.Method == "getApp" ? DriverInventory.Resolve(p["selector"], inventory) : DriverIdentity.Resolve(p);
            window.RequireReadable();
            window = DriverIdentity.Verify(window, DriverInventory.Observe(window.Handle));
            if (request.Method == "verifyWindowIdentity") {
                return Json.Map("window", window.JsonValue());
            }
            if (request.Method == "getScreenshot") return DriverCapture.Capture(window);
            if (reader == null) reader = new DriverUia();
            try {
            var result = Json.Object(reader.Read(window, inventory, request.Deadline));
            if (request.Method == "getAXStateAndScreenshot") {
                var captured = DriverCapture.CaptureForRead(window);
                foreach (var entry in captured) result[entry.Key] = entry.Value;
                var final = Json.Object(result["window"]);
                string tree = (string)result["text"];
                int newline = tree.IndexOf('\n');
                result["text"] = "Window: " + Json.Codec.Serialize(DriverUia.Clean((string)final["title"])) + ", App: " +
                    DriverUia.Clean((string)final["app"]) + "." + (newline < 0 ? "" : tree.Substring(newline));
            } else {
                try { result["geometry"] = DriverGeometry.Observe(window).JsonValue(); }
                catch (Exception) { result["geometry"] = Json.Map("exposure", "unknown"); }
                DriverIdentity.Verify(window, DriverInventory.Observe(window.Handle));
            }
            if (request.Method == "getApp" && DriverLifecycleRing.Enabled) {
                object events = DriverInventory.Lifecycle(window.Handle);
                if (events != null) result["lifecycleEvents"] = events;
            }
            return result;
            } catch { reader.InvalidateRead(); throw; }
        }
    }
    static string Encode(object value)
    {
        string line = Json.Codec.Serialize(value);
        if (Encoding.UTF8.GetByteCount(line) > Json.OutputLimit) throw new DriverFault("OUTPUT_LIMIT");
        return line;
    }
    internal static string ResponseLine(Dictionary<string, object> response)
    {
        try { return Encode(response); }
        catch (InvalidOperationException) { }
        catch (ArgumentException) { }
        catch (DriverFault e) { if (e.Code != "OUTPUT_LIMIT") throw; }
        // Complete serialization before writing any bytes, preserving this request's correlation.
        return Encode(Json.Map("protocol", response["protocol"], "nonce", response["nonce"], "id", response["id"],
            "ok", false, "error", Json.Map("code", "OUTPUT_LIMIT", "message", "Driver output limit exceeded.", "unhealthy", false)));
    }
    static void Write(object value) { string line = Encode(value); lock (writer) { Console.Out.WriteLine(line); } }
    static void WriteResponse(Dictionary<string, object> response)
    {
        string line = ResponseLine(response);
        lock (writer) { Console.Out.WriteLine(line); }
    }
    internal static int SelfTest()
    {
        string nonce = new string('a', 64);
        var d = Json.Map("protocol", Protocol, "nonce", nonce, "id", 1, "method", "ping", "params", Json.Map(), "deadline", Now() + 5000);
        var request = Request.Parse(Json.Codec.Serialize(d), nonce, 0);
        int passed = 0;
        if (request.Method != "ping") throw new Exception(); passed++;
        try { Request.Parse(Json.Codec.Serialize(d), nonce, 1); throw new Exception(); } catch (DriverFault) { passed++; }
        try { Request.Parse(Json.Codec.Serialize(d), new string('b', 64), 0); throw new Exception(); } catch (DriverFault) { passed++; }
        try { Json.UniqueKeys("{\"id\":1,\"\\u0069d\":2}"); throw new Exception(); } catch (DriverFault) { passed++; }
        d["deadline"] = Now() + 60000;
        try { Request.Parse(Json.Codec.Serialize(d), nonce, 0); throw new Exception(); } catch (DriverFault) { passed++; }
        d["deadline"] = 0;
        if (Request.Parse(Json.Codec.Serialize(d), nonce, 0).Deadline >= Now()) throw new Exception(); passed++;
        try { Json.Integer(1.5m, 1, 10); throw new Exception(); } catch (DriverFault) { passed++; }
        bool truncated;
        var nodes = new List<DriverNode> {
            new DriverNode { Depth = 0, Role = "standard window", Name = "Untitled", RuntimeId = new int[] { 1 } },
            new DriverNode { Depth = 1, Role = "text field", Name = "secret", Value = "never print", Password = true, Help = "secret" }
        };
        var map = new Dictionary<int, DriverNode>();
        string tree = DriverUia.Serialize("Untitled", "Notepad", nodes, map, out truncated);
        if (tree.Contains("secret") || tree.Contains("never print") || !tree.Contains("1 text field <redacted>") || map.Count != 2) throw new Exception(); passed++;
        using (var stream = new MemoryStream(Encoding.UTF8.GetBytes("{}"))) {
            try { Json.Read(stream); throw new Exception(); } catch (DriverFault) { passed++; }
        }
        using (var stream = new MemoryStream(new byte[] { 255, 10 })) {
            try { Json.Read(stream); throw new Exception(); } catch (DecoderFallbackException) { passed++; }
        }
        if (DriverUia.Role(50004) != "text field" || DriverUia.Role(50007) != "list item") throw new Exception(); passed++;
        var calculator = new List<DriverNode> {
            new DriverNode { Depth = 0, Role = "standard window", Name = "Calculator" },
            new DriverNode { Depth = 1, Role = "text", Name = "Display is 0", Id = "CalculatorResults" },
            new DriverNode { Depth = 1, Role = "group", Name = "Number pad" },
            new DriverNode { Depth = 2, Role = "button", Name = "Seven", Id = "num7Button" },
            new DriverNode { Depth = 2, Role = "button", Name = "Plus", Id = "plusButton" },
            new DriverNode { Depth = 2, Role = "button", Name = "Five", Id = "num5Button" },
            new DriverNode { Depth = 2, Role = "button", Name = "Equals", Id = "equalButton" }
        };
        foreach (var node in calculator.Skip(3)) node.Actions.Add("Invoke");
        map.Clear();
        string calculatorTree = DriverUia.Serialize("Calculator", "Calculator", calculator, map, out truncated);
        if (truncated || map.Count != 7 || !calculatorTree.Contains("\t\t6 button Equals, ID: equalButton, Secondary Actions: Invoke")) throw new Exception(); passed++;
        var actionParams = Json.Map("windowId", "101", "processStart", "3", "readId", 1, "args", new object[] { 3 });
        if (DriverActionPlan.Parse("click", actionParams).ReadId != 1) throw new Exception(); passed++;
        actionParams["args"] = new object[] { -1 };
        try { DriverActionPlan.Parse("click", actionParams); throw new Exception(); } catch (DriverFault) { passed++; }
        if (DriverChord.Parse("control+shift+enter").Canonical != DriverChord.Parse("shift+ctrl+return").Canonical) throw new Exception(); passed++;
        if (DriverSettle.Decision(120, 120, 1, true, false) != "event-quiet") throw new Exception(); passed++;
        if (DriverSettle.Decision(1500, 1500, 1, true, false) != "cap") throw new Exception(); passed++;
        if (DriverInput.Pack(new DriverPoint(-1, -2)).ToInt64() != 0xfffeffffL) throw new Exception(); passed++;
        Write(Json.Map("protocol", Protocol, "drawing", false, "passed", passed, "failed", 0, "text", tree, "calculator", calculatorTree));
        return 0;
    }
    internal static Dictionary<string, object> ErrorValue(Exception error)
    {
        var fault = error as DriverFault;
        var value = Json.Map("code", fault == null ? "UIA_UNAVAILABLE" : fault.Code,
            "message", fault == null ? "Windows automation is unavailable." : fault.Message, "unhealthy", false);
        if (fault != null && fault.Disposition != null) {
            foreach (string key in new[] { "delivery", "retry", "reason", "typed", "personTookOver", "limits" })
                if (fault.Disposition.ContainsKey(key)) value[key] = fault.Disposition[key];
            if (fault.Code == "IDENTITY_CHANGED" && DriverLifecycleRing.Enabled && fault.Disposition.ContainsKey("lifecycleEvents"))
                value["lifecycleEvents"] = fault.Disposition["lifecycleEvents"];
        }
        return value;
    }
    public static int Entry(string[] args)
    {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = true });
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        if (args.Length != 1) return 64;
        if (args[0] == "--capabilities") {
            Write(Json.Map("schema", "sleight.windows-driver-capabilities/1", "protocol", Protocol, "drawing", false,
                "modes", new[] { "--driver", "--driver-selftest", "--capabilities" }, "methods", Methods)); return 0;
        }
        if (args[0] == "--driver-selftest") {
            try { return SelfTest(); } catch { Console.Error.WriteLine("DRIVER_SELFTEST_FAILED"); return 70; }
        }
        if (args[0] != "--driver") return 64;
        string nonce = Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_NONCE");
        if (nonce == null || !Regex.IsMatch(nonce, "\\A[a-f0-9]{64}\\z")) return 64;
        if (Environment.OSVersion.Platform != PlatformID.Win32NT) return 69;
        if (!DriverInput.SetProcessDpiAwarenessContext(new IntPtr(-4))) { Console.Error.WriteLine("DPI_UNAVAILABLE"); return 69; }
        var incoming = new BlockingCollection<Job>(32);
        var jobs = new BlockingCollection<Job>(1);
        var pending = new ConcurrentDictionary<long, Job>();
        var invalid = new ManualResetEvent(false);
        var hooks = new DriverHook();
        var worker = new Thread(() => {
            DriverUia reader = null;
            actionHook = hooks;
            try {
                foreach (var job in jobs.GetConsumingEnumerable()) {
                    actionTurn = job.Turn;
                    bool inputBearing = job.Request.Method == "stuckMenuEscape" || DriverActionPlan.Methods.Contains(job.Request.Method);
                    DriverInput.Cancelled = () => {
                        var reason = (DriverInput.StopReason)Volatile.Read(ref job.Cancel);
                        return reason != DriverInput.StopReason.None ? reason : inputBearing && job.Turn != null && job.Turn.Escaped ? DriverInput.StopReason.Escape : DriverInput.StopReason.None;
                    };
                    DriverInput.Progress = job.Progress;
                    DriverOperationCounters.Current = job.Counters;
                    DriverInput.InputAttempted = false; DriverInput.Typed = 0; DriverInput.PostedMessages = 0;
                    // Reads keep the production path: no turn-start, hook activation or lost-turn fence.
                    var timings = job.Request.CheckpointTimings ? (job.Turn == null ? new DriverCheckpointTimings() : job.Turn.Timings) : null;
                    if (timings != null) timings.Checks.Reset();
                    DriverCheckpointTimings.Current = timings;
                    var timingCursor = job.Request.CheckpointTimings ? new DriverCheckpointTimings.Cursor(job.Turn, timings) : null;
                    try {
                        job.Result = Dispatch(job.Request, ref reader);
                        if (timingCursor != null) timingCursor.Attach(job.Result);
                    } catch (Exception e) { job.Error = e; }
                    finally {
                        DriverCheckpointTimings.Current = null;
                        DriverOperationCounters.Current = null;
                        DriverInput.Cancelled = null; DriverInput.Progress = null; actionTurn = null;
                        Volatile.Write(ref job.Finished, 1); job.Done.Set();
                    }
                }
            } finally { if (reader != null) reader.Dispose(); DriverInventory.CloseDesktop(); }
        });
        worker.IsBackground = true; worker.SetApartmentState(ApartmentState.MTA); worker.Start();
        var inputThread = new Thread(() => {
            try {
                long previous = 0;
                using (var input = new BufferedStream(Console.OpenStandardInput(), 65536)) {
                    string line;
                    while ((line = Json.Read(input)) != null) {
                        var request = Request.Parse(line, nonce, previous); previous = request.Id;
                        if (request.Method == "turn-start" || request.Method == "turn-end") {
                            Json.Keys(request.Params, "turn");
                            long id = Json.Integer(request.Params["turn"], 1, 9007199254740991);
                            if (request.Deadline <= Now()) throw new DriverFault("INVALID_PARAMS");
                            object result;
                            try {
                                if (request.Method == "turn-start") {
                                    hooks.BeginTurn(id); result = Json.Map("turn", id, "active", true);
                                    if (request.CheckpointTimings) hooks.EnableTimings(id);
                                } else {
                                    var timingCursor = request.CheckpointTimings ? new DriverCheckpointTimings.Cursor(hooks.CurrentTurn) : null;
                                    foreach (var target in pending.Values) if (target.Turn != null && target.Turn.Id == id)
                                        target.Stop(DriverInput.StopReason.Cancel);
                                    result = hooks.EndTurn(id);
                                    if (timingCursor != null) timingCursor.Attach(result);
                                }
                            } catch (DriverFault e) {
                                if (e.Code == "INVALID_PARAMS") throw;
                                WriteResponse(Json.Map("protocol", Protocol, "nonce", nonce, "id", request.Id,
                                    "ok", false, "error", ErrorValue(e)));
                                continue;
                            }
                            WriteResponse(Json.Map("protocol", Protocol, "nonce", nonce, "id", request.Id,
                                "ok", true, "result", result));
                            continue;
                        }
                        hooks.RequestSeen();
                        if (request.Method == "cancel") {
                            WriteResponse(Json.Map("protocol", Protocol, "nonce", nonce, "id", request.Id,
                                "ok", true, "result", CancelRequest(request, pending)));
                            continue;
                        }
                        var job = new Job { Request = request, Turn = hooks.CurrentTurn,
                            Counters = Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS") == "1" ? new DriverOperationCounters() : null };
                        if (!pending.TryAdd(request.Id, job) || !incoming.TryAdd(job)) throw new DriverFault("DRIVER_BUSY");
                    }
                }
            } catch { invalid.Set(); }
            finally {
                if (invalid.WaitOne(0)) foreach (var job in pending.Values) job.Stop(DriverInput.StopReason.Cancel);
                incoming.CompleteAdding();
            }
        }) { IsBackground = true };
        inputThread.Start();
        try {
            foreach (var job in incoming.GetConsumingEnumerable()) {
                if (invalid.WaitOne(0)) { Console.Error.WriteLine("DRIVER_PROTOCOL_INVALID"); return 65; }
                var request = job.Request;
                var response = Json.Map("protocol", Protocol, "nonce", nonce, "id", request.Id);
                long remaining = request.Deadline - Now();
                bool complete = false;
                if (remaining > 0) {
                    jobs.Add(job);
                    complete = WaitHandle.WaitAny(new WaitHandle[] { job.Done, invalid }, (int)Math.Min(remaining, 30000)) == 0;
                }
                if (invalid.WaitOne(0)) { Console.Error.WriteLine("DRIVER_PROTOCOL_INVALID"); return 65; }
                if (!complete) {
                    job.Stop(DriverInput.StopReason.Deadline);
                    bool cleaned = job.Done.WaitOne(300); // Allow owned input cleanup before retiring.
                    string progress = request.Method == "typeText" ? " typed=" + Volatile.Read(ref job.Progress.Units) +
                        " UTF-16 units; postedMessages=" + Volatile.Read(ref job.Progress.Posts) + " at retirement." : "";
                    response.Add("ok", false); response.Add("error", Json.Map("code", "DEADLINE_EXCEEDED", "message",
                        "Driver deadline exceeded." + DriverSession.DeadlineHint() + progress + " Input may have landed; read again before repeating. Cleanup completed: " + cleaned + ". Clipboard recovery after termination is unproved.", "unhealthy", true));
                    DriverOperationCounters.Attach(response["error"], job.Counters, job.Turn);
                    WriteResponse(response); return 70;
                }
                Job removed; pending.TryRemove(request.Id, out removed);
                // Cancel reads Finished, never this disposable wait handle.
                job.Done.Dispose();
                response.Add("ok", job.Error == null);
                if (job.Error == null) response.Add("result", job.Result);
                else response.Add("error", ErrorValue(job.Error));
                DriverOperationCounters.Attach(response[job.Error == null ? "result" : "error"], job.Counters, job.Turn);
                WriteResponse(response);
            }
            if (invalid.WaitOne(0)) { Console.Error.WriteLine("DRIVER_PROTOCOL_INVALID"); return 65; }
            return 0;
        } catch { Console.Error.WriteLine("DRIVER_PROTOCOL_INVALID"); return 65; }
        finally {
            foreach (var job in pending.Values) job.Stop(DriverInput.StopReason.Cancel);
            jobs.CompleteAdding(); worker.Join(300);
            hooks.Dispose();
        }
    }
}
}

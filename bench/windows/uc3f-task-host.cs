using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

// A GUI-subsystem task host has no console for Windows Terminal to delegate.
// Snapshot restore owns guest cleanup, including children left after a timeout.
public static class Uc3fTaskHost {
    static void Ordinary(string path, bool directory) {
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0 || ((attributes & FileAttributes.Directory) != 0) != directory)
            throw new InvalidOperationException("TASK_HOST_PATH_UNSAFE");
    }
    static int outputBytes;
    static void Drain(Stream stream) {
        var buffer = new byte[4096]; int count;
        while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
            Interlocked.Add(ref outputBytes, count);
            if (Volatile.Read(ref outputBytes) > 131072) return;
        }
    }
    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--selftest") {
            using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
                writer.WriteLine("{\"drawing\":false,\"createNoWindow\":true,\"bounded\":true}");
            return 0;
        }
        if (args.Length != 3 || !Regex.IsMatch(args[0], @"\AC:\\sleight-setup\\uc3f-[a-f0-9]{16}\z") ||
            !Regex.IsMatch(args[1], @"\A[1-9][0-9]{0,5}\z") || args[2] != "45" && args[2] != "900") return 64;
        Process child = null;
        Task output = null, errors = null;
        try {
            Ordinary(@"C:\", true); Ordinary(@"C:\sleight-setup", true); Ordinary(args[0], true);
            string script = Path.Combine(args[0], "uc3f-task.ps1"); Ordinary(script, false);
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"));
            start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -Bank \"" + args[0] + "\" -Invocation " + args[1];
            start.WorkingDirectory = args[0]; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            child = Process.Start(start);
            if (child == null) throw new InvalidOperationException("TASK_HOST_START_FAILED");
            output = Task.Run(() => Drain(child.StandardOutput.BaseStream));
            errors = Task.Run(() => Drain(child.StandardError.BaseStream));
            var clock = Stopwatch.StartNew(); int budget = Int32.Parse(args[2]) * 1000;
            while (!child.WaitForExit(50)) {
                if (clock.ElapsedMilliseconds >= budget || Volatile.Read(ref outputBytes) > 131072)
                    throw new InvalidOperationException("TASK_HOST_LIMIT");
            }
            if (!Task.WaitAll(new[] { output, errors }, 5000) || Volatile.Read(ref outputBytes) > 131072)
                throw new InvalidOperationException("TASK_HOST_OUTPUT_UNPROVED");
            return child.ExitCode;
        } catch { return 70; }
        finally {
            if (child != null) {
                child.Dispose();
            }
            if (output != null && errors != null) { try { Task.WaitAll(new[] { output, errors }, 5000); } catch { } }
        }
    }
}

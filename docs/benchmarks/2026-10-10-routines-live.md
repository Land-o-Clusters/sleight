# Routines, first live run

sleight-arch ran the routine check on 2026-10-10 with the owner's OK, while the owner was away.

1. `sleight-mcp record` built a 2-step script from a Calculator benchmark session (acquire, then
   AC, 17 × 23 =). `sleight-mcp replay` ran it: both steps passed, in 1.6 s and 3.3 s.
2. `routine add` first refused the script. The routine grammar parsed arguments as strict JSON, and
   recorded scripts write `{ id: "One" }`, so no recorded script could become a routine. Fixed in
   `8904dcc` with a test. After that it printed the launchd job, and the owner typed `install`.
3. launchd fired the job on schedule in the owner's session (19:39 UTC) and it exited 1. The
   launcher runs the installed plugin so routines survive updates, and the installed copy was 1.1.0,
   which has no routines. A launchd run needs a release that includes routines.
4. `routine run-now` with the repo's build ran the saved routine against the same idle gate. The
   first try refused, correctly, because Calculator's window was on another Space, so Accessibility listed
   no window. After Calculator was relaunched in the background, the run passed all 10 steps with a
   window check before each input, and Calculator showed `17 × 23` and `391`. The owner had been idle
   384 s.
5. `routine remove` printed what it would unload and delete and waited for the owner to type
   `remove`.

Demonstration recording (`record --watch`) needs the owner at a terminal and hasn't run live.

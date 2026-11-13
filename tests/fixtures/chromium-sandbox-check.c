#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <limits.h>
#include <string.h>

// Test-only macOS SPI, absent from the public SDK header. The filter values
// are the Darwin Sandbox SPI values also used by WebKit's SandboxSPI.h.
extern int sandbox_check(pid_t pid, const char *operation, int filter, ...);
enum { SANDBOX_FILTER_NONE = 0, SANDBOX_FILTER_GLOBAL_NAME = 2, SANDBOX_FILTER_APPLEEVENT_DESTINATION = 4 };

// Permission queries only. This never sends a request to Launch Services.
int main(int argc, char **argv) {
    pid_t pid = getpid();
    int wait_for_stdin = argc == 2 && strcmp(argv[1], "--wait") == 0;
    if (argc == 2 && !wait_for_stdin) {
        char *end;
        long candidate = strtol(argv[1], &end, 10);
        if (!*argv[1] || *end || candidate <= 0 || candidate > INT_MAX) return 64;
        pid = (pid_t)candidate;
    } else if (argc != 1 && !wait_for_stdin) return 64;
    int open_service = sandbox_check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "com.apple.lsd.open");
    int lsopen = sandbox_check(pid, "lsopen", SANDBOX_FILTER_NONE);
    int events = sandbox_check(pid, "appleevent-send", SANDBOX_FILTER_APPLEEVENT_DESTINATION, "com.apple.mail");
    int registration = sandbox_check(pid, "mach-lookup", SANDBOX_FILTER_GLOBAL_NAME, "com.apple.coreservices.launchservicesd");
    printf("{\"openServiceDenied\":%s,\"lsopenDenied\":%s,\"appleEventsDenied\":%s,\"registrationAllowed\":%s}\n",
        open_service == 1 ? "true" : "false", lsopen == 1 ? "true" : "false", events == 1 ? "true" : "false", registration == 0 ? "true" : "false");
    fflush(stdout);
    if (wait_for_stdin) while (getchar() != EOF) {}
    return open_service == 1 && lsopen == 1 && events == 1 && registration == 0 ? 0 : 1;
}

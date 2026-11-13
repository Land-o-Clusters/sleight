/* Original sleight source. Darwin peer metadata only; no app or input APIs. */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <bsm/libbsm.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <limits.h>
#include <errno.h>
#include <stdint.h>
#include <mach/machine.h>

/* xnu bsd/sys/codesign.h; csops is in libsystem_kernel but not in the user SDK headers. */
int csops(pid_t pid, unsigned int ops, void *useraddr, size_t usersize);
#define CS_OPS_STATUS 0
#define CS_OPS_CDHASH 5

/* The architecture whose slice the kernel runs, as codesign --architecture names it. */
static const char *architecture(const struct proc_archinfo *info) {
  cpu_subtype_t subtype = info->p_cpusubtype & ~CPU_SUBTYPE_MASK;
  if (info->p_cputype == CPU_TYPE_ARM64)
    return subtype == CPU_SUBTYPE_ARM64E ? "arm64e" : subtype == CPU_SUBTYPE_ARM64_ALL || subtype == CPU_SUBTYPE_ARM64_V8 ? "arm64" : NULL;
  if (info->p_cputype == CPU_TYPE_X86_64)
    return subtype == CPU_SUBTYPE_X86_64_H ? "x86_64h" : subtype == CPU_SUBTYPE_X86_64_ALL ? "x86_64" : NULL;
  return NULL;
}

/* With code set, also the kernel's live code-signing status, the cdhash of the code directory the process runs and
 * its architecture, read between the two birth reads so they belong to the same incarnation. */
static int process_metadata(const char *argument, const char *expected, int code) {
  char *end = NULL, canonical[PATH_MAX], actual[PROC_PIDPATHINFO_MAXSIZE];
  errno = 0;
  long value = strtol(argument, &end, 10);
  if (errno || !end || *end || argument[0] < '1' || argument[0] > '9' || value < 1 || value > INT_MAX ||
      expected[0] != '/' || !realpath(expected, canonical) || strcmp(canonical, expected)) return 64;
  pid_t pid = (pid_t)value;
  struct proc_bsdinfo first, last;
  memset(&first, 0, sizeof(first)); memset(&last, 0, sizeof(last));
  memset(actual, 0, sizeof(actual));
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &first, sizeof(first)) != sizeof(first) ||
      first.pbi_pid != (unsigned)pid || first.pbi_uid != getuid() || !first.pbi_start_tvsec ||
      proc_pidpath(pid, actual, sizeof(actual)) <= 0 || !realpath(actual, canonical) || strcmp(canonical, expected)) return 65;
  uint32_t status = 0;
  unsigned char cdhash[20];
  struct proc_archinfo arch;
  const char *name = NULL;
  memset(cdhash, 0, sizeof(cdhash)); memset(&arch, 0, sizeof(arch));
  if (code && (csops(pid, CS_OPS_STATUS, &status, sizeof(status)) || csops(pid, CS_OPS_CDHASH, cdhash, sizeof(cdhash)) ||
      proc_pidinfo(pid, PROC_PIDARCHINFO, 0, &arch, sizeof(arch)) != sizeof(arch) || !(name = architecture(&arch)))) return 65;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &last, sizeof(last)) != sizeof(last) ||
      last.pbi_pid != first.pbi_pid || last.pbi_uid != first.pbi_uid ||
      last.pbi_start_tvsec != first.pbi_start_tvsec || last.pbi_start_tvusec != first.pbi_start_tvusec) return 65;
  printf("{\"uid\":%u,\"pid\":%d,\"start\":%.3f,\"incarnation\":\"p%d-s%llu-u%llu\"",
    first.pbi_uid, pid, (double)first.pbi_start_tvsec * 1000.0 + (double)first.pbi_start_tvusec / 1000.0,
    pid, (unsigned long long)first.pbi_start_tvsec, (unsigned long long)first.pbi_start_tvusec);
  if (code) {
    printf(",\"flags\":%u,\"arch\":\"%s\",\"cdhash\":\"", status, name);
    for (size_t i = 0; i < sizeof(cdhash); i++) printf("%02x", cdhash[i]);
    printf("\"");
  }
  printf("}\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 4 && !strcmp(argv[1], "--process-pid")) return process_metadata(argv[2], argv[3], 0);
  if (argc == 4 && !strcmp(argv[1], "--code-status")) return process_metadata(argv[2], argv[3], 1);
  if (argc != 3 || strcmp(argv[1], "--peer-fd") || strcmp(argv[2], "3")) return 64;
  struct sockaddr_un address;
  socklen_t length = sizeof(address);
  uid_t uid; gid_t gid; pid_t pid = 0;
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  if (getpeername(3, (struct sockaddr *)&address, &length) || address.sun_family != AF_UNIX ||
      getpeereid(3, &uid, &gid) || uid != getuid()) return 65;
  length = sizeof(pid);
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) || length != sizeof(pid)) return 65;
  audit_token_t token;
  length = sizeof(token);
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) || length != sizeof(token) ||
      audit_token_to_pid(token) != pid || audit_token_to_euid(token) != uid) return 65;
  if (pid < 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_pid != (unsigned)pid || info.pbi_uid != uid || !info.pbi_start_tvsec) return 65;
  printf("{\"uid\":%u,\"pid\":%d,\"incarnation\":\"p%d-v%u\"}\n",
    uid, pid, pid, (unsigned)audit_token_to_pidversion(token));
  return 0;
}

/*
 * reval-peer: closed peer-incarnation probe of the R-EVAL RS-A controller (docs/stage5/ask/remote/reval-server/rs-a/
 * IMPLEMENTATION_BRIEF.md §2). Darwin arm64 only. argv: exactly "peer". fd 3: an AF_UNIX socket whose PEER is examined.
 * fd 4: a pipe carrying the expected executable realpath (read to EOF). stdout: exactly one line
 *   {"pid":N,"pidversion":N,"euid":N,"ppid":N,"startSec":N,"startUsec":N,"hasTty":B,"exeMatch":B}
 * The kernel audit token names the LAST process that performed I/O on the peer socket (XNU last_pid): the caller only asks
 * after the peer wrote. Race-free order: token1 -> pidinfo(pid) -> proc_pidpath_audittoken(token1) must succeed (the
 * incarnation still exists, so pidinfo belonged to it) -> token2 must equal token1. Any failure: no output, nonzero exit.
 * This proves the peer pid/incarnation/uid/executable path only; it is NOT a loaded-image measurement.
 * RS-D-B: a second closed mode, argv exactly "sandbox <pid>" (decimal, no fd): the kernel's Seatbelt answer for that pid, one line
 *   {"pid":N,"sandboxed":B,"resolverDenied":B}
 * from the private libsystem_sandbox sandbox_check (1 = sandboxed / denied): (pid, NULL, SANDBOX_FILTER_NONE) and
 * (pid, "network-outbound", SANDBOX_FILTER_PATH, the system DNS resolver socket) — the deny the pinned S profile adds.
 */
#include <bsm/libbsm.h>
#include <libproc.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <stdlib.h>
#include <unistd.h>

/* Private libsystem_sandbox entry point (stable since 10.7); SANDBOX_FILTER_NONE = 0, SANDBOX_FILTER_PATH = 1. */
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
static const char RESOLVER_SOCKET[] = "/private/var/run/mDNSResponder";

static int read_expected(char *out, size_t cap) {
  size_t used = 0;
  for (;;) {
    ssize_t n = read(4, out + used, cap - used);
    if (n < 0) return -1;
    if (n == 0) break;
    used += (size_t)n;
    if (used >= cap) return -1;
  }
  if (used == 0 || memchr(out, '\0', used) != NULL || out[0] != '/') return -1;
  out[used] = '\0';
  return 0;
}

/* "sandbox <pid>": strict decimal pid 1..INT32_MAX; both answers must be 0 or 1 (an error answer is a failure, never "false"). */
static int sandbox_mode(const char *arg) {
  char *end = NULL;
  if (arg[0] < '1' || arg[0] > '9' || strlen(arg) > 10) return 64;
  long v = strtol(arg, &end, 10);
  if (end == NULL || *end != '\0' || v <= 0 || v > 2147483647L) return 64;
  pid_t pid = (pid_t)v;
  struct proc_bsdinfo bi;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof bi) != (int)sizeof bi || (pid_t)bi.pbi_pid != pid) return 68;
  int any = sandbox_check(pid, NULL, 0);
  int resolver_denied = sandbox_check(pid, "network-outbound", 1, RESOLVER_SOCKET);
  if ((any != 0 && any != 1) || (resolver_denied != 0 && resolver_denied != 1)) return 72;
  if (printf("{\"pid\":%d,\"sandboxed\":%s,\"resolverDenied\":%s}\n", (int)pid, any ? "true" : "false", resolver_denied ? "true" : "false") < 0) return 71;
  return fflush(stdout) == 0 ? 0 : 71;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "sandbox") == 0) return sandbox_mode(argv[2]);
  if (argc != 2 || strcmp(argv[1], "peer") != 0) return 64;
  struct stat st;
  if (fstat(3, &st) != 0 || !S_ISSOCK(st.st_mode)) return 65;
  char expected[PROC_PIDPATHINFO_MAXSIZE + 1];
  if (read_expected(expected, sizeof expected - 1) != 0) return 66;

  audit_token_t t1, t2;
  socklen_t len = sizeof t1;
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &t1, &len) != 0 || len != sizeof t1) return 67;
  pid_t pid = audit_token_to_pid(t1);
  int pidversion = audit_token_to_pidversion(t1);
  uid_t euid = audit_token_to_euid(t1);
  if (pid <= 0) return 67;

  struct proc_bsdinfo bi;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof bi) != (int)sizeof bi || (pid_t)bi.pbi_pid != pid) return 68;
  char path[PROC_PIDPATHINFO_MAXSIZE];
  memset(path, 0, sizeof path);
  if (proc_pidpath_audittoken(&t1, path, sizeof path) <= 0) return 69;
  len = sizeof t2;
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &t2, &len) != 0 || len != sizeof t2 || memcmp(&t1, &t2, sizeof t1) != 0) return 70;

  int has_tty = bi.e_tdev != (uint32_t)NODEV;
  int exe_match = strcmp(path, expected) == 0;
  if (printf("{\"pid\":%d,\"pidversion\":%d,\"euid\":%u,\"ppid\":%u,\"startSec\":%llu,\"startUsec\":%llu,\"hasTty\":%s,\"exeMatch\":%s}\n",
             (int)pid, pidversion, (unsigned)euid, (unsigned)bi.pbi_ppid, (unsigned long long)bi.pbi_start_tvsec,
             (unsigned long long)bi.pbi_start_tvusec, has_tty ? "true" : "false", exe_match ? "true" : "false") < 0) return 71;
  return fflush(stdout) == 0 ? 0 : 71;
}

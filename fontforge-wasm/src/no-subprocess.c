/* ffconv: FontForge must never start a subprocess (P2 plan, P2-11; from spike S1's support/no-subprocess.c,
 * unchanged apart from this header).
 *
 * FontForge calls system() to decompress or unpack inputs (gunzip, bunzip2, unzip, tar ...), for autotrace and for a
 * few other helpers. In a browser that simply fails, but under Node.js Emscripten's libc forwards system() to
 * child_process.spawnSync(cmd, {shell: true}), i.e. the command built by FontForge from (unquoted) file names would
 * run in the HOST shell.
 *
 * This definition is linked ahead of libc so that system() fails the same way in every environment and nothing can
 * reach a host shell. (fork()/exec*() already fail with ENOSYS in Emscripten's libc.) N7 checks it through
 * `ffconv selftest-system` and that the glue holds no child_process.
 */
#include <errno.h>
#include <stdlib.h>

int system(const char *command) {
    if (command == NULL) {
        return 0; /* "no command processor is available" */
    }
    errno = ENOSYS;
    return -1;
}

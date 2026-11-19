/* selftest_assert.c -- the `selftest-assert` test hook, in the shipped build (P1 plan, P1-1 and P1-14).
 *
 * It reproduces the situation libeot's decompressor is in when one of its assert()s fails: plain C code, called
 * below a frame that has called setjmp(), hits assert(). main.cc replaces the C library's assert handler
 * (__assert_fail in musl/wasm, __assert_rtn on macOS) with one that throws a C++ exception; this hook lets N11 see
 * that the exception really travels through the C frames (including the setjmp one) up to main(), on both backends.
 */
#include <assert.h>
#include <setjmp.h>

static int fontwrap_selftest_inner(volatile int depth)
{
  if (depth > 0) {
    return fontwrap_selftest_inner(depth - 1) + 1;
  }
  assert(depth == 12345 && "fontwrap selftest assert");
  return 0;
}

int fontwrap_selftest_assert(void)
{
  jmp_buf env;
  if (setjmp(env) != 0) {
    return -1; /* a longjmp would land here; none is made */
  }
  return fontwrap_selftest_inner(3);
}

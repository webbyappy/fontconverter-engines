/* ffconv: qsort ordered as glibc 2.31's merge sort orders it (P2 plan, P2-25; the owner's decision of 2026-11-18,
 * after Codex's review).
 *
 * FontForge sorts with qsort, and several of its comparators let distinct records tie (feature records by tag alone,
 * tables by placement priority). musl (the wasm build), macOS libc (the native test build) and glibc (production's
 * FontForge on Ubuntu 20.04) break those ties differently, so the same font came out with GSUB/GPOS records and the
 * table directory in different orders. glibc's qsort is a merge sort that keeps the left element whenever
 * cmp(left, right) <= 0 (stdlib/msort.c, msort_with_tmp); this file is that algorithm, linked ahead of libc like
 * no-subprocess.c, so every build orders records as production does. The same rule also sorts correctly with the
 * comparators FontForge has that answer only 0 or 1 (SortBlues, SortStems, sortbynum, sortedges), as glibc does.
 * N11 checks it through `ffconv selftest-sort`.
 *
 * One temporary buffer of n * size bytes per call. If it cannot be had, ffconv fails closed: an unstable fallback
 * would give up the determinism this file exists for.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*compare_fn)(const void *, const void *);

static void msort_with_tmp(char *b, size_t n, size_t s, compare_fn cmp, char *t) {
    if (n <= 1) return;
    size_t n1 = n / 2;
    size_t n2 = n - n1;
    char *b1 = b;
    char *b2 = b + n1 * s;
    msort_with_tmp(b1, n1, s, cmp, t);
    msort_with_tmp(b2, n2, s, cmp, t);
    char *tmp = t;
    while (n1 > 0 && n2 > 0) {
        if (cmp(b1, b2) <= 0) {
            memcpy(tmp, b1, s);
            b1 += s;
            --n1;
        } else {
            memcpy(tmp, b2, s);
            b2 += s;
            --n2;
        }
        tmp += s;
    }
    if (n1 > 0) memcpy(tmp, b1, n1 * s);
    memcpy(b, t, (n - n2) * s);
}

void qsort(void *base, size_t n, size_t size, compare_fn cmp) {
    if (n <= 1 || size == 0) return;
    if (n > SIZE_MAX / size) {
        fputs("ffconv: error: a sort of more elements than memory can hold\n", stderr);
        exit(1);
    }
    char *t = malloc(n * size);
    if (t == NULL) {
        fputs("ffconv: error: out of memory while sorting\n", stderr);
        exit(1);
    }
    msort_with_tmp(base, n, size, cmp, t);
    free(t);
}

/* ffconv: converts a font between TrueType outlines, CFF outlines and SVG fonts with FontForge 20230101's library
 * (P2 plan, fontconverter-web docs/audits/P2-FFCONV-PLAN-2026-11-17.md, P2-1 to P2-7).
 *
 * Contract (P2-3): exit 0 and exactly one JSON line on stdout; exit 1 and exactly one "ffconv: error: ..." line, the
 * last on stderr; exit 2 and "ffconv: usage error: ...", touching no file. One run per instance (P2-6).
 */
#define _XOPEN_SOURCE 700
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <fontforge-config.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <ffglib.h> /* GLib as FontForge includes it: its GList is renamed out of the way of FontForge's */
#include <iconv.h>
#include <libxml/xmlversion.h>
#include <zlib.h>

/* FontForge's library, as fontforgeexe/startnoui.c includes it, plus the calls of the script commands */
#include "encoding.h"
#include "fontforgevw.h"
#include "gfile.h"
#include "savefont.h"
#include "scripting.h"
#include "start.h"
#include "uiinterface.h"
#include "ustring.h"

#include "ffconv-build.h" /* FFCONV_PATCHES, FFCONV_PCRE2_VERSION: written by the build script */
#include "sniff.h"

#define FFCONV_VERSION "1.0.0"

enum { EXIT_OK = 0, EXIT_FAIL = 1, EXIT_USAGE = 2 };

/* FontForge's outputs are read whole for the result check (P2-5); anything larger fails closed. */
#define MAX_OUTPUT_BYTES ((size_t)512 * 1024 * 1024)

static int runs; /* P2-6: FontForge keeps global state and frees nothing, so an instance converts once */

/* fontconverter-web P3b (P3b plan, P3b-7): every failure carries one id from ERROR_IDS; main() prints it as the only
 * stdout line, {"ok":false,"v":1,"command":<command or null>,"error":"<id>"}; the message stays on stderr. */
static const char *const ERROR_IDS[] = {
    "usage", "io", "input-empty", "input-too-large", "not-a-font", "wrapped-input", "collection", "type1", "cff2",
    "lossy-table", "no-outlines", "sfnt-invalid", "read-failed", "cid-flatten-failed", "write-failed",
    "output-invalid", "glyph-map-unavailable", "glyph-map-invalid", "out-of-memory", "unexpected",
};
static const char *g_err_id = "unexpected";

static int usage_error(const char *fmt, ...) {
    va_list ap;
    g_err_id = "usage";
    va_start(ap, fmt);
    fputs("ffconv: usage error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    return EXIT_USAGE;
}

/* id NULL keeps the id the failing helper set (read_file, the sniff). */
static int fail(const char *id, const char *fmt, ...) {
    va_list ap;
    if (id != NULL) g_err_id = id;
    va_start(ap, fmt);
    fputs("ffconv: error: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    return EXIT_FAIL;
}

static const char HELP[] =
    "ffconv " FFCONV_VERSION ": FontForge " FONTFORGE_VERSION " as a font converter\n"
    "\n"
    "  ffconv convert [--allow-lossy] <input> <output.ttf|output.otf|output.svg>\n"
    "      input: a TrueType or CFF (OpenType) sfnt, or an SVG font. Refused: WOFF, WOFF2, EOT, collections,\n"
    "      Type 1, compressed files, CFF2, fonts without outlines, inputs over 32 MiB; fvar, COLR, CBDT, sbix and\n"
    "      SVG tables unless --allow-lossy. Exit 0 with one JSON line on stdout; 1 with one \"ffconv: error:\" line;\n"
    "      2 with one \"ffconv: usage error:\" line.\n"
    "  ffconv version     one JSON line: ffconv, FontForge, every component and the local patches\n"
    "  ffconv help        this text\n"
    "\n"
    "  test hooks: selftest-stderr, selftest-system, selftest-sort, selftest-sniff <input>,\n"
    "              selftest-check <file> <ttf|otf|svg>\n"
    "\n"
    "One run per instance. ffconv is GPL-3.0-or-later; see LICENSE and VENDORING.md.\n";

static int cmd_help(void) {
    fputs(HELP, stdout);
    return EXIT_OK;
}

static int cmd_version(void) {
    printf("{\"ffconv\":\"%s\",\"fontforge\":\"%s\",\"glib\":\"%d.%d.%d\",\"pcre2\":\"%s\",\"libxml2\":\"%s\","
           "\"libiconv\":\"%d.%d\",\"freetype\":\"%d.%d.%d\",\"zlib\":\"%s\",\"patches\":[%s]}\n",
           FFCONV_VERSION, FONTFORGE_VERSION, GLIB_MAJOR_VERSION, GLIB_MINOR_VERSION, GLIB_MICRO_VERSION,
           FFCONV_PCRE2_VERSION, LIBXML_DOTTED_VERSION, _LIBICONV_VERSION >> 8, _LIBICONV_VERSION & 0xff,
           FREETYPE_MAJOR, FREETYPE_MINOR, FREETYPE_PATCH, ZLIB_VERSION, FFCONV_PATCHES);
    return EXIT_OK;
}

/* N11: an unterminated stderr line must reach the caller through flushStderr(). */
static int cmd_selftest_stderr(void) {
    fputs("ffconv: selftest: unterminated", stderr);
    return EXIT_OK;
}

/* N11: qsort is src/stable-qsort.c's (glibc's merge-sort order): equal keys keep their order, and a comparator that
 * answers only 0 or 1 still sorts, as FontForge's SortBlues and its kind need. */
struct keyed {
    int key, index;
};

static int by_key(const void *a, const void *b) {
    const struct keyed *x = a, *y = b;
    return (x->key > y->key) - (x->key < y->key);
}

static int greater(const void *a, const void *b) {
    return *(const int *)a > *(const int *)b;
}

static int cmd_selftest_sort(void) {
    struct keyed ties[] = {{2, 0}, {1, 1}, {2, 2}, {1, 3}, {3, 4}, {2, 5}, {1, 6}};
    int boolean[] = {5, 3, 9, 1, 8, 2};
    qsort(ties, sizeof ties / sizeof ties[0], sizeof ties[0], by_key);
    qsort(boolean, sizeof boolean / sizeof boolean[0], sizeof boolean[0], greater);
    fputs("{\"ties\":[", stdout);
    for (size_t i = 0; i < sizeof ties / sizeof ties[0]; i++) printf("%s%d", i ? "," : "", ties[i].index);
    fputs("],\"boolean\":[", stdout);
    for (size_t i = 0; i < sizeof boolean / sizeof boolean[0]; i++) printf("%s%d", i ? "," : "", boolean[i]);
    puts("]}");
    return EXIT_OK;
}

/* N7: system() is src/no-subprocess.c's, which always fails with ENOSYS. */
static int cmd_selftest_system(void) {
    errno = 0;
    int r = system("true");
    int e = errno;
    printf("{\"system\":%d,\"enosys\":%s}\n", r, e == ENOSYS ? "true" : "false");
    return EXIT_OK;
}

/* Writes a reason into err for the caller to report; returns -1. */
static int reason(char *err, size_t errlen, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, errlen, fmt, ap);
    va_end(ap);
    return -1;
}

/* Reads a regular file whole. Its size comes from fstat before anything is read; over max (named by what) it is
 * refused unread. 0, or -1 with the reason in err. */
static int read_file(const char *path, size_t max, const char *what, unsigned char **buf, size_t *len, char *err,
                     size_t errlen) {
    *buf = NULL;
    *len = 0;
    int fd = open(path, O_RDONLY);
    g_err_id = "io";
    if (fd < 0) return reason(err, errlen, "cannot open the %s: %s", what, strerror(errno));
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
        close(fd);
        return reason(err, errlen, "the %s is not a regular file", what);
    }
    if ((unsigned long long)st.st_size > (unsigned long long)max) {
        close(fd);
        g_err_id = strcmp(what, "input") == 0 ? "input-too-large" : "output-invalid";
        return reason(err, errlen, "the %s is %lld bytes; ffconv reads at most %zu MiB", what,
                        (long long)st.st_size, max / (1024 * 1024));
    }
    size_t size = (size_t)st.st_size;
    unsigned char *b = malloc(size > 0 ? size : 1);
    if (b == NULL) {
        close(fd);
        g_err_id = "out-of-memory";
        return reason(err, errlen, "out of memory reading the %s", what);
    }
    size_t got = 0;
    while (got < size) {
        ssize_t r = read(fd, b + got, size - got);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) {
            free(b);
            close(fd);
            return reason(err, errlen, "cannot read the %s: %s", what, r < 0 ? strerror(errno) : "it shrank");
        }
        got += (size_t)r;
    }
    close(fd);
    *buf = b;
    *len = size;
    return 0;
}

/* Reads and checks the input (P2-4). 0 with *in filled, or the exit code of the failure, already reported. */
static int check_input(const char *path, int allow_lossy, ffc_input *in) {
    unsigned char *b;
    size_t len;
    char err[FFC_ERR_BYTES];
    if (read_file(path, FFC_MAX_INPUT_BYTES, "input", &b, &len, err, sizeof err) != 0) return fail(NULL, "%s", err);
    int rc = ffc_sniff_input(b, len, allow_lossy, in, err, sizeof err);
    free(b);
    return rc == 0 ? EXIT_OK : fail(ffc_error_id(), "%s", err);
}

static void print_input(const ffc_input *in) {
    if (in->flavor == NULL) printf("{\"kind\":\"%s\",\"flavor\":null,\"numGlyphs\":null}", in->kind);
    else printf("{\"kind\":\"%s\",\"flavor\":\"%s\",\"numGlyphs\":%ld}", in->kind, in->flavor, in->num_glyphs);
}

/* N6 and the sweep: the input check alone, without FontForge. */
static int cmd_selftest_sniff(const char *path) {
    ffc_input in;
    int rc = check_input(path, 0, &in);
    if (rc != EXIT_OK) return rc;
    print_input(&in);
    putchar('\n');
    return EXIT_OK;
}

/* N6: the result check alone. */
static int cmd_selftest_check(const char *path, const char *ext) {
    if (strcmp(ext, "ttf") != 0 && strcmp(ext, "otf") != 0 && strcmp(ext, "svg") != 0)
        return usage_error("selftest-check takes ttf, otf or svg");
    unsigned char *b;
    size_t len;
    char err[FFC_ERR_BYTES];
    if (read_file(path, MAX_OUTPUT_BYTES, "file", &b, &len, err, sizeof err) != 0) return fail(NULL, "%s", err);
    int rc = ffc_check_output(b, len, ext, err, sizeof err);
    free(b);
    if (rc != 0) return fail(ffc_error_id(), "%s", err);
    puts("{\"ok\":true}");
    return EXIT_OK;
}

/* The output's extension, which picks FontForge's writer: lower-case .ttf, .otf or .svg, or NULL. */
static const char *output_ext(const char *path) {
    const char *dot = strrchr(path, '.');
    const char *slash = strrchr(path, '/');
    if (dot == NULL || (slash != NULL && dot < slash)) return NULL;
    if (strcmp(dot, ".ttf") == 0) return "ttf";
    if (strcmp(dot, ".otf") == 0) return "otf";
    if (strcmp(dot, ".svg") == 0) return "svg";
    return NULL;
}

static int same_file(const char *a, const char *b) {
    struct stat sa, sb;
    return stat(a, &sa) == 0 && stat(b, &sb) == 0 && sa.st_dev == sb.st_dev && sa.st_ino == sb.st_ino;
}

/* ---- FontForge (P2-2) ---- */

static const char *prog_name = "ffconv";

/* FontForge's own start-up for a script run: fontforge_main (fontforgeexe/startnoui.c) up to CheckIsScript, then
 * ProcessNativeScript's two flags and verbosity (fontforge/scripting.c:10315-10318). No preferences are read. */
static void fontforge_start(void) {
    FindProgRoot(prog_name);
    InitSimpleStuff();
    bind_textdomain_codeset("FontForge", "UTF-8");
    bindtextdomain("FontForge", getLocaleDir());
    textdomain("FontForge");
    if (default_encoding == NULL) default_encoding = FindOrMakeEncoding("ISO8859-1");
    if (default_encoding == NULL) default_encoding = &custom; /* in case iconv is broken */
    no_windowing_ui = true;
    running_script = true;
    ff_VerboseCheck();
}

/* `Open($1); if ($cidfontname != "") CIDFlatten(); endif; Generate($2)` without the interpreter: bOpen, bCIDFlatten
 * and bGenerate (fontforge/scripting.c:1784-1812, 6641-6647, 1915-1955). */
/* The glyph map (P3b plan, P3b-9): for every glyph FontForge read, its id in the source (orig_pos: the glyph id, or
 * the CID of a CID-keyed font) and in the output FontForge wrote (ttf_glyph, set while writing a ttf or otf). */
typedef struct {
    int keyed_by_cid;
    long source;  /* entries: the source's glyph count, or the highest CID + 1 */
    int *map;     /* map[source id] = output id, or -1 */
    int max_out;  /* the highest output id met */
} glyph_map;

static int build_glyph_map(SplineFont *sf, int cid, long num_glyphs, glyph_map *gm) {
    gm->keyed_by_cid = cid;
    gm->max_out = -1;
    long n = cid ? 0 : num_glyphs;
    if (cid) {
        for (int i = 0; i < sf->glyphcnt; i++)
            if (sf->glyphs[i] != NULL && sf->glyphs[i]->orig_pos >= n) n = sf->glyphs[i]->orig_pos + 1;
    }
    if (n <= 0 || n > 1000000) return fail("glyph-map-invalid", "the glyph map would have %ld entries", n);
    gm->source = n;
    gm->map = malloc((size_t)n * sizeof(int));
    if (gm->map == NULL) return fail("out-of-memory", "out of memory for the glyph map");
    for (long i = 0; i < n; i++) gm->map[i] = -1;
    for (int i = 0; i < sf->glyphcnt; i++) {
        SplineChar *sc = sf->glyphs[i];
        if (sc == NULL || sc->ttf_glyph < 0) continue;
        if (sc->orig_pos < 0 || sc->orig_pos >= n)
            return fail("glyph-map-invalid", "glyph %s has source id %d outside 0 to %ld", sc->name, sc->orig_pos,
                        n - 1);
        if (gm->map[sc->orig_pos] != -1)
            return fail("glyph-map-invalid", "two glyphs come from source id %d", sc->orig_pos);
        gm->map[sc->orig_pos] = sc->ttf_glyph;
        if (sc->ttf_glyph > gm->max_out) gm->max_out = sc->ttf_glyph;
    }
    return EXIT_OK;
}

/* Checks the map against the output FontForge wrote (its glyph count from maxp) and writes it to path. */
static int write_glyph_map(const glyph_map *gm, long out_glyphs, const char *path) {
    if (gm->max_out >= out_glyphs)
        return fail("glyph-map-invalid", "the glyph map names output glyph %d of %ld", gm->max_out, out_glyphs);
    if (gm->map[0] != 0) return fail("glyph-map-invalid", ".notdef does not stay glyph 0");
    unsigned char *seen = calloc((size_t)out_glyphs, 1);
    if (seen == NULL) return fail("out-of-memory", "out of memory for the glyph map");
    for (long i = 0; i < gm->source; i++) {
        int o = gm->map[i];
        if (o < 0) continue;
        if (seen[o]) {
            free(seen);
            return fail("glyph-map-invalid", "output glyph %d comes from two source glyphs", o);
        }
        seen[o] = 1;
    }
    free(seen);
    FILE *f = fopen(path, "w");
    if (f == NULL) return fail("io", "cannot create the glyph map: %s", strerror(errno));
    fprintf(f, "{\"v\":1,\"keyedBy\":\"%s\",\"sourceGlyphs\":%ld,\"outputGlyphs\":%ld,\"map\":[",
            gm->keyed_by_cid ? "cid" : "gid", gm->source, out_glyphs);
    for (long i = 0; i < gm->source; i++) fprintf(f, i ? ",%d" : "%d", gm->map[i]);
    fputs("]}\n", f);
    if (fclose(f) != 0) {
        unlink(path);
        return fail("io", "cannot write the glyph map");
    }
    return EXIT_OK;
}

static int fontforge_convert(const char *in_path, const char *out_path, const char *ext, int *cid_flattened,
                             const ffc_input *in, glyph_map *gm) {
    fontforge_start();
    char *loc = utf82def_copy(in_path);
    SplineFont *sf = LoadSplineFont(loc, 0);
    free(loc);
    if (sf == NULL) return fail("read-failed", "FontForge could not read the input");
    if (sf->fv == NULL) FVAppend(_FontViewCreate(sf));
    FontViewBase *fv = sf->fv;
    *cid_flattened = 0;
    if (fv->sf->cidmaster != NULL) {
        SplineFont *cidmaster = fv->cidmaster;
        if (cidmaster == NULL) return fail("cid-flatten-failed", "FontForge's font view has no CID master to flatten");
        SFFlatten(&cidmaster);
        *cid_flattened = 1;
    }
    sf = fv->sf; /* flattening replaced the view's font and freed the CID master (fontforge/encoding.c:1417-1494) */
    char *loc_out = utf82def_copy(out_path);
    int ok = GenerateScript(sf, loc_out, "", -1, -1, NULL, NULL, fv->normal == NULL ? fv->map : fv->normal, NULL,
                            ly_fore);
    free(loc_out);
    if (!ok) return fail("write-failed", "FontForge could not write the .%s output", ext);
    return gm != NULL ? build_glyph_map(sf, *cid_flattened, in->num_glyphs, gm) : EXIT_OK;
}

/* ---- the private folder (P2-3) ---- */

static char *join(const char *dir, const char *name) {
    size_t n = strlen(dir) + strlen(name) + 2;
    char *p = malloc(n);
    if (p != NULL) snprintf(p, n, "%s/%s", dir, name);
    return p;
}

/* The folder part of path ("." when there is none). */
static char *dir_of(const char *path) {
    const char *slash = strrchr(path, '/');
    if (slash == NULL) return strdup(".");
    if (slash == path) return strdup("/");
    size_t n = (size_t)(slash - path);
    char *d = malloc(n + 1);
    if (d != NULL) {
        memcpy(d, path, n);
        d[n] = '\0';
    }
    return d;
}

/* Empties and removes the private folder: it is ffconv's own (mkdtemp), so everything in it goes. */
static void remove_private_folder(const char *dir) {
    DIR *d = opendir(dir);
    if (d != NULL) {
        struct dirent *e;
        while ((e = readdir(d)) != NULL) {
            if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
            char *p = join(dir, e->d_name);
            if (p != NULL) unlink(p);
            free(p);
        }
        closedir(d);
    }
    rmdir(dir);
}

/* FontForge in a private folder next to the output: it reads a symlink named by the detected kind and writes
 * output.<ext>; the result is checked, then renamed onto the output path. On any failure nothing exists there. */
static int convert_in_private_folder(const char *in_path, const char *out_path, const char *ext,
                                     const ffc_input *in, const char *map_path) {
    char *out_dir = dir_of(out_path);
    char *tmpl = out_dir != NULL ? join(out_dir, ".ffconv-XXXXXX") : NULL;
    free(out_dir);
    if (tmpl == NULL) return fail("out-of-memory", "out of memory");
    if (mkdtemp(tmpl) == NULL) {
        int e = errno;
        free(tmpl);
        return fail("io", "cannot create a private folder next to the output: %s", strerror(e));
    }
    glyph_map gm = {0, 0, NULL, -1};
    ffc_input written;
    char *map_tmp = map_path != NULL ? join(tmpl, "glyph-map.json") : NULL;
    char in_name[16], out_name[16];
    snprintf(in_name, sizeof in_name, "input.%s", in->ext);
    snprintf(out_name, sizeof out_name, "output.%s", ext);
    char *link_path = join(tmpl, in_name);
    char *ff_out = join(tmpl, out_name);
    char *real_in = realpath(in_path, NULL);
    unsigned char *b = NULL;
    size_t len = 0;
    int cid = 0, rc;
    char err[FFC_ERR_BYTES];
    struct stat si, so;
    if (link_path == NULL || ff_out == NULL || real_in == NULL || (map_path != NULL && map_tmp == NULL))
        rc = fail("io", "cannot resolve the input path");
    else if (symlink(real_in, link_path) != 0) rc = fail("io", "cannot link the input: %s", strerror(errno));
    else if ((rc = fontforge_convert(link_path, ff_out, ext, &cid, in, map_path != NULL ? &gm : NULL)) != EXIT_OK) {
        /* reported */
    } else if (read_file(ff_out, MAX_OUTPUT_BYTES, "output", &b, &len, err, sizeof err) != 0) rc = fail(NULL, "%s", err);
    else if (ffc_check_output(b, len, ext, err, sizeof err) != 0) rc = fail(ffc_error_id(), "%s", err);
    else if (stat(ff_out, &so) != 0 || stat(in_path, &si) != 0 || (si.st_dev == so.st_dev && si.st_ino == so.st_ino))
        rc = fail("output-invalid", "FontForge's output cannot be told apart from the input");
    else if (map_path != NULL && ffc_sniff_input(b, len, 1, &written, err, sizeof err) != 0)
        rc = fail("glyph-map-invalid", "the output's glyph count cannot be read: %s", err);
    else if (map_path != NULL && (rc = write_glyph_map(&gm, written.num_glyphs, map_tmp)) != EXIT_OK) {
        /* reported */
    } else if (rename(ff_out, out_path) != 0) rc = fail("io", "cannot move the output into place: %s", strerror(errno));
    else if (map_path != NULL && rename(map_tmp, map_path) != 0) {
        rc = fail("io", "cannot move the glyph map into place: %s", strerror(errno));
        unlink(out_path); /* a failed run leaves no output (P2-3) */
    } else rc = EXIT_OK;
    free(b);
    free(gm.map);
    free(map_tmp);
    remove_private_folder(tmpl);
    free(tmpl);
    free(link_path);
    free(ff_out);
    free(real_in);
    if (rc != EXIT_OK) return rc;
    fputs("{\"ok\":true,\"input\":", stdout);
    print_input(in);
    printf(",\"output\":{\"format\":\"%s\",\"bytes\":%zu},\"cidFlattened\":%s}\n", ext, len,
           cid ? "true" : "false");
    return EXIT_OK;
}

/* ---- commands ---- */

static int cmd_convert(int argc, char **argv) {
    int allow_lossy = 0, options_done = 0, n = 0;
    const char *paths[2] = {NULL, NULL};
    const char *map_path = NULL;
    for (int i = 0; i < argc; i++) {
        const char *a = argv[i];
        if (!options_done && strcmp(a, "--") == 0) {
            options_done = 1;
        } else if (!options_done && strcmp(a, "--glyph-map") == 0) {
            if (i + 1 >= argc) return usage_error("--glyph-map needs a path");
            map_path = argv[++i];
        } else if (!options_done && strncmp(a, "--", 2) == 0) {
            if (strcmp(a, "--allow-lossy") != 0) return usage_error("unknown option for convert: %s", a);
            allow_lossy = 1;
        } else if (n == 2) {
            return usage_error("convert takes one input and one output path");
        } else {
            paths[n++] = a;
        }
    }
    if (n != 2) return usage_error("convert needs an input and an output path");
    const char *ext = output_ext(paths[1]);
    if (ext == NULL) return usage_error("the output name must end in .ttf, .otf or .svg (lower case)");
    if (same_file(paths[0], paths[1])) return usage_error("the output path names the input file");
    if (map_path != NULL && strcmp(ext, "svg") == 0)
        return usage_error("--glyph-map applies to a .ttf or .otf output (FontForge numbers no SVG glyphs)");
    if (map_path != NULL && (same_file(map_path, paths[0]) || strcmp(map_path, paths[1]) == 0))
        return usage_error("the glyph map path names the input or the output");
    if (unlink(paths[1]) != 0 && errno != ENOENT)
        return fail("io", "cannot remove the existing output: %s", strerror(errno));
    if (map_path != NULL && unlink(map_path) != 0 && errno != ENOENT)
        return fail("io", "cannot remove the existing glyph map: %s", strerror(errno));
    ffc_input in;
    int rc = check_input(paths[0], allow_lossy, &in);
    if (rc != EXIT_OK) return rc;
    if (map_path != NULL && in.num_glyphs <= 0)
        return fail("glyph-map-unavailable", "a glyph map needs an sfnt input");
    return convert_in_private_folder(paths[0], paths[1], ext, &in, map_path);
}

/* Test hook (wasm): 1 MiB blocks until the 1 GiB ceiling; with ABORTING_MALLOC=1 the runtime aborts as "OOM", which
 * post.js records (lastAbort). Native builds have no ceiling, so the hook refuses there. */
#ifdef __EMSCRIPTEN__
/* Every block stays reachable through this volatile chain: without it the compiler may drop the unused malloc and
 * memset and leave an empty endless loop (seen: the first build spun at 100 % CPU with no memory growth). */
static void *volatile oom_chain;
#endif

static int cmd_selftest_oom(void) {
#ifdef __EMSCRIPTEN__
    for (;;) {
        void **p = malloc(1u << 20);
        if (p == NULL) return fail("out-of-memory", "selftest-oom: malloc returned NULL (ABORTING_MALLOC is off)");
        memset(p, 1, 1u << 20);
        *p = oom_chain;
        oom_chain = p;
    }
#else
    return usage_error("selftest-oom applies to the wasm build only");
#endif
}

static int cmd_error_ids(void) {
    fputs("{\"ok\":true,\"v\":1,\"command\":\"error-ids\",\"ids\":[", stdout);
    for (size_t i = 0; i < sizeof ERROR_IDS / sizeof ERROR_IDS[0]; i++) printf(i ? ",\"%s\"" : "\"%s\"", ERROR_IDS[i]);
    puts("]}");
    return EXIT_OK;
}

static const char *const COMMANDS[] = {"convert", "version", "help", "error-ids", "selftest-oom", "selftest-stderr",
                                       "selftest-system", "selftest-sort", "selftest-sniff", "selftest-check"};

static int dispatch(int argc, char **argv, const char **command) {
    if (runs++ > 0) return usage_error("one conversion per instance: create a new instance for the next run");
    if (argc < 2) return usage_error("no command (ffconv help lists them)");
    if (argv[0] != NULL && argv[0][0] != '\0') prog_name = argv[0];
    const char *cmd = argv[1];
    for (size_t i = 0; i < sizeof COMMANDS / sizeof COMMANDS[0]; i++)
        if (strcmp(cmd, COMMANDS[i]) == 0) *command = COMMANDS[i];
    int rc;
    if (strcmp(cmd, "convert") == 0) rc = cmd_convert(argc - 2, argv + 2);
    else if (strcmp(cmd, "error-ids") == 0 && argc == 2) rc = cmd_error_ids();
    else if (strcmp(cmd, "selftest-oom") == 0 && argc == 2) rc = cmd_selftest_oom();
    else if (strcmp(cmd, "version") == 0 && argc == 2) rc = cmd_version();
    else if (strcmp(cmd, "help") == 0 && argc == 2) rc = cmd_help();
    else if (strcmp(cmd, "selftest-stderr") == 0 && argc == 2) rc = cmd_selftest_stderr();
    else if (strcmp(cmd, "selftest-system") == 0 && argc == 2) rc = cmd_selftest_system();
    else if (strcmp(cmd, "selftest-sort") == 0 && argc == 2) rc = cmd_selftest_sort();
    else if (strcmp(cmd, "selftest-sniff") == 0 && argc == 3) rc = cmd_selftest_sniff(argv[2]);
    else if (strcmp(cmd, "selftest-check") == 0 && argc == 4) rc = cmd_selftest_check(argv[2], argv[3]);
    else if (strcmp(cmd, "version") == 0 || strcmp(cmd, "help") == 0 || strcmp(cmd, "error-ids") == 0 ||
             strncmp(cmd, "selftest-", 9) == 0)
        rc = usage_error("wrong number of arguments for %s", cmd);
    else rc = usage_error("unknown command (ffconv help lists them)");
    return rc;
}

int main(int argc, char **argv) {
    const char *command = NULL;
    int rc = dispatch(argc, argv, &command);
    if (rc == EXIT_FAIL || rc == EXIT_USAGE) {
        if (command != NULL) printf("{\"ok\":false,\"v\":1,\"command\":\"%s\",\"error\":\"%s\"}\n", command, g_err_id);
        else printf("{\"ok\":false,\"v\":1,\"command\":null,\"error\":\"%s\"}\n", g_err_id);
    }
    fflush(stdout);
    return rc;
}

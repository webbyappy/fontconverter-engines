/* ffconv's input check (P2-4) and result check (P2-5). Every read is bounds-checked with 64-bit arithmetic: the
 * input is untrusted and is read before FontForge ever sees it. */
#include "sniff.h"

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const char *g_error_id = "unexpected"; /* fontforge-wasm: P3b failure ids (sniff.h) */

const char *ffc_error_id(void) { return g_error_id; }

static int fail(char *err, size_t errlen, const char *id, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, errlen, fmt, ap);
    va_end(ap);
    g_error_id = id;
    return -1;
}

static uint32_t be32(const unsigned char *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static uint16_t be16(const unsigned char *p) {
    return (uint16_t)(((unsigned)p[0] << 8) | (unsigned)p[1]);
}

static int starts(const unsigned char *b, size_t len, const char *magic, size_t n) {
    return len >= n && memcmp(b, magic, n) == 0;
}

/* A table tag for a message: printable ASCII kept, anything else shown as '?'. */
static void tag_text(const unsigned char *p, char out[5]) {
    for (int i = 0; i < 4; i++) out[i] = (p[i] >= 0x20 && p[i] < 0x7f) ? (char)p[i] : '?';
    out[4] = '\0';
}

/* The sfnt table directory: 1 to 4,096 records, each inside the file. Sets *num on success. */
static int read_directory(const unsigned char *b, size_t len, unsigned *num, char *err, size_t errlen) {
    if (len < 12) return fail(err, errlen, "sfnt-invalid", "truncated: the sfnt header needs 12 bytes, the file has %zu", len);
    unsigned n = be16(b + 4);
    if (n == 0) return fail(err, errlen, "sfnt-invalid", "the sfnt table directory lists no tables");
    if (n > FFC_MAX_TABLES) return fail(err, errlen, "sfnt-invalid", "the sfnt table directory lists %u tables (at most %u)", n,
                                        FFC_MAX_TABLES);
    uint64_t need = 12 + 16 * (uint64_t)n;
    if (need > len) return fail(err, errlen, "sfnt-invalid", "truncated: the table directory needs %llu bytes, the file has %zu",
                                (unsigned long long)need, len);
    for (unsigned i = 0; i < n; i++) {
        const unsigned char *rec = b + 12 + 16 * (size_t)i;
        if ((uint64_t)be32(rec + 8) + be32(rec + 12) > len) {
            char t[5];
            tag_text(rec, t);
            return fail(err, errlen, "sfnt-invalid", "truncated: table '%s' runs past the end of the file", t);
        }
    }
    *num = n;
    return 0;
}

/* The table tagged tag (4 bytes), or NULL; read_directory must have passed. */
static const unsigned char *find_table(const unsigned char *b, unsigned n, const char *tag, uint32_t *length) {
    for (unsigned i = 0; i < n; i++) {
        const unsigned char *rec = b + 12 + 16 * (size_t)i;
        if (memcmp(rec, tag, 4) == 0) {
            *length = be32(rec + 12);
            return b + be32(rec + 8);
        }
    }
    return NULL;
}

static int has_table(const unsigned char *b, unsigned n, const char *tag) {
    uint32_t length;
    return find_table(b, n, tag, &length) != NULL;
}

static uint32_t le32(const unsigned char *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

/* An EOT header: its size field equals the file's length, a known version, and the magic 0x504C at bytes 34-35. (The
 * magic alone matched an SVG font whose bytes 34-35 read "LP".) */
static int is_eot(const unsigned char *b, size_t len) {
    if (len < 36 || b[34] != 0x4C || b[35] != 0x50 || le32(b) != len) return 0;
    uint32_t version = le32(b + 8);
    return version == 0x00010000 || version == 0x00020001 || version == 0x00020002;
}

/* After an optional UTF-8 byte-order mark and white space: the offset of the first other byte. */
static size_t skip_bom_and_space(const unsigned char *b, size_t len) {
    size_t i = starts(b, len, "\xEF\xBB\xBF", 3) ? 3 : 0;
    while (i < len && (b[i] == ' ' || b[i] == '\t' || b[i] == '\r' || b[i] == '\n')) i++;
    return i;
}

/* Whether b holds `<font` as an element name (followed by white space, '>' or '/'; not `<font-face`). */
static int has_font_element(const unsigned char *b, size_t len) {
    for (size_t i = 0; i + 6 <= len; i++) {
        if (memcmp(b + i, "<font", 5) == 0) {
            unsigned char c = b[i + 5];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '>' || c == '/') return 1;
        }
    }
    return 0;
}

static int contains(const unsigned char *b, size_t len, const char *s) {
    size_t n = strlen(s);
    for (size_t i = 0; i + n <= len; i++)
        if (memcmp(b + i, s, n) == 0) return 1;
    return 0;
}

/* Tables FontForge reads without what they carry: refused unless the caller accepts the loss (P2-4). */
static const struct {
    const char *tag;
    const char *what;
} LOSSY[] = {
    {"fvar", "an fvar table (a variable font): FontForge would keep only the default instance"},
    {"COLR", "a COLR table (colour layers): FontForge would drop the colours"},
    {"CBDT", "a CBDT table (colour bitmaps): FontForge would drop them"},
    {"sbix", "an sbix table (bitmap glyphs): FontForge would drop them"},
    {"SVG ", "an SVG table (SVG glyphs): FontForge would drop them"},
};

static int sniff_sfnt(const unsigned char *b, size_t len, int allow_lossy, ffc_input *in, char *err,
                      size_t errlen) {
    unsigned n;
    if (read_directory(b, len, &n, err, errlen) != 0) return -1;
    uint32_t maxp_len = 0;
    const unsigned char *maxp = find_table(b, n, "maxp", &maxp_len);
    if (maxp == NULL) return fail(err, errlen, "sfnt-invalid", "no maxp table");
    if (maxp_len < 6) return fail(err, errlen, "sfnt-invalid", "the maxp table is %u bytes, too short (at least 6)", maxp_len);
    if (has_table(b, n, "CFF2")) return fail(err, errlen, "cff2", "a CFF2 font: FontForge 20230101 cannot read CFF2 outlines");
    if (!allow_lossy) {
        for (size_t i = 0; i < sizeof LOSSY / sizeof LOSSY[0]; i++)
            if (has_table(b, n, LOSSY[i].tag)) return fail(err, errlen, "lossy-table", "%s (--allow-lossy accepts that)", LOSSY[i].what);
    }
    if (has_table(b, n, "CFF ")) {
        in->flavor = "cff";
        in->ext = "otf";
    } else if (has_table(b, n, "glyf") && has_table(b, n, "loca")) {
        in->flavor = "truetype";
        in->ext = "ttf";
    } else {
        return fail(err, errlen, "no-outlines", "no outlines FontForge can convert (no glyf and loca, no CFF table)");
    }
    in->kind = "sfnt";
    in->num_glyphs = be16(maxp + 4);
    return 0;
}

int ffc_sniff_input(const unsigned char *b, size_t len, int allow_lossy, ffc_input *in, char *err, size_t errlen) {
    if (len == 0) return fail(err, errlen, "input-empty", "the input is empty");
    if (len > FFC_MAX_INPUT_BYTES)
        return fail(err, errlen, "input-too-large", "the input is %zu bytes; ffconv reads at most 32 MiB", len);
    if (starts(b, len, "\x00\x01\x00\x00", 4) || starts(b, len, "true", 4) || starts(b, len, "OTTO", 4))
        return sniff_sfnt(b, len, allow_lossy, in, err, errlen);
    if (starts(b, len, "wOFF", 4)) return fail(err, errlen, "wrapped-input", "a WOFF file: ffconv reads TrueType, CFF and SVG fonts");
    if (starts(b, len, "wOF2", 4)) return fail(err, errlen, "wrapped-input", "a WOFF2 file: ffconv reads TrueType, CFF and SVG fonts");
    if (starts(b, len, "ttcf", 4)) return fail(err, errlen, "collection", "a font collection (TTC): ffconv converts single fonts");
    if (starts(b, len, "\x1f\x8b", 2)) return fail(err, errlen, "not-a-font", "gzip-compressed data, not a font");
    if (starts(b, len, "PK\x03\x04", 4) || starts(b, len, "PK\x05\x06", 4))
        return fail(err, errlen, "not-a-font", "a zip archive, not a font");
    if (starts(b, len, "%!PS-AdobeFont", 14) || starts(b, len, "%!FontType1", 11) ||
        starts(b, len, "\x80\x01", 2) || starts(b, len, "typ1", 4))
        return fail(err, errlen, "type1", "a Type 1 font: ffconv reads TrueType, CFF and SVG fonts");
    if (is_eot(b, len)) return fail(err, errlen, "wrapped-input", "an EOT file: ffconv reads TrueType, CFF and SVG fonts");
    size_t i = skip_bom_and_space(b, len);
    if (i < len && b[i] == '<') {
        if (!has_font_element(b + i, len - i)) return fail(err, errlen, "not-a-font", "an XML file without a <font> element");
        in->kind = "svg";
        in->flavor = NULL;
        in->num_glyphs = -1;
        in->ext = "svg";
        return 0;
    }
    return fail(err, errlen, "not-a-font", "not a font ffconv converts (unknown format)");
}

/* ---- The CFF of an .otf output: a bounded structural check (fontconverter-web P3b) ----
 * Every INDEX inside the table, and no program -- a charstring, a global subroutine, a local subroutine of the font
 * or of any FD -- longer than the Type 2 limit of 65,535 bytes (Adobe TN 5177, appendix B). FontForge writes longer
 * charstrings for very complex glyphs (114,947 bytes in Noto-COLRv1; production's FontForge too); OTS refuses such a
 * font, and with it Chromium's and Firefox's font loaders. This is a length and bounds check, not a full CFF
 * validation (stack depth, hint counts and subroutine nesting are not executed). */
#define FFC_MAX_PROGRAM 65535u

typedef struct {
    size_t start, end; /* the INDEX's bytes */
} cff_index;

/* Reads the INDEX at `at`; with `programs`, also refuses any item longer than FFC_MAX_PROGRAM. 0 or -1. */
static int cff_read_index(const unsigned char *c, size_t len, size_t at, int programs, const char *what,
                          cff_index *x, char *err, size_t errlen) {
    if (at + 2 > len) return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s INDEX lies past the table", what);
    unsigned count = be16(c + at);
    x->start = at;
    if (count == 0) {
        x->end = at + 2;
        return 0;
    }
    if (at + 3 > len) return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s INDEX is cut", what);
    unsigned size = c[at + 2];
    if (size < 1 || size > 4) return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s INDEX has offSize %u", what, size);
    uint64_t offsets = at + 3, data = offsets + (uint64_t)(count + 1) * size - 1;
    if (offsets + (uint64_t)(count + 1) * size > len)
        return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s INDEX's offsets run past the table", what);
    uint64_t prev = 0;
    for (unsigned i = 0; i <= count; i++) {
        uint64_t v = 0;
        for (unsigned k = 0; k < size; k++) v = (v << 8) | c[offsets + (uint64_t)i * size + k];
        if (v < 1 || data + v > len || (i > 0 && v < prev))
            return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s INDEX's offset %u is out of bounds", what, i);
        if (programs && i > 0 && v - prev > FFC_MAX_PROGRAM)
            return fail(err, errlen, "output-invalid",
                        "FontForge's CFF: %s %u is %llu bytes, over the Type 2 limit of 65,535", what, i - 1,
                        (unsigned long long)(v - prev));
        prev = v;
    }
    x->end = (size_t)(data + prev);
    return 0;
}

/* The integer operand ending at a DICT operator (only integers are read; a real number counts as 0). */
typedef struct {
    int op;
    long long ops[4];
    int n;
} cff_entry;

/* Calls back for each operator of the DICT in [from, to). -1 on a damaged DICT. */
static int cff_dict(const unsigned char *c, size_t from, size_t to, cff_entry *out, int max, int *count) {
    long long stack[48];
    int depth = 0, n = 0;
    size_t p = from;
    while (p < to) {
        unsigned b0 = c[p];
        if (b0 <= 21) {
            int op = (int)b0;
            p++;
            if (b0 == 12) {
                if (p >= to) return -1;
                op = 1200 + c[p++];
            }
            if (n < max) {
                out[n].op = op;
                out[n].n = depth < 4 ? depth : 4;
                for (int k = 0; k < out[n].n; k++) out[n].ops[k] = stack[depth - out[n].n + k];
                n++;
            }
            depth = 0;
            continue;
        }
        long long v = 0;
        if (b0 == 28) {
            if (p + 3 > to) return -1;
            v = (int16_t)be16(c + p + 1);
            p += 3;
        } else if (b0 == 29) {
            if (p + 5 > to) return -1;
            v = (int32_t)be32(c + p + 1);
            p += 5;
        } else if (b0 == 30) {
            p++;
            while (p < to && (c[p] & 0x0f) != 0x0f && (c[p] >> 4) != 0x0f) p++;
            if (p >= to) return -1;
            p++;
        } else if (b0 >= 32 && b0 <= 246) {
            v = (long long)b0 - 139;
            p++;
        } else if (b0 >= 247 && b0 <= 254) {
            if (p + 2 > to) return -1;
            v = b0 <= 250 ? (long long)(b0 - 247) * 256 + c[p + 1] + 108 : -(long long)(b0 - 251) * 256 - c[p + 1] - 108;
            p += 2;
        } else {
            return -1;
        }
        if (depth < 48) stack[depth++] = v;
        else return -1;
    }
    *count = n;
    return 0;
}

/* A Private DICT (size, offset) and its local Subrs. */
static int cff_private(const unsigned char *c, size_t len, long long size, long long off, const char *what, char *err,
                       size_t errlen) {
    if (size == 0) return 0;
    if (size < 0 || off < 0 || (uint64_t)off + (uint64_t)size > len)
        return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s Private DICT lies past the table", what);
    cff_entry e[64];
    int n;
    if (cff_dict(c, (size_t)off, (size_t)(off + size), e, 64, &n) != 0)
        return fail(err, errlen, "output-invalid", "FontForge's CFF: the %s Private DICT is damaged", what);
    for (int i = 0; i < n; i++) {
        if (e[i].op == 19 && e[i].n >= 1) {
            cff_index subrs;
            if (cff_read_index(c, len, (size_t)(off + e[i].ops[e[i].n - 1]), 1, "local subroutine", &subrs, err, errlen) != 0)
                return -1;
        }
    }
    return 0;
}

static int cff_check(const unsigned char *c, size_t len, char *err, size_t errlen) {
    if (len < 4 || c[0] != 1) return fail(err, errlen, "output-invalid", "FontForge's CFF has no CFF 1 header");
    cff_index names, top, strings, gsubrs;
    if (cff_read_index(c, len, c[2], 0, "Name", &names, err, errlen) != 0 ||
        cff_read_index(c, len, names.end, 0, "Top DICT", &top, err, errlen) != 0 ||
        cff_read_index(c, len, top.end, 0, "String", &strings, err, errlen) != 0 ||
        cff_read_index(c, len, strings.end, 1, "global subroutine", &gsubrs, err, errlen) != 0)
        return -1;
    if (be16(c + top.start) != 1) return fail(err, errlen, "output-invalid", "FontForge's CFF holds %u fonts", be16(c + top.start));
    unsigned size = c[top.start + 2];
    size_t data = top.start + 3 + 2 * (size_t)size - 1;
    uint64_t a = 0, b = 0;
    for (unsigned k = 0; k < size; k++) {
        a = (a << 8) | c[top.start + 3 + k];
        b = (b << 8) | c[top.start + 3 + size + k];
    }
    cff_entry e[64];
    int n;
    if (cff_dict(c, data + a, data + b, e, 64, &n) != 0) return fail(err, errlen, "output-invalid", "FontForge's CFF Top DICT is damaged");
    int charstrings = 0;
    for (int i = 0; i < n; i++) {
        if (e[i].n < 1) continue;
        long long last = e[i].ops[e[i].n - 1];
        if (e[i].op == 17) {
            cff_index cs;
            if (last < 0 || cff_read_index(c, len, (size_t)last, 1, "charstring", &cs, err, errlen) != 0) return -1;
            charstrings = 1;
        } else if (e[i].op == 18 && e[i].n >= 2) {
            if (cff_private(c, len, e[i].ops[e[i].n - 2], last, "top", err, errlen) != 0) return -1;
        } else if (e[i].op == 1236) {
            cff_index fds;
            if (last < 0 || cff_read_index(c, len, (size_t)last, 0, "FDArray", &fds, err, errlen) != 0) return -1;
            unsigned count = be16(c + fds.start);
            if (count > 0) {
                unsigned fsz = c[fds.start + 2];
                size_t fdata = fds.start + 3 + (size_t)(count + 1) * fsz - 1;
                for (unsigned f = 0; f < count; f++) {
                    uint64_t x = 0, y = 0;
                    for (unsigned k = 0; k < fsz; k++) {
                        x = (x << 8) | c[fds.start + 3 + (size_t)f * fsz + k];
                        y = (y << 8) | c[fds.start + 3 + (size_t)(f + 1) * fsz + k];
                    }
                    cff_entry fe[16];
                    int fn;
                    if (cff_dict(c, fdata + x, fdata + y, fe, 16, &fn) != 0)
                        return fail(err, errlen, "output-invalid", "FontForge's CFF: FD %u's DICT is damaged", f);
                    for (int j = 0; j < fn; j++) {
                        if (fe[j].op == 18 && fe[j].n >= 2 &&
                            cff_private(c, len, fe[j].ops[fe[j].n - 2], fe[j].ops[fe[j].n - 1], "FD", err, errlen) != 0)
                            return -1;
                    }
                }
            }
        }
    }
    if (!charstrings) return fail(err, errlen, "output-invalid", "FontForge's CFF Top DICT names no CharStrings");
    return 0;
}

int ffc_check_output(const unsigned char *b, size_t len, const char *ext, char *err, size_t errlen) {
    if (len == 0) return fail(err, errlen, "output-invalid", "FontForge wrote an empty .%s file", ext);
    if (strcmp(ext, "svg") == 0) {
        size_t i = skip_bom_and_space(b, len);
        if (!starts(b + i, len - i, "<?xml", 5) && !starts(b + i, len - i, "<svg", 4))
            return fail(err, errlen, "output-invalid", "FontForge's .svg output is not XML");
        if (!has_font_element(b + i, len - i) || !contains(b + i, len - i, "</font>"))
            return fail(err, errlen, "output-invalid", "FontForge's .svg output has no complete <font> element");
        return 0;
    }
    int ttf = strcmp(ext, "ttf") == 0;
    if (!starts(b, len, ttf ? "\x00\x01\x00\x00" : "OTTO", 4))
        return fail(err, errlen, "output-invalid", "FontForge's .%s output does not start with a %s sfnt header", ext,
                    ttf ? "TrueType" : "CFF");
    unsigned n;
    char why[FFC_ERR_BYTES];
    if (read_directory(b, len, &n, why, sizeof why) != 0)
        return fail(err, errlen, "output-invalid", "FontForge's .%s output: %s", ext, why);
    if (ttf && (!has_table(b, n, "glyf") || !has_table(b, n, "loca") || has_table(b, n, "CFF ")))
        return fail(err, errlen, "output-invalid", "FontForge's .ttf output lacks TrueType outlines");
    if (!ttf && (!has_table(b, n, "CFF ") || has_table(b, n, "glyf")))
        return fail(err, errlen, "output-invalid", "FontForge's .otf output lacks CFF outlines");
    if (!ttf) {
        uint32_t clen;
        const unsigned char *cff = find_table(b, n, "CFF ", &clen);
        if (cff_check(cff, clen, err, errlen) != 0) return -1;
    }
    return 0;
}

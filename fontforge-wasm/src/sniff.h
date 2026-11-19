/* ffconv's own checks around FontForge (P2 plan, P2-4 and P2-5): what it accepts as input, and whether what FontForge
 * wrote is the font that was asked for. Pure functions over bytes; main.c reads the files. */
#ifndef FFCONV_SNIFF_H
#define FFCONV_SNIFF_H

#include <stddef.h>

#define FFC_MAX_INPUT_BYTES ((size_t)32 * 1024 * 1024) /* 32 MiB: FontForge needs 25-55 times the input (P2-4) */
#define FFC_MAX_TABLES 4096u
#define FFC_ERR_BYTES 256

typedef struct {
    const char *kind;   /* "sfnt" or "svg" */
    const char *flavor; /* "truetype" or "cff" (from the tables, never the sfnt version); NULL for svg */
    long num_glyphs;    /* maxp.numGlyphs; -1 for svg */
    const char *ext;    /* the canonical input name's extension: "ttf", "otf" or "svg" */
} ffc_input;

/* The id of the last refusal (fontconverter-web P3b plan, P3b-7): one of ffconv's error ids, set with every -1 below;
 * an instance converts once, so one value per run is enough. */
const char *ffc_error_id(void);

/* 0 with *in filled, or -1 with the reason in err (no prefix, no newline). */
int ffc_sniff_input(const unsigned char *b, size_t len, int allow_lossy, ffc_input *in, char *err, size_t errlen);

/* 0 when b is a font of the kind ext names ("ttf", "otf" or "svg"), or -1 with the reason in err. */
int ffc_check_output(const unsigned char *b, size_t len, const char *ext, char *err, size_t errlen);

#endif

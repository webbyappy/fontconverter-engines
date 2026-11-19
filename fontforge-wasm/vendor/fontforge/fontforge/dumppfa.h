#ifndef FONTFORGE_DUMPPFA_H
#define FONTFORGE_DUMPPFA_H

#include "splinefont.h"

#include <stdio.h>
/* fontforge-wasm patch 1 (VENDORING.md): a correctly typed fputc callback */

/* Callback for the dump* functions that writes one byte to a FILE*.
 * The original code passed fputc itself through a cast,
 *     (void (*)(int,void *)) fputc
 * i.e. it called an int-returning function through a pointer to a
 * void-returning one. Native ABIs tolerate that; WebAssembly traps on the
 * indirect call ("function signature mismatch"). */
static inline void FF_DumpCharToFile(int ch, void *data) {
    fputc(ch, (FILE *) data);
}

extern char *PSDictHasEntry(struct psdict *dict, const char *key);
extern double BlueScaleFigureForced(struct psdict *private_, real bluevalues[], real otherblues[]);
extern int PSBitmapDump(char *filename, BDFFont *font, EncMap *map);
extern int PSDictChangeEntry(struct psdict *dict, const char *key, const char *newval);
extern int PSDictFindEntry(struct psdict *dict, const char *key);
extern int PSDictRemoveEntry(struct psdict *dict, const char *key);
extern int PSDictSame(struct psdict *dict1, struct psdict *dict2);
extern int WritePSFont(char *fontname, SplineFont *sf, enum fontformat format, int flags, EncMap *map, SplineFont *fullsf, int layer);
extern int _WritePSFont(FILE *out, SplineFont *sf, enum fontformat format, int flags, EncMap *map, SplineFont *fullsf, int layer);
extern struct psdict *PSDictCopy(struct psdict *dict);
extern void SC_PSDump(void (*dumpchar)(int ch, void *data), void *data, SplineChar *sc, int refs_to_splines, int pdfopers, int layer);

#endif /* FONTFORGE_DUMPPFA_H */

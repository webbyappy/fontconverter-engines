/* Minimal libffi implementation for WASM/Emscripten
 *
 * WASM has a single, simple calling convention — all args are passed on the
 * WASM value stack as i32/i64/f32/f64. No platform-specific assembly needed.
 *
 * This implements just enough for GObject's g_cclosure_marshal_generic(),
 * which calls ffi_prep_cif() + ffi_call() to invoke signal callbacks.
 *
 * Strategy: Cast the function pointer to a type matching the arg count
 * (up to 16 args). All pointer/integer args are passed as void*.
 * Floats/doubles are handled via union tricks.
 */

#include "ffi.h"
#include <string.h>
#include <stdlib.h>

/* Type definitions */
ffi_type ffi_type_void    = { 0, 0, FFI_TYPE_VOID, NULL };
ffi_type ffi_type_uint8   = { 1, 1, FFI_TYPE_UINT8, NULL };
ffi_type ffi_type_sint8   = { 1, 1, FFI_TYPE_SINT8, NULL };
ffi_type ffi_type_uint16  = { 2, 2, FFI_TYPE_UINT16, NULL };
ffi_type ffi_type_sint16  = { 2, 2, FFI_TYPE_SINT16, NULL };
ffi_type ffi_type_uint32  = { 4, 4, FFI_TYPE_UINT32, NULL };
ffi_type ffi_type_sint32  = { 4, 4, FFI_TYPE_SINT32, NULL };
ffi_type ffi_type_uint64  = { 8, 8, FFI_TYPE_UINT64, NULL };
ffi_type ffi_type_sint64  = { 8, 8, FFI_TYPE_SINT64, NULL };
ffi_type ffi_type_float   = { 4, 4, FFI_TYPE_FLOAT, NULL };
ffi_type ffi_type_double  = { 8, 8, FFI_TYPE_DOUBLE, NULL };
ffi_type ffi_type_pointer = { sizeof(void*), sizeof(void*), FFI_TYPE_POINTER, NULL };

ffi_status ffi_prep_cif(ffi_cif *cif, ffi_abi abi, unsigned int nargs,
                        ffi_type *rtype, ffi_type **atypes) {
    if (!cif) return FFI_BAD_TYPEDEF;
    cif->abi = abi;
    cif->nargs = nargs;
    cif->rtype = rtype;
    cif->arg_types = atypes;
    cif->bytes = 0;
    cif->flags = 0;
    return FFI_OK;
}

/*
 * On WASM32, all pointer-sized args (int, uint, pointer, enum, flags)
 * are 32 bits. We cast to a generic function type based on arg count.
 *
 * GObject callbacks typically have the signature:
 *   return_type callback(instance, [signal_args...], user_data)
 *
 * For WASM, we can pass all values as intptr_t (void*-sized) since
 * WASM's calling convention treats all i32 values identically regardless
 * of their C type.
 *
 * We handle up to 16 arguments which covers all practical GObject signals.
 */

typedef intptr_t ffi_arg;

/* Helper to read an argument value depending on its type */
static intptr_t read_arg(void *avalue, ffi_type *type) {
    switch (type->type) {
        case FFI_TYPE_UINT8:   return (intptr_t)*(uint8_t*)avalue;
        case FFI_TYPE_SINT8:   return (intptr_t)*(int8_t*)avalue;
        case FFI_TYPE_UINT16:  return (intptr_t)*(uint16_t*)avalue;
        case FFI_TYPE_SINT16:  return (intptr_t)*(int16_t*)avalue;
        case FFI_TYPE_UINT32:  return (intptr_t)*(uint32_t*)avalue;
        case FFI_TYPE_SINT32:  return (intptr_t)*(int32_t*)avalue;
        case FFI_TYPE_UINT64:  return (intptr_t)*(uint64_t*)avalue;
        case FFI_TYPE_SINT64:  return (intptr_t)*(int64_t*)avalue;
        case FFI_TYPE_POINTER: return (intptr_t)*(void**)avalue;
        case FFI_TYPE_FLOAT:   { union { float f; intptr_t i; } u; u.f = *(float*)avalue; return u.i; }
        case FFI_TYPE_DOUBLE:  return (intptr_t)*(void**)avalue; /* pass as pointer on 32-bit */
        default:               return (intptr_t)*(void**)avalue;
    }
}

/* Write return value */
static void write_ret(void *rvalue, ffi_type *rtype, intptr_t ret) {
    if (!rvalue || rtype->type == FFI_TYPE_VOID) return;
    switch (rtype->type) {
        case FFI_TYPE_UINT8:   *(uint8_t*)rvalue = (uint8_t)ret; break;
        case FFI_TYPE_SINT8:   *(int8_t*)rvalue = (int8_t)ret; break;
        case FFI_TYPE_UINT16:  *(uint16_t*)rvalue = (uint16_t)ret; break;
        case FFI_TYPE_SINT16:  *(int16_t*)rvalue = (int16_t)ret; break;
        case FFI_TYPE_UINT32:  *(uint32_t*)rvalue = (uint32_t)ret; break;
        case FFI_TYPE_SINT32:  *(int32_t*)rvalue = (int32_t)ret; break;
        case FFI_TYPE_UINT64:  *(uint64_t*)rvalue = (uint64_t)ret; break;
        case FFI_TYPE_SINT64:  *(int64_t*)rvalue = (int64_t)ret; break;
        case FFI_TYPE_POINTER: *(void**)rvalue = (void*)ret; break;
        case FFI_TYPE_FLOAT:   { union { float f; intptr_t i; } u; u.i = ret; *(float*)rvalue = u.f; break; }
        case FFI_TYPE_DOUBLE:  *(double*)rvalue = *(double*)&ret; break;
        default:               *(intptr_t*)rvalue = ret; break;
    }
}

/* Function pointer typedefs for 0-16 args (all passed as intptr_t on WASM32) */
typedef intptr_t (*fn0)(void);
typedef intptr_t (*fn1)(intptr_t);
typedef intptr_t (*fn2)(intptr_t, intptr_t);
typedef intptr_t (*fn3)(intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn4)(intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn5)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn6)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn7)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn8)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn9)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn10)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn11)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);
typedef intptr_t (*fn12)(intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t, intptr_t);

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue) {
    intptr_t a[12];
    intptr_t ret = 0;
    unsigned i;
    unsigned n = cif->nargs;

    if (n > 12) n = 12; /* safety cap */

    /* Read all arguments */
    for (i = 0; i < n; i++) {
        a[i] = read_arg(avalue[i], cif->arg_types[i]);
    }

    /* Dispatch based on arg count */
    switch (n) {
        case 0:  ret = ((fn0)fn)(); break;
        case 1:  ret = ((fn1)fn)(a[0]); break;
        case 2:  ret = ((fn2)fn)(a[0], a[1]); break;
        case 3:  ret = ((fn3)fn)(a[0], a[1], a[2]); break;
        case 4:  ret = ((fn4)fn)(a[0], a[1], a[2], a[3]); break;
        case 5:  ret = ((fn5)fn)(a[0], a[1], a[2], a[3], a[4]); break;
        case 6:  ret = ((fn6)fn)(a[0], a[1], a[2], a[3], a[4], a[5]); break;
        case 7:  ret = ((fn7)fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6]); break;
        case 8:  ret = ((fn8)fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]); break;
        case 9:  ret = ((fn9)fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]); break;
        case 10: ret = ((fn10)fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9]); break;
        case 11: ret = ((fn11)fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10]); break;
        case 12: ret = ((fn12)fn)(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11]); break;
    }

    write_ret(rvalue, cif->rtype, ret);
}

/**
 * ffconv post.js (P2 plan, fontconverter-web docs/audits/P2-FFCONV-PLAN-2026-11-17.md; after font-wasm/post.js at
 * 840fd65d8)
 *
 * Appended after the Emscripten runtime (MODULARIZE, EXPORT_NAME='FFConv'). ffconv is synchronous and
 * non-Asyncify: a caller writes the input into MEMFS (or mounts it with WORKERFS / NODEFS), sets ENV in preRun
 * (SOURCE_DATE_EPOCH, USER, LANG: P2-7), runs callMain once (one conversion per instance, P2-6), and reads the
 * output back with FS.readFile.
 *
 * Surface:
 *   FS, WORKERFS, NODEFS, ENV     the repo-wide filesystem contract, and the environment FontForge reads
 *   callMain(args)                synchronous; a C++ exception escaping main() becomes
 *                                 Error('C++ Exception [<type>]: <message>') with .cppType (ffconv is pure C, so
 *                                 this is defence in depth); anything else (a filesystem error, a trap, an abort, a
 *                                 throwing print callback) is rethrown untouched
 *   flushStderr()                 deliver a pending unterminated stderr line
 *   heapBytes()                   current linear-memory size (it only grows: after a run, the peak)
 *   mountFile / mountBlob / unmountFile   WORKERFS input (worker only: needs FileReaderSync)
 *
 * String marshalling: this file copies no JS string into wasm memory. Any code added here that does MUST size the
 * buffer in UTF-8 BYTES (new TextEncoder().encode(s).length + 1), never s.length.
 */

Module.FS = FS;
Module.WORKERFS = WORKERFS;
Module.NODEFS = NODEFS;
Module.ENV = ENV;

// Only a C++ exception (CppException, defined by this glue) carries an exception pointer for getExceptionMessage
// to read; anything else handed to it would read address 0. The decode happens outside the guarded call so that a
// failure inside getExceptionMessage cannot be swallowed.
Module._rawCallMain = callMain;
function isCppException(error) {
    return typeof CppException === 'function' && error instanceof CppException;
}
Module.callMain = function (args) {
    try {
        return Module._rawCallMain(args);
    } catch (e) {
        if (!isCppException(e)) throw e;
        let decoded = null;
        if (typeof getExceptionMessage === 'function') {
            try {
                const [type, msg] = getExceptionMessage(e);
                decoded = new Error('C++ Exception [' + (type || 'unknown') + ']: ' + (msg || ''));
                decoded.cppType = type;
            } catch (_) { /* fall through to the raw exception */ }
        }
        if (decoded) throw decoded;
        throw e;
    }
};

Module.flushStderr = function () {
    const s = FS.getStream(2);
    if (s && s.stream_ops && typeof s.stream_ops.fsync === 'function') s.stream_ops.fsync(s);
};

Module.heapBytes = function () {
    return HEAPU8.buffer.byteLength;
};

// fontconverter-web P3b (P3b plan, P3b-5): why the runtime aborted. The runtime calls Module.onAbort(what) before it
// throws; with ABORTING_MALLOC=1 and the 1 GiB ceiling, running out of memory aborts with exactly "OOM".
// lastAbort(): null, "oom" or "abort". A caller's own onAbort still runs.
let _lastAbort = null;
const _callerOnAbort = Module.onAbort;
Module.onAbort = function (what) {
    _lastAbort = String(what) === 'OOM' ? 'oom' : 'abort';
    if (typeof _callerOnAbort === 'function') _callerOnAbort(what);
};
Module.lastAbort = function () {
    return _lastAbort;
};

// mountFile(file, '/in') -> '/in/<file.name>'; mountBlob(name, blob, '/in') -> '/in/<name>'.
function _ensureMountDir(mountPath) {
    if (!FS.analyzePath(mountPath).exists) FS.mkdir(mountPath);
}
Module.mountFile = function (file, mountPath) {
    mountPath = mountPath || '/in';
    _ensureMountDir(mountPath);
    FS.mount(WORKERFS, { files: [file] }, mountPath);
    return mountPath + '/' + file.name;
};
Module.mountBlob = function (name, blob, mountPath) {
    mountPath = mountPath || '/in';
    _ensureMountDir(mountPath);
    FS.mount(WORKERFS, { blobs: [{ name: name, data: blob }] }, mountPath);
    return mountPath + '/' + name;
};
Module.unmountFile = function (mountPath) {
    try { FS.unmount(mountPath); } catch (e) { /* not mounted */ }
    try { FS.rmdir(mountPath); } catch (e) { /* not empty or missing */ }
};

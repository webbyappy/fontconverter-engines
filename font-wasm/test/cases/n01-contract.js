'use strict';
// N1: the repo's NODEFS contract test, and an input read through a NODEFS mount (wasm only).

const childProcess = require('child_process');
const path = require('path');
const { fx, readFixture } = require('../lib/fixtures');
const { MODULE_DIR } = require('../lib/engine');
const { describe } = require('../lib/checks');
const { woffEntries, sfntEntries } = require('../lib/sfnt');

const CONTRACT = path.join(path.dirname(MODULE_DIR), 'test-nodefs-contract.js');

module.exports = {
  id: 'N1', title: 'contract', needsEngine: true,
  async run(ctx) {
    if (ctx.kind !== 'wasm') {
      ctx.rep.notApplicable('contract', 'the NODEFS contract is about the wasm glue');
      ctx.rep.notApplicable('NODEFS input', 'the native binary reads host paths directly');
      return;
    }
    const p = childProcess.spawnSync(process.execPath, [CONTRACT, ctx.eng.gluePath, fx('samples')], { encoding: 'utf8' });
    ctx.rep.check('test-nodefs-contract.js', p.status === 0 && /^OK: .*FS\/WORKERFS\/NODEFS all live/m.test(p.stdout),
      `exit ${p.status}: ${(p.stdout + p.stderr).trim().slice(0, 300)}`);

    const { M, io } = await ctx.eng.instance();
    M.FS.mkdir('/host');
    M.FS.mount(M.NODEFS, { root: fx('samples') }, '/host');
    let code = null;
    let threw = null;
    try { code = M.callMain(['woff-encode', '/host/slick.ttf', '/out/slick.woff']); } catch (e) { threw = e; }
    process.exitCode = 0;
    M.FS.unmount('/host');
    const exists = M.FS.analyzePath('/out/slick.woff').exists;
    let same = false;
    if (exists) {
      const got = woffEntries(Buffer.from(M.FS.readFile('/out/slick.woff')));
      const want = sfntEntries(readFixture('samples/slick.ttf'));
      same = got.length === want.length && want.every((w) => got.some((g) => g.tag === w.tag && g.data.equals(w.data)));
    }
    const r = { code, threw, stdout: io.out, stderr: io.err, json: null, outExists: exists };
    ctx.rep.check('woff-encode reads its input through a NODEFS mount', code === 0 && !threw && same &&
      io.out.length === 1, describe(r) + (exists ? '' : ' (no output)'));
  },
};

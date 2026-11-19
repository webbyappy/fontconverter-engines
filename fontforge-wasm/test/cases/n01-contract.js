'use strict';
// N1: the repo's NODEFS contract test, and an input read through a NODEFS mount (wasm only).

const childProcess = require('child_process');
const path = require('path');
const { fx } = require('../lib/fixtures');
const { MODULE_DIR } = require('../lib/engine');
const { describe, magicOk } = require('../lib/checks');

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
    try { code = M.callMain(['convert', '/host/slick.ttf', '/out/slick.otf']); } catch (e) { threw = e; }
    process.exitCode = 0;
    M.FS.unmount('/host');
    const exists = M.FS.analyzePath('/out/slick.otf').exists;
    const out = exists ? Buffer.from(M.FS.readFile('/out/slick.otf')) : null;
    ctx.rep.check('convert reads its input through a NODEFS mount', code === 0 && !threw && magicOk(out, 'otf') &&
      io.out.length === 1, describe({ code, threw, stdout: io.out, stderr: io.err }));
  },
};

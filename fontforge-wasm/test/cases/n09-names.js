'use strict';
// N9: unusual file names, as input and as output names, in MEMFS and through NODEFS: the outputs equal their source's
// recorded entries (ffconv hands FontForge canonical names, P2-3).

const { fx, readFixture, sha256 } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { describe, success } = require('../lib/checks');
const oracle = require('../lib/oracle');

// [input name, its source fixture, target]: generated/names are byte copies of samples (font-oracle.json's manifest)
const NAMES = [
  ['OpenSans-Regular.TTF', 'samples/OpenSans-Regular.ttf', 'otf'],
  ['Open Sans Regular.ttf', 'samples/OpenSans-Regular.ttf', 'otf'],
  ['프메2.ttf', 'samples/OpenSans-Regular.ttf', 'otf'],
  ['Μ.otf', 'samples/slick.otf', 'ttf'],
  ['font #1.ttf', 'samples/slick.ttf', 'otf'],
];
const IN_MEMORY = [['font (1).ttf', 'samples/slick.ttf', 'otf'], ['font(1)', 'samples/slick.ttf', 'otf']];

module.exports = {
  id: 'N9', title: 'names', needsEngine: true,
  async run(ctx) {
    const recorded = oracle.ffconvOracle();
    const expect = (src, target) => recorded && recorded.outputs[`${src}#${target}`];
    for (const [name, src, target] of NAMES.concat(IN_MEMORY)) {
      const fromDrive = NAMES.some((n) => n[0] === name);
      const bytes = fromDrive ? readFixture(`generated/names/${name}`) : readFixture(src);
      const outName = name.replace(/\.[^.]*$|$/, '') + ' out ' + name.slice(0, 3) + '.' + target;
      const r = await ctx.eng.run(['convert', IN, OUT], { input: bytes, inName: name, outName });
      const e = expect(src, target);
      ctx.rep.check(`${name} -> "${outName}"`, success(r, target).ok && (!e || sha256(r.out) === e.file.sha256) &&
        r.outDir.length === 1 && r.outDir[0] === outName, `${describe(r)}${e ? '' : ' (no oracle to compare)'}`);
    }
    if (ctx.kind !== 'wasm') {
      ctx.rep.notApplicable('NODEFS', 'the native binary reads host paths directly (the rows above did)');
      return;
    }
    const { M, io } = await ctx.eng.instance();
    M.FS.mkdir('/host');
    M.FS.mount(M.NODEFS, { root: fx('generated/names') }, '/host');
    let code = null;
    try { code = M.callMain(['convert', '/host/프메2.ttf', '/out/프메2 output.otf']); } catch (e) { code = String(e); }
    process.exitCode = 0;
    M.FS.unmount('/host');
    const out = M.FS.analyzePath('/out/프메2 output.otf').exists ? Buffer.from(M.FS.readFile('/out/프메2 output.otf')) : null;
    const e = expect('samples/OpenSans-Regular.ttf', 'otf');
    ctx.rep.check('a non-ASCII name through NODEFS', code === 0 && out && (!e || sha256(out) === e.file.sha256),
      `exit ${code}; ${io.err.slice(-1)}`);
  },
};

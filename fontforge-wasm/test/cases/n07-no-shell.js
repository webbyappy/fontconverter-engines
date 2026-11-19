'use strict';
// N7: no shell. FontForge shells out by file name (gunzip, unzip, ...); ffconv hands it a canonical name, refuses
// compressed input by content, and links a system() that always fails (src/no-subprocess.c).

const fs = require('fs');
const zlib = require('zlib');
const { readFixture, sha256 } = require('../lib/fixtures');
const { IN, OUT } = require('../lib/engine');
const { cleanFailure, describe, success } = require('../lib/checks');
const oracle = require('../lib/oracle');

module.exports = {
  id: 'N7', title: 'no shell', needsEngine: true,
  async run(ctx) {
    const slick = readFixture('samples/slick.ttf');
    const gz = await ctx.eng.run(['convert', IN, OUT], { input: zlib.gzipSync(slick), inName: 'in.ttf.gz',
      outName: 'output.otf' });
    ctx.rep.check('gzip bytes named .ttf.gz are refused as gzip', cleanFailure(gz).ok &&
      /gzip/i.test(gz.stderr.slice(-1)[0] || ''), cleanFailure(gz).why);
    const named = await ctx.eng.run(['convert', IN, OUT], { input: slick, inName: 'in.ttf.gz', outName: 'output.otf' });
    const recorded = oracle.ffconvOracle();
    const want = recorded && recorded.outputs['samples/slick.ttf#otf'];
    ctx.rep.check('a TrueType font named .ttf.gz converts like slick.ttf (FontForge sees only the canonical name)',
      success(named, 'otf').ok && !named.stderr.some((l) => /sh:|\/bin\/sh|gunzip/.test(l)) &&
      (!want || sha256(named.out) === want.file.sha256), `${describe(named)}${want ? '' : ' (no oracle to compare)'}`);
    const sys = await ctx.eng.run(['selftest-system']);
    ctx.rep.check('system() always fails with ENOSYS', sys.code === 0 && sys.json && sys.json.system === -1 &&
      sys.json.enosys === true, describe(sys));
    if (ctx.kind === 'wasm') {
      const glue = fs.readFileSync(ctx.eng.gluePath, 'latin1');
      ctx.rep.check('the glue contains no child_process', !glue.includes('child_process'));
    } else {
      ctx.rep.notApplicable('glue', 'the native binary has no glue');
    }
  },
};

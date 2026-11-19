'use strict';
// The committed ffconv engine (fontforge-wasm/output), run in-process to make what `hbfont transplant` consumes:
// FontForge's output of a colour font (`convert --allow-lossy --glyph-map`) and its glyph map, as the app's route does
// (fontconverter-web P3b plan, section 3.3). One conversion per instance, as ffconv requires; the clock and author
// pinned as production's twin pins them.

const fs = require('fs');
const path = require('path');

const GLUE = path.resolve(__dirname, '..', '..', '..', 'fontforge-wasm', 'output', 'ffconv.js');
const ENV = { SOURCE_DATE_EPOCH: '1794873600', USER: 'fontforge', LANG: 'C.UTF-8' };

let factory = null;
let compiled = null;

async function load() {
  if (!factory) {
    factory = require(GLUE);
    compiled = await WebAssembly.compile(fs.readFileSync(GLUE.replace(/\.js$/, '.wasm')));
  }
}

// FontForge's `to` output of `font` (named `inName`, whose extension tells ffconv the input kind) and its glyph map.
// opts.route: the app's argv for a font without colour (`convert <in> <out>`: no --allow-lossy, no map; map null).
async function fontforge(font, inName, to, opts = {}) {
  await load();
  const io = { out: [], err: [] };
  const M = await factory({
    print: (s) => io.out.push(s), printErr: (s) => io.err.push(s),
    preRun: [(m) => Object.assign(m.ENV, ENV)],
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(compiled, imports).then((inst) => done(inst, compiled));
      return {};
    },
  });
  M.FS.mkdir('/in');
  M.FS.mkdir('/out');
  M.FS.writeFile(`/in/${inName}`, font);
  let code = null;
  try {
    const flags = opts.route ? [] : ['--allow-lossy', '--glyph-map', '/out/map.json'];
    code = M.callMain(['convert', ...flags, `/in/${inName}`, `/out/out.${to}`]);
  } catch (e) {
    throw new Error(`ffconv threw on ${inName}: ${e && e.message}`);
  }
  process.exitCode = 0;
  if (code !== 0) throw new Error(`ffconv exit ${code} on ${inName} to ${to}: ${io.err.slice(-1)[0] || ''}`);
  return { font: Buffer.from(M.FS.readFile(`/out/out.${to}`)),
    map: opts.route ? null : Buffer.from(M.FS.readFile('/out/map.json')) };
}

module.exports = { GLUE, fontforge };

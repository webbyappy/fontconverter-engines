'use strict';
// N12: the recorded oracle (fontconverter-web P3b plan, section 4.1): hbfont-oracle.json was made by this engine
// (its sha256), is complete (not partial, not a trial), and every hbfont output it records is reproduced byte for
// byte: each #instance entry, the instance under each #route entry, and each #transplant entry from FontForge's
// recorded output and map. Every recorded judge verdict is pass. The judges ran when the oracle was made; a test never
// runs Python.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FONT_FIXTURES, fx } = require('../lib/fixtures');
const { OUT, inp } = require('../lib/engine');
const { describe, success } = require('../lib/checks');

const ORACLE = path.join(FONT_FIXTURES, 'hbfont-oracle.json');
const ENTRIES = { instance: 25, route: 17, transplant: 14 }; // make-oracle.mjs: N4's 17 specs and OpenSans-VF's 10 named (2 shared)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function parse(key) {
  const [fixture, rest] = key.split('#');
  const [kind, ...parts] = rest.split(':');
  return { fixture, kind, parts };
}

module.exports = {
  id: 'N12', title: 'recorded outputs', needsEngine: true,
  async run(ctx) {
    if (!fs.existsSync(ORACLE)) {
      ctx.rep.fail('the oracle exists', `${ORACLE} is missing (run make-oracle.mjs)`);
      return;
    }
    const o = JSON.parse(fs.readFileSync(ORACLE, 'utf8'));
    ctx.rep.check('the oracle is complete and authoritative', !o.partial && !o.scratch && o.engine === 'hbfont');
    if (ctx.kind === 'wasm') {
      const wasm = sha256(fs.readFileSync(ctx.eng.wasmPath));
      ctx.rep.check('the oracle was made by this engine', o.generator.engine.wasm === wasm,
        `${o.generator.engine.wasm} vs ${wasm}`);
    }
    const counts = { instance: 0, route: 0, transplant: 0 };
    const routeInstances = new Set();
    for (const [key, e] of Object.entries(o.outputs)) {
      const { fixture, kind, parts } = parse(key);
      counts[kind] = (counts[kind] || 0) + 1;
      if (!ctx.keep(fixture)) continue;
      if (kind === 'instance') {
        const r = await ctx.eng.run([...e.argv, inp('f'), OUT], { inputs: { f: fs.readFileSync(fx(fixture)) } });
        ctx.rep.check(`${key}: the recorded bytes; judge_instance passed`, success(r) && sha256(r.out) === e.file.sha256 &&
          e.judge_instance.verdict === 'pass', describe(r));
      } else if (kind === 'route') {
        const spec = parts[0];
        if (routeInstances.has(`${fixture} ${spec}`)) continue;
        routeInstances.add(`${fixture} ${spec}`);
        const at = spec.replace(/-cff$/, '').split('-').map((x) => x.replace(/^([a-zA-Z]+)/, '$1=')).join(',');
        const opts = spec.endsWith('-cff') ? ['--downgrade-cff2'] : [];
        const r = await ctx.eng.run(['instance', ...opts, '--at', at, inp('f'), OUT], { inputs: { f: fs.readFileSync(fx(fixture)) } });
        const routes = Object.entries(o.outputs).filter(([k]) => k.startsWith(`${fixture}#route:${spec}:`));
        ctx.rep.check(`${fixture} at ${spec}: the instance every route started from; their judges passed`,
          success(r) && routes.every(([, x]) => x.instance_sha256 === sha256(r.out) &&
            (!x.judge_layout || x.judge_layout.verdict === 'pass') && (x.names_after_fontforge || 'equal') === 'equal'),
          describe(r));
      } else if (kind === 'transplant') {
        const read = (f) => fs.readFileSync(path.join(FONT_FIXTURES, f.path));
        let src = fs.readFileSync(fx(fixture));
        if (parts.length === 2) {
          const spec = parts[0];
          const at = spec.replace(/-cff$/, '').split('-').map((x) => x.replace(/^([a-zA-Z]+)/, '$1=')).join(',');
          const i = await ctx.eng.run(['instance', ...(spec.endsWith('-cff') ? ['--downgrade-cff2'] : []), '--at', at,
            inp('f'), OUT], { inputs: { f: src } });
          src = i.out;
        }
        const r = await ctx.eng.run(['transplant', inp('s'), inp('o'), inp('m'), OUT],
          { inputs: { s: src, o: read(e.fontforge), m: read(e.map) } });
        ctx.rep.check(`${key}: the recorded bytes from FontForge's recorded output; judge_colour passed`, success(r) &&
          sha256(src) === e.src_sha256 && sha256(r.out) === e.file.sha256 && e.judge_colour.verdict === 'pass', describe(r));
      }
    }
    for (const [kind, want] of Object.entries(ENTRIES)) ctx.count(`${kind} entries`, counts[kind], want);
  },
};

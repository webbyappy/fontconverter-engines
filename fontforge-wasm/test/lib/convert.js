'use strict';
// One op-table entry through the engine, cached for the run (N2 converts; N3 and N12 reuse the result).

const { fx, readFixture } = require('./fixtures');
const { IN, OUT } = require('./engine');

async function convertOp(ctx, o) {
  if (ctx.outputs.has(o.key)) return ctx.outputs.get(o.key);
  const r = await ctx.eng.run(['convert', IN, OUT], { input: { path: fx(o.input.rel) }, inName: o.inName,
    outName: o.outName });
  delete r.M; // keep the instance collectable
  ctx.outputs.set(o.key, r);
  return r;
}

function inputBytes(o) {
  return readFixture(o.input.rel);
}

module.exports = { convertOp, inputBytes };

'use strict';
// N1: the command-line contract (P3b plan, section 3.1; P3b-7): exit 0 = one JSON line; exit 1 = an error line and
// the failure line, no output; exit 2 = usage, the failure line with "usage"; an unknown command never echoed.

const { describe, errorIds, success, usageFailure } = require('../lib/checks');

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

module.exports = {
  id: 'N1', title: 'contract', needsEngine: true,
  async run(ctx) {
    const ids = await ctx.eng.run(['error-ids']);
    const list = ids.json && Array.isArray(ids.json.ids) ? ids.json.ids : [];
    ctx.rep.check('error-ids prints {"ok":true,"v":1,"command":"error-ids","ids":[...]}: unique kebab-case ids',
      success(ids, true) && ids.json.v === 1 && list.length > 0 && new Set(list).size === list.length &&
      list.every((i) => ID_RE.test(i)) && ['usage', 'io', 'out-of-memory', 'unexpected'].every((i) => list.includes(i)),
      describe(ids));
    const v = await ctx.eng.run(['version']);
    ctx.rep.check('version prints one JSON line: hbfont 1.0.0, HarfBuzz 15.0.0, zlib 1.3.2', success(v, true) &&
      v.json.command === 'version' && v.json.hbfont === '1.0.0' && v.json.harfbuzz === '15.0.0' &&
      v.json.zlib === '1.3.2', describe(v));
    const h = await ctx.eng.run(['help']);
    ctx.rep.check('help exits 0 with the usage on stdout', !h.threw && h.code === 0 && /^usage: hbfont/.test(h.stdout[0] || ''),
      describe(h));
    const unknown = await ctx.eng.run(['frobnicate-x7']);
    ctx.rep.check('an unknown command: usage error, command null, the argument never echoed',
      usageFailure(unknown) && unknown.json.command === null && !unknown.stdout[0].includes('frobnicate'),
      describe(unknown));
    const none = await ctx.eng.run([]);
    ctx.rep.check('no command: usage error, command null', usageFailure(none) && none.json.command === null,
      describe(none));
    for (const [args, why] of [[['version', 'x'], 'version takes no file'], [['error-ids', '--strict'], 'an option']]) {
      const r = await ctx.eng.run(args);
      ctx.rep.check(`${args.join(' ')}: usage error naming its command (${why})`,
        usageFailure(r) && r.json.command === args[0], describe(r));
    }
    // Every id a later case provokes is listed (the cases check their own rows against this list).
    ctx.rep.check('the driver loaded the same id list', errorIds() !== null && errorIds().size === list.length);
  },
};

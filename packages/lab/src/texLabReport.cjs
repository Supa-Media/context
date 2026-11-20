/**
 * THE TEX LAB'S READER FOR A PASTED RUN REPORT (the Lab's Run tab, "Keep these results"; ported from the artifact's
 * `parseReport`). One copy: the Lab (`packages/lab/app/views/run/runText.ts`) and the control plane, for
 * the MCP's `tex_dev` `keep_results` (`apps/convex/functions/lib/texLabDraftWrites.ts`), both read reports with it, so
 * a result kept from either door scores the same.
 *
 * One fix over the artifact: its `\$([\d.]+)` took the sentence's closing period, so every pasted cost read NaN.
 */

/** At most this much of a report is kept with the result, as the Lab keeps. */
const RAW_MAX = 6000;
/** A replay's Then-and-Now is the person's own chat: it is never kept with a version every staff member reads. */
const REPLAY_HEADING = "## Lab replay";

function parseReport(txt, at = Date.now()) {
  const r = { at, areas: {}, raw: txt.slice(0, RAW_MAX) };
  const h = txt.match(/Tex replay:\s*(✅|❌)\s*([^\n]*)/);
  if (h) {
    r.pass = h[1] === "✅";
    r.headline = h[2].trim();
  }
  for (const m of txt.matchAll(/\*\*([a-z-]+):\*\*\s*practice (\d+)\/(\d+) right, held-out (\d+)\/(\d+) right; spent about \$(\d+(?:\.\d+)?)/g))
    r.areas[m[1]] = { practice: [+m[2], +m[3]], held: [+m[4], +m[5]], usd: +m[6] };
  const reg = txt.match(/(\d+) case\(s\) regressed/);
  r.regressed = reg ? +reg[1] : r.pass ? 0 : null;
  return r;
}

/** The part of a pasted report that may be kept: everything before its "## Lab replay" block, trimmed. */
function keptPart(txt) {
  const i = txt.indexOf(REPLAY_HEADING);
  return (i >= 0 ? txt.slice(0, i) : txt).trim();
}

module.exports = { RAW_MAX, REPLAY_HEADING, parseReport, keptPart };

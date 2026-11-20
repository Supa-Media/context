/**
 * WHICH MAIN A LAB DRAFT STARTED FROM (Dev2, 2026-11-17: parallel config changes must not write over each other).
 *
 * A draft remembers the stamp of the `texConfig.json` it was made from. Promote finds the commit on main with that
 * config and merges only what the draft changed since then onto main as it is now (`scripts/tex-lab-merge.mjs`), so a
 * change someone else merged in between is kept, and a change to the same setting is named instead of overwritten.
 *
 * The stamp is a hash of the config's JSON as parsed (the Lab, the gateway and the promote script parse the same
 * file, so they get the same text): small, synchronous, the same in a browser, a Worker and Node. It names a config,
 * never proves one; the promote script checks the config it found against it.
 */
"use strict";

/** cyrb53: a 53-bit string hash, as 14 hex digits. */
function hash53(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The stamp of a parsed `texConfig.json`: `c` and 14 hex digits. */
function configStamp(config) {
  return "c" + hash53(JSON.stringify(config));
}

const STAMP = /^c[0-9a-f]{14}$/;

/** Is this a stamp `configStamp` makes? */
const isStamp = (value) => typeof value === "string" && STAMP.test(value);

module.exports = { configStamp, isStamp };

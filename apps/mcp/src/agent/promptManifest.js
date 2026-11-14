/**
 * WHICH PROMPT A MODEL CALL WAS SENT, WITHOUT KEEPING THE PROMPT (Dev2,
 * 2026-11-14: "instead of keeping the full prompt, we keep the ids of the
 * prompt modules loaded in, so they can be reconstructed along with the date
 * and version control? that way we can keep it forever").
 *
 * A front-door prompt is ~95K tokens, most of it the same every text, so the
 * chat's history keeps, per model round, the ordered list of the modules
 * `turnPrompt.js` put together: each one's id, its length and a fingerprint of
 * its bytes. With the reply's `version.code` (the commit that ran) and the
 * builder inputs kept beside it (`at`, the time zone, the model), a rebuild
 * checks out THAT commit and runs ITS builders (Dev2, 2026-11-14: "make sure
 * we run the exact version from the day it ran"), then compares fingerprints
 * module by module, so a rebuilt prompt is proven the one that ran, or the
 * module that differs is named.
 *
 * Ids, lengths and fingerprints only: never a word of the prompt, so the
 * entry stays small and holds nothing the notes it was built from do not.
 */

/** FNV-1a over UTF-16 code units, 8 hex digits: a fingerprint, not a secret. */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * `[id, text]` pairs, in the order they are sent, to `{id, n, h}`; empty modules
 * are left out, so the list is exactly what was said.
 */
export function manifestOf(parts) {
  const out = [];
  for (const [id, text] of parts) {
    if (typeof text !== "string" || text === "") continue;
    out.push({ id, n: text.length, h: fingerprint(text) });
  }
  return out;
}

/** The modules two manifests disagree on, by id (a rebuild's check). */
export function manifestDiff(logged, rebuilt) {
  const key = (list) => new Map((list ?? []).map((m) => [m.id, `${m.n}:${m.h}`]));
  const a = key(logged), b = key(rebuilt);
  return [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id));
}

/**
 * Whether the person's own words ask for a bug to be filed (`apps/mcp/src/tools/reportGate.js`). A pure text check, so the
 * gateway's report gate and Tex's bug check read the same phrases. Plain CommonJS with no imports.
 */

/** "file a bug", "send a bug report to the team", "report this to the developers". */
const ASKS_TO_FILE = [
  /\b(?:file|send|submit|open|log|raise|write up|make)\b[^.?!\n]{0,30}?\b(?:bug|issue|ticket|bug report)\b/i,
  // "File the fact that you can't see your own diagram as a bug report" (Tex Devs group, 2026-10-26).
  /\b(?:file|submit|log|raise|report)\b[^?!\n]{0,160}?\b(?:as|into)\s+(?:an?\s+)?(?:bug|issue|ticket)s?\b/i,
  /\breport\s+(?:it|this|that)\b[^.?!\n]{0,20}\b(?:team|devs?|developers?|engineers?)\b/i,
];

/** Whether the person's own text, this turn, asks for a bug to be filed. */
function asksToFile(words) {
  const said = String(words ?? "");
  return ASKS_TO_FILE.some((pattern) => pattern.test(said));
}

module.exports = { asksToFile };

/** Small text helpers for note content: sizes, YAML scalars, visibility words. Moved verbatim out of `src/index.js`. */

/**
 * The size of what will actually be stored, in bytes.
 *
 * `String.length` counts UTF-16 units, so it undercounts every non-ASCII note
 * by up to two thirds — and the activity file's substance test is a byte
 * threshold. A note whose edit was entirely in Yoruba or in emoji must not be
 * measured on a different ruler from one written in English.
 */
export function byteSize(text) {
  return new TextEncoder().encode(typeof text === "string" ? text : "").byteLength;
}

export function normalizeVisibility(value) {
  return value;
}

export function frontmatterVisibility(content) {
  if (typeof content !== "string" || !content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const yaml = content.slice(3, end);
  const match = yaml.match(/^\s*(?:visibility|scope)\s*:\s*["']?(private|team|public)["']?\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

export function yamlString(value) {
  return JSON.stringify(String(value));
}

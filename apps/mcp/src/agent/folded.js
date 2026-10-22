/**
 * Words as a message and a quote of it are compared: a cut-off ending off,
 * then letters and digits only. A tapback's quote comes back through Messages
 * and the line, where quotes, apostrophes and emoji may come back changed
 * (2026-10-22); the letters do not.
 */
export function folded(text) {
  return String(text ?? "")
    .replace(/\s*(?:…|\.\.\.)\s*$/u, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

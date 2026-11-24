/**
 * Metric formulas, step one: text → tokens.
 *
 * Hand-written, one character at a time, so nothing in a formula is ever run
 * or turned into a pattern. A token is `{ type, raw, at, end, space }`:
 * - `word`: letters, digits and `_`, with a `-` inside it (`ai-spend`,
 *   `2026-runs`). A `-` with a space beside it is a minus.
 * - `num`: digits, with one optional `.digits` part; `value` is the number.
 * - `str`: text in "double" or 'single' quotes, no escapes; `value` is the text.
 * - `op`: `( ) . / + - * = !=`, with `value` the canonical sign; `−` reads as
 *   `-`, `×` as `*`, `÷` as `/` and `≠` as `!=`.
 * `space` is whether whitespace comes right before the token, which is how
 * `github/pull-requests.usd` (a reference) differs from `a / b` (a division).
 *
 * Pure and dependency-free: the gateway and the app both import it.
 */

const SIGNS = new Map([
  ["(", "("], [")", ")"], [".", "."], ["/", "/"], ["÷", "/"], ["+", "+"], ["-", "-"], ["−", "-"],
  ["*", "*"], ["×", "*"], ["=", "="], ["≠", "!="],
]);
const SPACE = new Set([" ", "\t", "\n", "\r"]);
const QUOTES = new Set(['"', "'"]);

const isDigit = (ch) => ch >= "0" && ch <= "9";
// ASCII letters, plus letters past Latin-1's signs, without U+2000–U+2BFF (dashes, quotes, arrows, maths)
// or the signs above. By code point rather than a Unicode-property pattern, which not every app runtime has.
const isNameChar = (ch) => {
  if (ch === undefined) return false;
  if (isDigit(ch) || ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) return true;
  const code = ch.charCodeAt(0);
  return code >= 0xc0 && !(code >= 0x2000 && code <= 0x2bff) && !SIGNS.has(ch) && code !== 0xfeff;
};
const isLetter = (ch) => ch !== undefined && ch !== "_" && !isDigit(ch) && isNameChar(ch);

const fail = (message, at) => ({ ok: false, error: { message, at } });

/** Text → `{ ok: true, tokens }` or `{ ok: false, error: { message, at } }`. */
export function lex(text) {
  const src = String(text);
  const tokens = [];
  let i = 0;
  let space = false;
  while (i < src.length) {
    const ch = src[i];
    if (SPACE.has(ch)) { space = true; i += 1; continue; }
    const at = i;
    if (QUOTES.has(ch)) {
      const close = src.indexOf(ch, i + 1);
      if (close < 0) return fail(`The quote that starts here is never closed.`, at);
      tokens.push({ type: "str", value: src.slice(i + 1, close), raw: src.slice(i, close + 1), at, end: close + 1, space });
      i = close + 1;
    } else if (ch === "!" && src[i + 1] === "=") {
      tokens.push({ type: "op", value: "!=", raw: "!=", at, end: i + 2, space });
      i += 2;
    } else if (SIGNS.has(ch)) {
      tokens.push({ type: "op", value: SIGNS.get(ch), raw: ch, at, end: i + 1, space });
      i += 1;
    } else if (isNameChar(ch)) {
      let j = i;
      let digitsOnly = true;
      for (;;) {
        const c = src[j];
        if (isNameChar(c)) {
          if (!isDigit(c)) digitsOnly = false;
          j += 1;
        } else if (c === "-" && j > i && isNameChar(src[j + 1]) && (!digitsOnly || isLetter(src[j + 1]))) {
          // `ai-spend` and `2026-runs` are names; `5-3` is a subtraction.
          digitsOnly = false;
          j += 1;
        } else break;
      }
      if (digitsOnly && src[j] === "." && isDigit(src[j + 1])) {
        j += 1;
        while (isDigit(src[j])) j += 1;
        const raw = src.slice(i, j);
        tokens.push({ type: "num", value: Number(raw), raw, at, end: j, space });
      } else {
        const raw = src.slice(i, j);
        tokens.push(digitsOnly ? { type: "num", value: Number(raw), raw, at, end: j, space } : { type: "word", raw, at, end: j, space });
      }
      i = j;
    } else {
      return fail(`There is a "${ch}" the formula does not use.`, at);
    }
    space = false;
  }
  return { ok: true, tokens };
}

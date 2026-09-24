/**
 * RFC 2047 encoded-word decoding for header values.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import { decodeBytes } from "./bytes";
import { base64Decode, quotedPrintableDecode } from "./transferEncoding";

/**
 * An encoded-word. Bounded and backtracking-free by construction:
 *
 * - the charset token is a negated class capped at 64 characters;
 * - the encoded text is a negated class — an encoded-word may contain neither
 *   whitespace nor `?` — capped at 2048;
 * - there is no nested quantifier anywhere, so there is no input for which the
 *   engine has more than one way to match a given prefix.
 */
const ENCODED_WORD = /=\?([^?\s]{1,64})\?([BbQq])\?([^?\s]{0,2048})\?=/g;

/**
 * Decode RFC 2047 encoded-words in a header value.
 *
 * Returns the value unchanged when there are none, which is the overwhelmingly
 * common case and costs one `indexOf`.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  // RFC 2047 §6.2: whitespace *between* two adjacent encoded-words is not part
  // of the text and is dropped, so a word split across a fold rejoins cleanly.
  // Linear: both sides of the alternation are literals.
  const joined = value.replace(/\?=[ \t]+=\?/g, "?==?");
  ENCODED_WORD.lastIndex = 0;
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes =
        encoding.toLowerCase() === "b" ? base64Decode(text) : quotedPrintableDecode(text, true);
      if (bytes === null) return whole;
      return decodeBytes(bytes, charset.split("*")[0]!);
    } catch {
      return whole;
    }
  });
}

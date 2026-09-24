/**
 * `Content-Type` / `Content-Disposition` parsing, including RFC 2231
 * continuations and extended values.
 *
 * Split out of `../mime.ts`; see that file's docblock for the parser's threat
 * model.
 */

import { decodeBytes } from "./bytes";
import { decodeEncodedWords } from "./encodedWords";

export interface ContentType {
  /** Lowercased `type/subtype`. */
  type: string;
  params: Record<string, string>;
}

/**
 * Split a structured header value on `;` while respecting quoted-strings, so a
 * `filename="a;b.txt"` does not become two parameters.
 */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === '"') quoted = false;
      else current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ";") {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/** Percent-decode an RFC 2231 extended value: `charset'lang'pct-encoded`. */
function decodeExtendedParam(value: string): string {
  const first = value.indexOf("'");
  if (first < 0) return value;
  const second = value.indexOf("'", first + 1);
  if (second < 0) return value;
  const charset = value.slice(0, first);
  const encoded = value.slice(second + 1);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%" && /^[0-9a-fA-F]{2}$/.test(encoded.slice(index + 1, index + 3))) {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(encoded.charCodeAt(index) & 0xff);
  }
  return decodeBytes(Uint8Array.from(bytes), charset);
}

/**
 * The bare token of a `Content-Disposition`, lowercased, or "".
 *
 * Separate from `parseContentType` because a disposition is not a media type:
 * it has no `/`, so the media-type validator can only ever reject it.
 *
 * `splitParams` is the load-bearing half: the two callers compare the result
 * against `"attachment"`, and a real header is `attachment; filename=…` — or
 * `attachment; size=42`, or `attachment;` with nothing after it. Comparing the
 * whole value is how both guards came to be dead in the first place.
 */
export function dispositionToken(value: string): string {
  const token = (splitParams(value)[0] || "").trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+$/.test(token) ? token : "";
}

/**
 * Parse a `Content-Type` / `Content-Disposition` value, resolving RFC 2231
 * continuations (`name*0`, `name*1`, …) and extended values (`name*`).
 */
export function parseContentType(value: string): ContentType {
  const pieces = splitParams(value);
  const type = (pieces[0] || "").trim().toLowerCase();

  // `Object.create(null)`, not `{}`: `rawKey` is attacker-controlled and is used
  // both as an `in` test and as an assignment target below. On a plain object
  // `"constructor" in plain` is true before anything is parsed, so the
  // first-wins rule would silently drop a real parameter, and `__proto__` is a
  // setter rather than a key. Neither is exploitable today — every consumer
  // reads a fixed name — but the same shape one file over crashed the gateway,
  // and a null-prototype bag costs nothing.
  const plain: Record<string, string> = Object.create(null);
  const extended = new Map<string, { parts: Map<number, string>; encoded: Set<number> }>();

  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const rawKey = piece.slice(0, eq).trim().toLowerCase();
    const rawValue = piece.slice(eq + 1).trim();
    if (!rawKey) continue;

    const continuation = /^([^*]+)\*(\d+)(\*?)$/.exec(rawKey);
    if (continuation) {
      const base = continuation[1]!;
      const index = Number(continuation[2]);
      if (!Number.isInteger(index) || index < 0 || index > 64) continue;
      let entry = extended.get(base);
      if (!entry) {
        entry = { parts: new Map(), encoded: new Set() };
        extended.set(base, entry);
      }
      entry.parts.set(index, rawValue);
      if (continuation[3]) entry.encoded.add(index);
      continue;
    }
    if (rawKey.endsWith("*")) {
      plain[rawKey.slice(0, -1)] = decodeExtendedParam(rawValue);
      continue;
    }
    if (!(rawKey in plain)) plain[rawKey] = decodeEncodedWords(rawValue);
  }

  for (const [base, entry] of extended) {
    const indices = [...entry.parts.keys()].sort((a, b) => a - b);
    let assembled = "";
    for (const index of indices) {
      const part = entry.parts.get(index)!;
      assembled += entry.encoded.has(index) ? decodeExtendedParam(part) : part;
    }
    // A continuation wins over a plain parameter of the same name: a sender
    // that supplies both is trying to make two readers disagree.
    plain[base] = assembled;
  }

  return { type: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "", params: plain };
}

/**
 * A CSS tokenizer for the website sanitizer (`./css.ts`).
 *
 * It follows CSS Syntax closely enough that what it calls a string, a URL or
 * a function is what a browser would, with one deliberate refusal: a
 * backslash outside a string is a `bad` token. An escape is the only way to
 * spell `url(` or `expression(` so that a name check misses it, and nothing a
 * site needs is written that way.
 */

export type CssToken =
  | { t: "ws" }
  | { t: "ident"; v: string }
  /** A name followed by `(`; the parenthesis is part of the token. */
  | { t: "function"; v: string }
  | { t: "at"; v: string }
  | { t: "hash"; v: string }
  | { t: "string"; v: string }
  /** `url(` with an unquoted address, the parentheses consumed. */
  | { t: "url"; v: string }
  | { t: "number"; v: string }
  | { t: "punct"; v: "{" | "}" | "(" | ")" | "[" | "]" | ";" | ":" | "," }
  | { t: "delim"; v: string }
  | { t: "bad" };

const PUNCT = new Set(["{", "}", "(", ")", "[", "]", ";", ":", ","]);

function isNameStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80
  );
}

function isName(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d;
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** Does an identifier start at `index`? */
function identStarts(css: string, index: number): boolean {
  const first = css.charCodeAt(index);
  if (first === 0x2d) {
    const second = css.charCodeAt(index + 1);
    return second === 0x2d || isNameStart(second);
  }
  return isNameStart(first);
}

function readName(css: string, index: number): number {
  let end = index;
  while (end < css.length && isName(css.charCodeAt(end))) end += 1;
  return end;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/;

export function tokenizeCss(css: string): CssToken[] {
  const tokens: CssToken[] = [];
  let index = 0;
  while (index < css.length) {
    const char = css[index]!;
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      if (tokens.at(-1)?.t !== "ws") tokens.push({ t: "ws" });
      continue;
    }
    if (isSpace(char)) {
      while (index < css.length && isSpace(css[index])) index += 1;
      if (tokens.at(-1)?.t !== "ws") tokens.push({ t: "ws" });
      continue;
    }
    if (char === '"' || char === "'") {
      const read = readString(css, index + 1, char);
      tokens.push(read.token);
      index = read.end;
      continue;
    }
    if (char === "\\") {
      tokens.push({ t: "bad" });
      index += 1;
      continue;
    }
    const number = /[\d.+-]/.test(char) ? NUMBER.exec(css.slice(index, index + 64)) : null;
    if (number !== null) {
      let end = index + number[0].length;
      if (css[end] === "%") end += 1;
      else if (identStarts(css, end)) end = readName(css, end);
      tokens.push({ t: "number", v: css.slice(index, end) });
      index = end;
      continue;
    }
    if (identStarts(css, index)) {
      const end = readName(css, index);
      const name = css.slice(index, end);
      if (css[end] === "(") {
        if (name.toLowerCase() === "url") {
          const read = readUrl(css, end + 1);
          if (read !== null) {
            tokens.push(read.token);
            index = read.end;
            continue;
          }
        }
        tokens.push({ t: "function", v: name });
        index = end + 1;
        continue;
      }
      tokens.push({ t: "ident", v: name });
      index = end;
      continue;
    }
    if (char === "@" && identStarts(css, index + 1)) {
      const end = readName(css, index + 1);
      tokens.push({ t: "at", v: css.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (char === "#" && isName(css.charCodeAt(index + 1))) {
      const end = readName(css, index + 1);
      tokens.push({ t: "hash", v: css.slice(index + 1, end) });
      index = end;
      continue;
    }
    if (PUNCT.has(char)) {
      tokens.push({ t: "punct", v: char as Extract<CssToken, { t: "punct" }>["v"] });
      index += 1;
      continue;
    }
    tokens.push({ t: "delim", v: char });
    index += 1;
  }
  return tokens;
}

function readString(
  css: string,
  start: number,
  quote: string,
): { token: CssToken; end: number } {
  let value = "";
  let index = start;
  while (index < css.length) {
    const char = css[index]!;
    if (char === quote) return { token: { t: "string", v: value }, end: index + 1 };
    if (char === "\n" || char === "\r" || char === "\f") {
      return { token: { t: "bad" }, end: index };
    }
    if (char === "\\") {
      const next = css[index + 1];
      if (next === undefined) {
        index += 1;
        continue;
      }
      if (next === "\n" || next === "\f") {
        index += 2;
        continue;
      }
      if (next === "\r") {
        index += css[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(index + 1, index + 7));
      if (hex !== null) {
        const code = Number.parseInt(hex[0], 16);
        value +=
          code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
            ? "\ufffd"
            : String.fromCodePoint(code);
        index += 1 + hex[0].length;
        if (isSpace(css[index])) index += css[index] === "\r" && css[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      value += next;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  // An unclosed string runs to the end of the sheet, as a browser reads it.
  return { token: { t: "string", v: value }, end: index };
}

/** `url(` followed by an unquoted address; `null` when the argument is quoted. */
function readUrl(css: string, start: number): { token: CssToken; end: number } | null {
  let index = start;
  while (isSpace(css[index])) index += 1;
  if (css[index] === '"' || css[index] === "'") return null;
  let value = "";
  while (index < css.length) {
    const char = css[index]!;
    if (char === ")") return { token: { t: "url", v: value }, end: index + 1 };
    if (isSpace(char)) {
      while (isSpace(css[index])) index += 1;
      if (css[index] === ")") return { token: { t: "url", v: value }, end: index + 1 };
      return { token: { t: "bad" }, end: index };
    }
    if (char === '"' || char === "'" || char === "(" || char === "\\") {
      return { token: { t: "bad" }, end: index + 1 };
    }
    value += char;
    index += 1;
  }
  return { token: { t: "bad" }, end: index };
}

/** CSS-escape a string's value, quoted. `<` is escaped so no sheet can spell `</style`. */
export function cssString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\" || char === "<" || char === ">" || char === "&" || code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(16)} `;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

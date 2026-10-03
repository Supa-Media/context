/**
 * The website stylesheet sanitizer: `styles.css.md`, `<style>` in a layout,
 * and `style="…"` attributes.
 *
 * A site's CSS is drawn on context.lc, the origin people are signed in on, so
 * it is rebuilt from tokens rather than filtered as text, and only what is
 * rebuilt reaches a page:
 *
 * - **Every selector is scoped** under the site's container. `:root`, `html`
 *   and `body` name the container itself, so the familiar way of writing
 *   colours as `:root` variables works; nothing can select the app around
 *   the site, and a selector that starts with a combinator is dropped.
 * - **Nothing loads.** `@import`, `@font-face` and every function outside a
 *   closed list are dropped with their declaration. `url()` survives only as
 *   a picture stored in the workspace, resolved by the caller to a `data:`
 *   URL. The one exception is a Google Fonts stylesheet, which is lifted out
 *   of the sheet into `fonts` for the page to load as the site already does
 *   for its own serif.
 * - **No escapes** outside strings, which is the one way to hide `url(` or
 *   `expression(` from a name check.
 * - **IDs are the sanitized HTML's**: `#about` selects `id="site-about"`,
 *   because `./html.ts` prefixes every id so a page cannot clobber a global
 *   the app reads.
 */

import { cssString, tokenizeCss, type CssToken } from "./cssTokens";

export const SITE_ID_PREFIX = "site-";
const MAX_CSS = 200_000;
const MAX_FONTS = 4;

export interface SiteCssOptions {
  /** The selector every rule is scoped under, e.g. `.ctx-site`. */
  scope: string;
  /** A relative picture name to a `data:image/…` URL, or null to drop it. */
  image?: (name: string) => string | null;
}

export interface SanitizedCss {
  css: string;
  /** Google Fonts stylesheets the sheet imported, normalized. */
  fonts: string[];
}

/** Functions a value may call. Nothing here can make a request. */
const FUNCTIONS = new Set([
  "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
  "color-mix", "light-dark", "calc", "min", "max", "clamp", "round", "mod", "rem",
  "abs", "sign", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "pow",
  "sqrt", "hypot", "log", "exp", "var", "env", "linear-gradient",
  "radial-gradient", "conic-gradient", "repeating-linear-gradient",
  "repeating-radial-gradient", "repeating-conic-gradient", "translate",
  "translatex", "translatey", "translatez", "translate3d", "scale", "scalex",
  "scaley", "scalez", "scale3d", "rotate", "rotatex", "rotatey", "rotatez",
  "rotate3d", "skew", "skewx", "skewy", "matrix", "matrix3d", "perspective",
  "blur", "brightness", "contrast", "drop-shadow", "grayscale", "hue-rotate",
  "invert", "opacity", "saturate", "sepia", "cubic-bezier", "steps", "linear",
  "repeat", "minmax", "fit-content", "inset", "circle", "ellipse", "polygon",
  "path", "rect", "xywh", "counter", "counters", "anchor", "anchor-size",
]);

/** Properties that once ran code somewhere. */
const BLOCKED_PROPERTIES = new Set(["behavior", "-ms-behavior", "-moz-binding", "binding"]);

const PROPERTY = /^(?:--[A-Za-z0-9_-]{1,64}|-?[A-Za-z][A-Za-z0-9-]{0,63})$/;

/** Value delimiters: `!important`, `font: 1em/1.4`, `calc(a + b * c)`. */
const VALUE_DELIMS = new Set(["!", "/", "*", "+", "-", "%", "."]);

/** Media and container query punctuation: `(width >= 40em)`. */
const PRELUDE_DELIMS = new Set([">", "<", "=", "/", "*", "+", "-", "."]);

/** Group rules whose block holds more rules, scoped like the top level. */
const GROUPS = new Set(["media", "supports", "container", "layer"]);

const KEYFRAMES = new Set(["keyframes", "-webkit-keyframes"]);

function serializeToken(token: CssToken): string {
  switch (token.t) {
    case "ws":
      return " ";
    case "ident":
    case "number":
      return token.v;
    case "function":
      return `${token.v}(`;
    case "at":
      return `@${token.v}`;
    case "hash":
      return `#${token.v}`;
    case "string":
      return cssString(token.v);
    case "punct":
      return token.v;
    case "delim":
      // A lone `<` is a comparison; spaced so no sheet can read `</`.
      return token.v === "<" ? " < " : token.v;
    case "url":
    case "bad":
      return "";
  }
}

function trim(tokens: CssToken[]): CssToken[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && tokens[start]!.t === "ws") start += 1;
  while (end > start && tokens[end - 1]!.t === "ws") end -= 1;
  return tokens.slice(start, end);
}

/** Split at a top-level punctuation mark, ignoring ones inside brackets. */
function splitTop(tokens: CssToken[], mark: "," | ";"): CssToken[][] {
  const parts: CssToken[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token.t === "function" || (token.t === "punct" && (token.v === "(" || token.v === "[" || token.v === "{"))) {
      depth += 1;
    } else if (token.t === "punct" && (token.v === ")" || token.v === "]" || token.v === "}")) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && token.t === "punct" && token.v === mark) {
      parts.push([]);
      continue;
    }
    parts.at(-1)!.push(token);
  }
  return parts;
}

function urlFromFunction(tokens: CssToken[], index: number): { value: string; end: number } | null {
  let cursor = index + 1;
  while (tokens[cursor]?.t === "ws") cursor += 1;
  const argument = tokens[cursor];
  if (argument?.t !== "string") return null;
  cursor += 1;
  while (tokens[cursor]?.t === "ws") cursor += 1;
  const close = tokens[cursor];
  if (close?.t !== "punct" || close.v !== ")") return null;
  return { value: argument.v, end: cursor };
}

/** A relative picture name: `logo.png`, `images/hero.webp`. Never a scheme or a host. */
function pictureName(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || /[\\\s"'()<>]/.test(value)) {
    return null;
  }
  return value.replace(/^\.\//, "").replace(/^\//, "");
}

function sanitizeValue(tokens: CssToken[], options: SiteCssOptions): string | null {
  let out = "";
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    switch (token.t) {
      case "bad":
      case "at":
        return null;
      case "url": {
        const name = pictureName(token.v);
        const data = name === null ? null : (options.image?.(name) ?? null);
        if (data === null || !isPictureData(data)) return null;
        out += `url(${cssString(data)})`;
        break;
      }
      case "function": {
        const name = token.v.toLowerCase();
        if (name === "url") {
          const read = urlFromFunction(tokens, index);
          if (read === null) return null;
          const picture = pictureName(read.value);
          const data = picture === null ? null : (options.image?.(picture) ?? null);
          if (data === null || !isPictureData(data)) return null;
          out += `url(${cssString(data)})`;
          index = read.end;
          break;
        }
        if (!FUNCTIONS.has(name)) return null;
        depth += 1;
        out += `${name}(`;
        break;
      }
      case "punct":
        if (token.v === "{" || token.v === "}" || token.v === ";" || token.v === "[" || token.v === "]") {
          // Brackets name grid lines; braces and semicolons never belong in a value.
          if (token.v === "[" || token.v === "]") {
            out += token.v;
            break;
          }
          return null;
        }
        if (token.v === "(") depth += 1;
        if (token.v === ")") {
          if (depth === 0) return null;
          depth -= 1;
        }
        out += token.v;
        break;
      case "delim":
        if (!VALUE_DELIMS.has(token.v)) return null;
        out += token.v;
        break;
      default:
        out += serializeToken(token);
    }
  }
  if (depth !== 0) return null;
  const value = out.trim();
  return value === "" ? null : value;
}

export function isPictureData(value: string): boolean {
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
}

/** `prop: value; …` with every declaration that does not survive dropped. */
function sanitizeDeclarationList(tokens: CssToken[], options: SiteCssOptions): string[] {
  const declarations: string[] = [];
  for (const part of splitTop(tokens, ";")) {
    const chunk = trim(part);
    if (chunk.length === 0) continue;
    // A nested rule (`&:hover { … }`) is not a declaration.
    if (chunk.some((token) => token.t === "punct" && (token.v === "{" || token.v === "}"))) continue;
    const name = chunk[0];
    if (name?.t !== "ident" || !PROPERTY.test(name.v)) continue;
    let cursor = 1;
    while (chunk[cursor]?.t === "ws") cursor += 1;
    const colon = chunk[cursor];
    if (colon?.t !== "punct" || colon.v !== ":") continue;
    const property = name.v.startsWith("--") ? name.v : name.v.toLowerCase();
    if (BLOCKED_PROPERTIES.has(property)) continue;
    const value = sanitizeValue(trim(chunk.slice(cursor + 1)), options);
    if (value === null) continue;
    declarations.push(`${property}: ${value}`);
  }
  return declarations;
}

/** One `style="…"` attribute's declarations, or null when none survive. */
export function sanitizeStyleAttribute(style: string, options: Omit<SiteCssOptions, "scope"> = {}): string | null {
  if (style.length > 4_000) return null;
  const declarations = sanitizeDeclarationList(tokenizeCss(style), { scope: "", ...options });
  return declarations.length === 0 ? null : declarations.join("; ");
}

function isBare(token: CssToken | undefined, name: string): boolean {
  return token?.t === "ident" && token.v.toLowerCase() === name;
}

/**
 * The compound that names the document: `html`, `body`, `:root`, or the
 * container's own class (a sheet written knowing it is scoped would otherwise
 * be scoped twice and match nothing); its length in tokens.
 */
function rootCompound(tokens: CssToken[], index: number, scope: string): number {
  const ends = (at: number) => {
    const next = tokens[at];
    return next === undefined || next.t === "ws" || (next.t === "delim" && (next.v === ">" || next.v === "+" || next.v === "~"));
  };
  if ((isBare(tokens[index], "html") || isBare(tokens[index], "body")) && ends(index + 1)) return 1;
  const colon = tokens[index];
  if (colon?.t === "punct" && colon.v === ":" && isBare(tokens[index + 1], "root") && ends(index + 2)) return 2;
  const dot = tokens[index];
  const scopeClass = scope.startsWith(".") ? scope.slice(1).toLowerCase() : null;
  if (scopeClass !== null && dot?.t === "delim" && dot.v === "." && isBare(tokens[index + 1], scopeClass) && ends(index + 2)) return 2;
  return 0;
}

function sanitizeSelector(raw: CssToken[], scope: string): string | null {
  const tokens = trim(raw);
  if (tokens.length === 0 || tokens.length > 200) return null;
  const first = tokens[0]!;
  if (first.t === "delim" && (first.v === ">" || first.v === "+" || first.v === "~")) return null;
  for (const token of tokens) {
    if (token.t === "bad" || token.t === "at" || token.t === "url") return null;
    if (token.t === "punct" && (token.v === "{" || token.v === "}" || token.v === ";")) return null;
    if (token.t === "delim" && (token.v === "&" || token.v === "<" || token.v === "\\")) return null;
    if (token.t === "function" && token.v.toLowerCase() === "url") return null;
  }
  // `html body > header` is the container's `> header`.
  let index = 0;
  for (;;) {
    const length = rootCompound(tokens, index, scope);
    if (length === 0) break;
    index += length;
    while (tokens[index]?.t === "ws") index += 1;
  }
  const rest = tokens
    .slice(index)
    .map((token) => (token.t === "hash" ? `#${SITE_ID_PREFIX}${token.v}` : serializeToken(token)))
    .join("")
    .trim();
  if (rest === "") return scope;
  return /^[>+~]/.test(rest) ? `${scope} ${rest}` : `${scope} ${rest}`;
}

function sanitizePrelude(tokens: CssToken[]): string | null {
  let out = "";
  let depth = 0;
  for (const token of tokens) {
    if (token.t === "bad" || token.t === "at" || token.t === "url" || token.t === "string") return null;
    if (token.t === "function") {
      const name = token.v.toLowerCase();
      if (name !== "selector" && !FUNCTIONS.has(name)) return null;
      depth += 1;
    }
    if (token.t === "punct") {
      if (token.v === "{" || token.v === "}" || token.v === ";" || token.v === "[" || token.v === "]") return null;
      if (token.v === "(") depth += 1;
      if (token.v === ")") {
        if (depth === 0) return null;
        depth -= 1;
      }
    }
    if (token.t === "delim" && !PRELUDE_DELIMS.has(token.v)) return null;
    out += serializeToken(token);
  }
  return depth === 0 ? out.trim() : null;
}

type Rule =
  | { kind: "at"; name: string; prelude: CssToken[]; block: CssToken[] | null }
  | { kind: "style"; prelude: CssToken[]; block: CssToken[] };

/** Split a token list into rules, each block's tokens kept unparsed. */
function parseRules(tokens: CssToken[]): Rule[] {
  const rules: Rule[] = [];
  let index = 0;
  const readBlock = (start: number): { block: CssToken[]; end: number } => {
    let depth = 1;
    let cursor = start;
    while (cursor < tokens.length) {
      const token = tokens[cursor]!;
      if (token.t === "punct" && token.v === "{") depth += 1;
      if (token.t === "punct" && token.v === "}") {
        depth -= 1;
        if (depth === 0) return { block: tokens.slice(start, cursor), end: cursor + 1 };
      }
      cursor += 1;
    }
    return { block: tokens.slice(start), end: tokens.length };
  };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.t === "ws" || (token.t === "punct" && (token.v === ";" || token.v === "}"))) {
      index += 1;
      continue;
    }
    const prelude: CssToken[] = [];
    let cursor = token.t === "at" ? index + 1 : index;
    let parens = 0;
    let ended: "block" | "semicolon" | "eof" = "eof";
    while (cursor < tokens.length) {
      const current = tokens[cursor]!;
      if (current.t === "function" || (current.t === "punct" && (current.v === "(" || current.v === "["))) parens += 1;
      if (current.t === "punct" && (current.v === ")" || current.v === "]")) parens = Math.max(0, parens - 1);
      if (parens === 0 && current.t === "punct" && current.v === "{") {
        ended = "block";
        break;
      }
      if (parens === 0 && current.t === "punct" && current.v === ";" && token.t === "at") {
        ended = "semicolon";
        break;
      }
      prelude.push(current);
      cursor += 1;
    }
    if (ended === "block") {
      const read = readBlock(cursor + 1);
      rules.push(
        token.t === "at"
          ? { kind: "at", name: token.v.toLowerCase(), prelude, block: read.block }
          : { kind: "style", prelude, block: read.block },
      );
      index = read.end;
      continue;
    }
    if (token.t === "at") rules.push({ kind: "at", name: token.v.toLowerCase(), prelude, block: null });
    index = cursor + 1;
  }
  return rules;
}

/** A Google Fonts stylesheet address, normalized, or null. */
export function googleFontsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "fonts.googleapis.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/css2" && url.pathname !== "/css")
  ) {
    return null;
  }
  url.hash = "";
  return url.toString();
}

function importedFont(prelude: CssToken[]): string | null {
  const tokens = trim(prelude);
  const first = tokens[0];
  if (first?.t === "string" || first?.t === "url") return googleFontsUrl(first.v);
  if (first?.t === "function" && first.v.toLowerCase() === "url") {
    const read = urlFromFunction(tokens, 0);
    return read === null ? null : googleFontsUrl(read.value);
  }
  return null;
}

function sanitizeRules(rules: Rule[], options: SiteCssOptions, fonts: string[], depth: number): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.kind === "style") {
      const selectors = splitTop(rule.prelude, ",")
        .map((selector) => sanitizeSelector(selector, options.scope))
        .filter((selector): selector is string => selector !== null);
      const declarations = sanitizeDeclarationList(rule.block, options);
      if (selectors.length === 0 || declarations.length === 0) continue;
      out.push(`${selectors.join(", ")} { ${declarations.join("; ")}; }`);
      continue;
    }
    if (rule.name === "import" && depth === 0) {
      const font = importedFont(rule.prelude);
      if (font !== null && !fonts.includes(font) && fonts.length < MAX_FONTS) fonts.push(font);
      continue;
    }
    if (rule.block === null) continue;
    if (GROUPS.has(rule.name) && depth < 4) {
      const prelude = sanitizePrelude(trim(rule.prelude));
      if (prelude === null) continue;
      const inner = sanitizeRules(parseRules(rule.block), options, fonts, depth + 1);
      if (inner.length === 0) continue;
      out.push(`@${rule.name}${prelude === "" ? "" : ` ${prelude}`} { ${inner.join(" ")} }`);
      continue;
    }
    if (KEYFRAMES.has(rule.name)) {
      const name = trim(rule.prelude);
      if (name.length !== 1 || name[0]!.t !== "ident") continue;
      const frames: string[] = [];
      for (const frame of parseRules(rule.block)) {
        if (frame.kind !== "style") continue;
        const stops = splitTop(frame.prelude, ",").map((stop) => trim(stop));
        if (!stops.every((stop) => stop.length === 1 && (stop[0]!.t === "number" ? /%$/.test(stop[0]!.v) : isBare(stop[0], "from") || isBare(stop[0], "to")))) {
          continue;
        }
        const declarations = sanitizeDeclarationList(frame.block, options);
        if (declarations.length === 0) continue;
        frames.push(`${stops.map((stop) => serializeToken(stop[0]!)).join(", ")} { ${declarations.join("; ")}; }`);
      }
      if (frames.length > 0) out.push(`@keyframes ${(name[0] as { v: string }).v} { ${frames.join(" ")} }`);
    }
    // `@font-face`, `@namespace`, `@page`, `@property` and anything newer: dropped.
  }
  return out;
}

/** Rebuild a stylesheet from tokens, scoped and with nothing that loads. */
export function sanitizeSiteCss(css: string, options: SiteCssOptions): SanitizedCss {
  if (css.length > MAX_CSS) return { css: "", fonts: [] };
  const fonts: string[] = [];
  const rules = sanitizeRules(parseRules(tokenizeCss(css)), options, fonts, 0);
  return { css: rules.join("\n"), fonts };
}

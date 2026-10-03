/**
 * The website HTML sanitizer: `layout.html.md`, named layouts and HTML pages.
 *
 * Site HTML is drawn inside the app on context.lc, where people are signed
 * in, so no markup a site writes is ever passed through. It is tokenized, and
 * a new document is written from the tokens that survive:
 *
 * - **Elements** come from a closed list of layout and text tags. Scripts,
 *   frames, forms, SVG, MathML, `<template>` and every raw-text element are
 *   dropped with their content; any other unknown tag is dropped and its text
 *   kept. `<style>` is lifted out for `./css.ts`, and a Google Fonts `<link>`
 *   for the page to load.
 * - **Attributes** come from a closed list per element. No event handler, no
 *   `srcset`, no `name`. Every value is decoded, checked and written back
 *   escaped and double-quoted, so the output has one parse in every browser.
 * - **Links** keep `http`, `https`, `mailto`, `tel`, in-page and relative
 *   addresses; any other scheme drops the attribute. `target` is `_blank` or
 *   nothing, and always carries `rel="noopener noreferrer"`.
 * - **Pictures** never load from anywhere: `src` must name a picture stored in
 *   the workspace, which the caller hands back as a `data:` URL.
 * - **IDs** are prefixed (`site-`), with the `#fragment` links and CSS that
 *   name them, so no element can clobber a global the app reads.
 *
 * The output is balanced: every element written is closed, and a stray end
 * tag is dropped, so a layout cannot close the container it is drawn in.
 * Sanitizing the output again returns it unchanged.
 */

import { decodeEntities, escapeHtml } from "./entities";
import { SITE_ID_PREFIX, googleFontsUrl, isPictureData, sanitizeStyleAttribute } from "./css";

export interface SiteHtmlOptions {
  /** A relative picture name to a `data:image/…` URL, or null to drop it. */
  image?: (name: string) => string | null;
}

export interface SanitizedHtml {
  html: string;
  /** The text of every `<style>` element, for the stylesheet sanitizer. */
  styles: string[];
  /** Google Fonts stylesheets linked with `<link rel="stylesheet">`. */
  fonts: string[];
}

const MAX_HTML = 300_000;
const MAX_DEPTH = 200;

const VOID = new Set(["br", "hr", "img", "wbr", "col"]);

const ELEMENTS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote",
  "br", "caption", "cite", "code", "col", "colgroup", "data", "dd", "del",
  "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img",
  "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strong", "sub", "summary",
  "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u",
  "ul", "var", "wbr",
]);

/** Dropped with everything inside them. */
const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed",
  "noframes", "noscript", "template", "svg", "math", "object", "embed",
  "applet", "frameset", "frame", "select", "audio", "video", "canvas",
  "plaintext",
]);

/** Elements whose content a browser reads as raw text, up to the end tag. */
const RAW_TEXT = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed",
  "noframes", "noscript", "plaintext",
]);

const GLOBAL_ATTRIBUTES = new Set(["id", "class", "title", "lang", "dir", "role", "hidden", "style"]);

const ELEMENT_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "target"]),
  img: new Set(["src", "alt", "width", "height", "loading", "decoding"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed", "type"]),
  li: new Set(["value"]),
  time: new Set(["datetime"]),
  data: new Set(["value"]),
  details: new Set(["open"]),
};

/** Attributes that name other elements by id, prefixed like `id`. */
const ID_REFERENCES = new Set(["aria-labelledby", "aria-describedby", "aria-controls"]);

const NUMERIC = new Set(["width", "height", "colspan", "rowspan", "span", "start", "value"]);

const ENUMERATED: Record<string, RegExp> = {
  dir: /^(?:ltr|rtl|auto)$/i,
  loading: /^(?:lazy|eager)$/i,
  decoding: /^(?:sync|async|auto)$/i,
  scope: /^(?:row|col|rowgroup|colgroup)$/i,
  type: /^[1aAiI]$/,
  target: /^_blank$/i,
};

const BOOLEAN = new Set(["hidden", "reversed", "open"]);

type Token =
  | { kind: "text"; text: string }
  | { kind: "start"; name: string; attributes: Array<[string, string]> }
  | { kind: "end"; name: string };

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z]/.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/** Tokenize `html`; raw-text elements arrive as one start token plus their text. */
function tokenize(html: string): { tokens: Token[]; raw: Map<number, string> } {
  const tokens: Token[] = [];
  const raw = new Map<number, string>();
  let index = 0;
  let text = "";
  const flush = () => {
    if (text !== "") tokens.push({ kind: "text", text: decodeEntities(text) });
    text = "";
  };
  while (index < html.length) {
    const char = html[index]!;
    if (char !== "<") {
      text += char;
      index += 1;
      continue;
    }
    if (html.startsWith("<!--", index)) {
      flush();
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[index + 1] === "!" || html[index + 1] === "?") {
      flush();
      const end = html.indexOf(">", index + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html[index + 1] === "/") {
      if (!isLetter(html[index + 2])) {
        flush();
        const end = html.indexOf(">", index + 2);
        index = end === -1 ? html.length : end + 1;
        continue;
      }
      const tag = readTag(html, index + 2);
      if (tag === null) break;
      flush();
      tokens.push({ kind: "end", name: tag.name });
      index = tag.end;
      continue;
    }
    if (!isLetter(html[index + 1])) {
      text += char;
      index += 1;
      continue;
    }
    const tag = readTag(html, index + 1);
    // A tag cut off by the end of the document is dropped, as a browser drops it.
    if (tag === null) break;
    flush();
    tokens.push({ kind: "start", name: tag.name, attributes: tag.attributes });
    index = tag.end;
    if (RAW_TEXT.has(tag.name)) {
      if (tag.name === "plaintext") {
        raw.set(tokens.length - 1, html.slice(index));
        index = html.length;
        break;
      }
      const close = new RegExp(`</${tag.name}(?=[\\s/>])`, "i");
      const match = close.exec(html.slice(index));
      const end = match === null ? html.length : index + match.index;
      raw.set(tokens.length - 1, html.slice(index, end));
      index = end;
    }
  }
  flush();
  return { tokens, raw };
}

function readTag(
  html: string,
  start: number,
): { name: string; attributes: Array<[string, string]>; end: number } | null {
  let index = start;
  while (index < html.length && !isSpace(html[index]) && html[index] !== "/" && html[index] !== ">") index += 1;
  const name = html.slice(start, index).toLowerCase();
  const attributes: Array<[string, string]> = [];
  for (;;) {
    while (isSpace(html[index]) || html[index] === "/") index += 1;
    if (index >= html.length) return null;
    if (html[index] === ">") return { name, attributes, end: index + 1 };
    const nameStart = index;
    index += 1;
    while (index < html.length && !isSpace(html[index]) && html[index] !== "/" && html[index] !== ">" && html[index] !== "=") {
      index += 1;
    }
    const attribute = html.slice(nameStart, index).toLowerCase();
    while (isSpace(html[index])) index += 1;
    let value = "";
    if (html[index] === "=") {
      index += 1;
      while (isSpace(html[index])) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, index + 1);
        if (end === -1) return null;
        value = html.slice(index + 1, end);
        index = end + 1;
      } else {
        const valueStart = index;
        while (index < html.length && !isSpace(html[index]) && html[index] !== ">") index += 1;
        value = html.slice(valueStart, index);
      }
    }
    if (!attributes.some(([existing]) => existing === attribute)) {
      attributes.push([attribute, decodeEntities(value)]);
    }
  }
}

/** Remove what a browser removes from a URL before reading its scheme. */
function urlText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000- \u007f]+$/g, "").replace(/^[\u0000- \u007f]+/g, "").replace(/[\t\n\r]/g, "");
}

/** A link a page may offer, or null. In-page anchors are prefixed like ids. */
export function safeSiteHref(raw: string): string | null {
  const value = urlText(raw);
  if (value === "" || value.length > 2_000) return null;
  if (value.startsWith("#")) return `#${SITE_ID_PREFIX}${value.slice(1)}`;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (scheme !== null) {
    return /^(?:https?|mailto|tel)$/i.test(scheme[1]!) ? value : null;
  }
  // `\\host` and `/\host` are read as `//host`; a relative path is never one.
  if (value.includes("\\")) return null;
  return value;
}

function prefixIds(value: string): string {
  return value
    .split(/\s+/)
    .filter((id) => id !== "")
    .map((id) => `${SITE_ID_PREFIX}${id}`)
    .join(" ");
}

function attributeValue(
  element: string,
  name: string,
  value: string,
  options: SiteHtmlOptions,
): string | null {
  if (name === "id") return /^[^\s]{1,100}$/.test(value) ? `${SITE_ID_PREFIX}${value}` : null;
  if (ID_REFERENCES.has(name)) return value.trim() === "" ? null : prefixIds(value);
  if (name === "style") return sanitizeStyleAttribute(value, options);
  if (name === "href") return safeSiteHref(value);
  if (name === "src") {
    if (isPictureData(value)) return value;
    const pictureName = urlText(value).replace(/^\.\//, "").replace(/^\//, "");
    if (pictureName === "" || /^[a-z][a-z0-9+.-]*:/i.test(pictureName) || pictureName.startsWith("/") || /[\\"'<>\s]/.test(pictureName)) {
      return null;
    }
    const data = options.image?.(pictureName) ?? null;
    return data !== null && isPictureData(data) ? data : null;
  }
  if (NUMERIC.has(name)) return /^-?\d{1,6}$/.test(value.trim()) ? value.trim() : null;
  const pattern = ENUMERATED[name];
  if (pattern !== undefined) return pattern.test(value.trim()) ? value.trim().toLowerCase() : null;
  if (BOOLEAN.has(name)) return "";
  if (element === "time" && name === "datetime") return value.slice(0, 100);
  return value.slice(0, 1_000);
}

function allowedAttribute(element: string, name: string): boolean {
  if (GLOBAL_ATTRIBUTES.has(name) || ID_REFERENCES.has(name)) return true;
  if (/^aria-[a-z]{1,30}$/.test(name)) return true;
  // `data-ctx-*` is the page's own: where its content and sections go.
  if (/^data-[a-z0-9-]{1,40}$/.test(name) && !name.startsWith("data-ctx")) return true;
  return ELEMENT_ATTRIBUTES[element]?.has(name) ?? false;
}

function writeStart(
  name: string,
  attributes: Array<[string, string]>,
  options: SiteHtmlOptions,
): string {
  let out = `<${name}`;
  for (const [attribute, raw] of attributes) {
    if (!allowedAttribute(name, attribute)) continue;
    const value = attributeValue(name, attribute, raw, options);
    if (value === null) continue;
    out += value === "" && BOOLEAN.has(attribute) ? ` ${attribute}` : ` ${attribute}="${escapeHtml(value)}"`;
  }
  if (name === "a" && attributes.some(([attribute, value]) => attribute === "target" && ENUMERATED.target!.test(value.trim()))) {
    out += ' rel="noopener noreferrer"';
  }
  return `${out}>`;
}

/** Rebuild `html` from the tokens that survive. */
export function sanitizeSiteHtml(html: string, options: SiteHtmlOptions = {}): SanitizedHtml {
  const styles: string[] = [];
  const fonts: string[] = [];
  if (html.length > MAX_HTML) return { html: "", styles, fonts };
  const { tokens, raw } = tokenize(html);
  const open: string[] = [];
  let out = "";
  /** Inside a dropped element: its name and nesting, until it closes. */
  let dropping: { name: string; depth: number } | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (dropping !== null) {
      if (token.kind === "start" && token.name === dropping.name && !RAW_TEXT.has(token.name)) dropping.depth += 1;
      if (token.kind === "end" && token.name === dropping.name) {
        dropping.depth -= 1;
        if (dropping.depth === 0) dropping = null;
      }
      continue;
    }
    if (token.kind === "text") {
      out += escapeHtml(token.text);
      continue;
    }
    if (token.kind === "start") {
      if (token.name === "style") {
        const text = raw.get(index);
        if (text !== undefined) styles.push(text);
      }
      if (token.name === "link") {
        const rel = token.attributes.find(([name]) => name === "rel")?.[1].trim().toLowerCase();
        const href = token.attributes.find(([name]) => name === "href")?.[1];
        const font = rel === "stylesheet" && href !== undefined ? googleFontsUrl(href) : null;
        if (font !== null && !fonts.includes(font) && fonts.length < 4) fonts.push(font);
        continue;
      }
      if (DROPPED_WITH_CONTENT.has(token.name)) {
        // A raw-text element's content was never tokenized; its end tag follows.
        dropping = { name: token.name, depth: 1 };
        continue;
      }
      if (!ELEMENTS.has(token.name) || open.length >= MAX_DEPTH) continue;
      out += writeStart(token.name, token.attributes, options);
      if (!VOID.has(token.name)) open.push(token.name);
      continue;
    }
    if (VOID.has(token.name) || !open.includes(token.name)) continue;
    while (open.length > 0) {
      const name = open.pop()!;
      out += `</${name}>`;
      if (name === token.name) break;
    }
  }
  while (open.length > 0) out += `</${open.pop()!}>`;
  return { html: out, styles, fonts };
}

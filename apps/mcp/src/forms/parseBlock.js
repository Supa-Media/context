import { FORM_FENCE_LANG, CONFIG_KEYS } from "./grammar.js";
import { normalizeConfig } from "./config.js";

/* ------------------------------- the fence ------------------------------- */

/**
 * Every ```form block in a note, parsed.
 *
 * Returns one entry per block in document order, each either `{ config }` or
 * `{ error }` — never both, and never a partially applied config. A note with
 * no form block returns an empty array, which is the overwhelmingly common
 * case and costs one `indexOf`.
 *
 * Blocks are found by scanning lines rather than with a regex over the whole
 * note, because a note legitimately contains other fenced blocks (including
 * ones *quoting* a form block in a tutorial) and the only honest way to know
 * which fence a line closes is to walk them in order.
 */
export function parseFormBlocks(text) {
  if (typeof text !== "string" || !text.includes(FORM_FENCE_LANG)) return [];
  const lines = text.split("\n");
  const blocks = [];
  let fence = null; // the open fence's marker, e.g. "```"
  let isForm = false;
  let body = [];
  let openedAt = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opener = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
    if (fence === null) {
      if (opener) {
        fence = opener[2][0].repeat(opener[2].length);
        isForm = opener[3].toLowerCase() === FORM_FENCE_LANG;
        body = [];
        openedAt = i;
      }
      continue;
    }
    // Inside a fence. It closes on a marker of the same character, at least as
    // long, with no info string.
    const closer = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(line);
    if (closer && closer[2][0] === fence[0] && closer[2].length >= fence.length) {
      if (isForm) blocks.push({ ...parseFormBody(body), line: openedAt + 1 });
      fence = null;
      isForm = false;
      body = [];
      continue;
    }
    if (isForm) body.push(line);
  }
  // An unclosed form fence is an error the author can see and fix, not a block
  // we quietly read to the end of the note.
  if (fence !== null && isForm) {
    blocks.push({ error: "the form block is never closed", line: openedAt + 1 });
  }
  return blocks;
}

/** Parse one block body into a config, or into the first reason it is not one. */
function parseFormBody(lines) {
  const raw = new Map();
  const fields = [];
  let inFields = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (inFields && /^\s+-\s/.test(line)) {
      const entry = parseInlineMap(line.replace(/^\s+-\s*/, ""));
      if (entry.error) return { error: `field ${fields.length + 1}: ${entry.error}` };
      fields.push(entry.map);
      continue;
    }

    const keyed = /^([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!keyed) return { error: `line ${i + 1} of the block is not "key: value"` };
    const key = keyed[1];
    const value = keyed[2].trim();
    if (!CONFIG_KEYS.has(key)) {
      return { error: `unknown key "${key}" (accepted: ${[...CONFIG_KEYS].join(", ")})` };
    }
    if (raw.has(key)) return { error: `"${key}" is set twice` };
    if (key === "fields") {
      if (value) return { error: '"fields" takes a list on the lines beneath it, not a value' };
      inFields = true;
      raw.set(key, true);
      continue;
    }
    inFields = false;
    raw.set(key, value);
  }

  return normalizeConfig(raw, fields);
}

/**
 * `{ name: summary, type: line, max: 120 }` → a map.
 *
 * A hand-rolled scanner rather than a regex, because a bracketed list may hold
 * commas and a quoted scalar may hold both commas and colons — and a regex that
 * gets that almost right is the kind of parser that accepts a form nobody can
 * round-trip.
 */
function parseInlineMap(source) {
  const text = source.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return { error: 'expected { key: value, … } on one line' };
  }
  const inner = text.slice(1, -1);
  const map = new Map();
  let i = 0;

  const skipSpace = () => {
    while (i < inner.length && /\s/.test(inner[i])) i++;
  };

  while (i < inner.length) {
    skipSpace();
    if (i >= inner.length) break;
    const keyStart = i;
    while (i < inner.length && /[a-z_]/.test(inner[i])) i++;
    const key = inner.slice(keyStart, i);
    if (!key) return { error: `unexpected "${inner[i]}"` };
    skipSpace();
    if (inner[i] !== ":") return { error: `"${key}" is missing its colon` };
    i++;
    skipSpace();

    let value;
    if (inner[i] === "[") {
      const end = inner.indexOf("]", i);
      if (end === -1) return { error: `the list after "${key}" is never closed` };
      const body = inner.slice(i + 1, end);
      i = end + 1;
      value = body
        .split(",")
        .map((part) => unquote(part.trim()))
        .filter((part) => part !== "");
      if (value.some((part) => part === null)) return { error: `the list after "${key}" has an unclosed quote` };
    } else if (inner[i] === '"') {
      const scanned = scanQuoted(inner, i);
      if (!scanned) return { error: `the value of "${key}" has an unclosed quote` };
      value = scanned.value;
      i = scanned.next;
    } else {
      const start = i;
      while (i < inner.length && inner[i] !== ",") i++;
      value = inner.slice(start, i).trim();
    }

    if (map.has(key)) return { error: `"${key}" is set twice` };
    map.set(key, value);
    skipSpace();
    if (i < inner.length) {
      if (inner[i] !== ",") return { error: `expected a comma after "${key}"` };
      i++;
    }
  }
  return { map };
}

function scanQuoted(source, at) {
  if (source[at] !== '"') return null;
  let out = "";
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "\\" && i + 1 < source.length) {
      out += source[i + 1];
      i++;
      continue;
    }
    if (source[i] === '"') return { value: out, next: i + 1 };
    out += source[i];
  }
  return null;
}

/** A bare or double-quoted scalar; `null` when the quoting is broken. */
function unquote(part) {
  if (!part.startsWith('"')) return part;
  const scanned = scanQuoted(part, 0);
  return scanned && scanned.next === part.length ? scanned.value : null;
}


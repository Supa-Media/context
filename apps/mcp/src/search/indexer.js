/**
 * The indexer half of the search format contract — everything that turns one
 * note's content into the shape CONTRACT.md pins, and everything that turns
 * that shape into (and back out of) the bytes stored at `.index/search-v1.json`.
 *
 * Scoring (`query.js`) and the sync loop (`maintain.js`) are separate modules;
 * this one owns field extraction, the in-memory Maps, and (de)serialization.
 * It never re-tokenizes on its own — `termsOf`/`tokenize` in `text.js` are the
 * one copy of that rule, so an indexer and a query parser that disagreed about
 * what a "term" is would produce an index that can never be hit.
 *
 * The in-memory shape uses `Map`, never a plain object keyed by attacker text:
 * a note path or a note word becomes a key here, and `"__proto__"` or
 * `"constructor"` as an object property name is prototype pollution waiting
 * for whoever reads the polluted object next. `parseIndex` in particular must
 * never do `obj[someParsedString] = …` — every parsed string lands as a `Map`
 * key or as the value of a fixed, literal property name.
 */

import { termsOf } from "./text.js";

const FIELD_ORDER = ["title", "headings", "tags", "body"];

/** A fresh, empty index — the shape CONTRACT.md's "In-memory shape" pins. */
export function emptyIndex() {
  return { version: 1, docs: new Map(), terms: new Map() };
}

// -- field extraction --------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;
const HEADING_LINE_RE = /^#{1,6}[ \t]+.*$/;
const HEADING_TEXT_RE = /^#{1,6}[ \t]+(.*)$/gm;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const MDLINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
const LINK_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `'x'` / `"x"` → `x`; anything else passed through trimmed. */
function unquote(raw) {
  const t = raw.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * `tags:` inside a frontmatter block, inline (`[a, b]` or a bare scalar) or as
 * a `- ` list on the following lines. Not a YAML parser — just this one key,
 * because that is all the contract asks for and a real parser is a dependency
 * this package does not take.
 */
function parseFrontmatterTags(frontmatterText) {
  if (!frontmatterText) return [];
  const lines = frontmatterText.split("\n");
  const keyIndex = lines.findIndex((line) => /^tags:\s*(.*)$/.test(line));
  if (keyIndex === -1) return [];
  const inline = lines[keyIndex].match(/^tags:\s*(.*)$/)[1].trim();
  if (inline) {
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline
        .slice(1, -1)
        .split(",")
        .map(unquote)
        .filter((tag) => tag.length > 0);
    }
    const tag = unquote(inline);
    return tag ? [tag] : [];
  }
  const tags = [];
  for (let i = keyIndex + 1; i < lines.length; i += 1) {
    const item = lines[i].match(/^\s*-\s+(.+?)\s*$/);
    if (!item) break;
    const tag = unquote(item[1]);
    if (tag) tags.push(tag);
  }
  return tags;
}

/** The folder a bucket path lives in ("" for a root-level note). */
function folderOf(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Resolve one link target against the folder of the note that named it,
 * normalizing `.`/`..` segments by hand rather than with `new URL(...)` —
 * the WHATWG parser's dot-segment removal is exactly the surprise
 * `store/index.js` documents guarding against, and here we want normalization
 * (not rejection), so the guard has to be our own. Returns `null` for a
 * scheme'd URL, a path that escapes the bucket root, or one that does not end
 * in `.md`.
 */
function resolveLink(folder, rawTarget) {
  if (!rawTarget || LINK_SCHEME_RE.test(rawTarget)) return null;
  const segments = [...folder.split("/"), ...rawTarget.split("/")];
  const stack = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null; // would escape the bucket root
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  const resolved = stack.join("/");
  return resolved.endsWith(".md") ? resolved : null;
}

/** Every resolved `.md` link target in `text`, deduplicated, order preserved. */
function extractLinks(text, folder) {
  const seen = new Set();
  const push = (resolved) => {
    if (resolved && !seen.has(resolved)) seen.add(resolved);
  };
  for (const m of text.matchAll(WIKILINK_RE)) {
    let target = m[1].trim();
    if (!target) continue;
    if (!target.endsWith(".md")) target += ".md";
    push(resolveLink(folder, target));
  }
  for (const m of text.matchAll(MDLINK_RE)) {
    push(resolveLink(folder, m[2].trim()));
  }
  return [...seen];
}

/**
 * Split one note into the disjoint fields CONTRACT.md's "Field extraction"
 * describes. Frontmatter and heading lines are removed from `body` — a term
 * is counted in exactly one field, never double-counted across them.
 *
 * @param {string} path note path, used for the filename-fallback title and to
 *   resolve relative links
 * @param {string} content raw Markdown
 * @returns {{title: string, headings: string, tags: string[], body: string,
 *   links: string[]}}
 */
export function extractFields(path, content) {
  const normalized = typeof content === "string" ? content.replace(/\r\n/g, "\n") : "";
  const fmMatch = normalized.match(FRONTMATTER_RE);
  const tags = fmMatch ? parseFrontmatterTags(fmMatch[1]) : [];
  const rest = fmMatch ? normalized.slice(fmMatch[0].length) : normalized;

  const headingTexts = [];
  for (const m of rest.matchAll(HEADING_TEXT_RE)) {
    const text = m[1].trim().replace(/[ \t]+#+$/, "").trim();
    headingTexts.push(text);
  }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const filenameTitle = basename.endsWith(".md") ? basename.slice(0, -3) : basename;
  const title = headingTexts.length > 0 ? headingTexts[0] : filenameTitle;
  const headings = headingTexts.join("\n");

  const body = rest
    .split("\n")
    .filter((line) => !HEADING_LINE_RE.test(line))
    .join("\n");

  const links = extractLinks(rest, folderOf(path));

  return { title, headings, tags, body, links };
}

// -- in-memory index -----------------------------------------------------

/** term → per-field token count, for one field's token list. */
function tallyField(tokens, fieldIndex, into) {
  for (const term of tokens) {
    let counts = into.get(term);
    if (!counts) {
      counts = [0, 0, 0, 0];
      into.set(term, counts);
    }
    counts[fieldIndex] += 1;
  }
}

/**
 * Index one note, replacing any existing entry for `path` — the old entry's
 * postings are removed first so a re-index never leaves stale term counts
 * behind.
 *
 * @param {ReturnType<typeof emptyIndex>} index
 * @param {string} path
 * @param {{etag: string, uploaded: string|null, content: string}} note
 */
export function addDoc(index, path, { etag, uploaded, content }) {
  if (index.docs.has(path)) removeDoc(index, path);

  const fields = extractFields(path, content);
  const tokensByField = [
    termsOf(fields.title),
    termsOf(fields.headings),
    termsOf(fields.tags.join(" ")),
    termsOf(fields.body),
  ];

  const counts = new Map();
  tokensByField.forEach((tokens, fieldIndex) => tallyField(tokens, fieldIndex, counts));

  for (const [term, tf] of counts) {
    let postings = index.terms.get(term);
    if (!postings) {
      postings = new Map();
      index.terms.set(term, postings);
    }
    postings.set(path, tf);
  }

  index.docs.set(path, {
    etag,
    uploaded: uploaded ?? null,
    title: fields.title,
    links: fields.links,
    len: {
      title: tokensByField[0].length,
      headings: tokensByField[1].length,
      tags: tokensByField[2].length,
      body: tokensByField[3].length,
    },
    rank: 0,
  });
}

/**
 * Remove one note and every posting that referenced it. A term left with no
 * postings is dropped entirely — an empty `Map` in `terms` is a leak, not a
 * zero.
 *
 * @param {ReturnType<typeof emptyIndex>} index
 * @param {string} path
 */
export function removeDoc(index, path) {
  if (!index.docs.has(path)) return;
  index.docs.delete(path);
  for (const [term, postings] of index.terms) {
    if (!postings.has(path)) continue;
    postings.delete(path);
    if (postings.size === 0) index.terms.delete(term);
  }
}

// -- (de)serialization -----------------------------------------------------

function byFirst(a, b) {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * The bucket-stored JSON, per CONTRACT.md's "Serialized shape": arrays of
 * pairs (never keyed objects — the same prototype-pollution rule as the
 * in-memory shape), with entries sorted deterministically so what changed
 * between two serializations is only ever what actually changed. Not
 * byte-identical across calls — `generatedAt` is stamped fresh each time —
 * so nothing may compare whole serializations for equality.
 *
 * @param {ReturnType<typeof emptyIndex>} index
 * @returns {string}
 */
export function serializeIndex(index) {
  const docs = [...index.docs.entries()].sort(byFirst).map(([path, doc]) => [
    path,
    {
      etag: doc.etag,
      uploaded: doc.uploaded,
      title: doc.title,
      links: [...doc.links],
      len: { ...doc.len },
      rank: doc.rank,
    },
  ]);
  const terms = [...index.terms.entries()].sort(byFirst).map(([term, postings]) => [
    term,
    [...postings.entries()].sort(byFirst).map(([path, tf]) => [path, [...tf]]),
  ]);
  return JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    docs,
    terms,
  });
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate and copy one `docs` entry; `null` on any shape mismatch. */
function readDocEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [path, doc] = entry;
  if (typeof path !== "string" || !isPlainObject(doc)) return null;
  if (typeof doc.etag !== "string") return null;
  if (typeof doc.uploaded !== "string" && doc.uploaded !== null) return null;
  if (typeof doc.title !== "string") return null;
  if (!Array.isArray(doc.links) || doc.links.some((link) => typeof link !== "string")) return null;
  if (!isPlainObject(doc.len)) return null;
  if (!FIELD_ORDER.every((field) => isFiniteNumber(doc.len[field]))) return null;
  if (!isFiniteNumber(doc.rank)) return null;
  return {
    path,
    doc: {
      etag: doc.etag,
      uploaded: doc.uploaded,
      title: doc.title,
      links: [...doc.links],
      len: {
        title: doc.len.title,
        headings: doc.len.headings,
        tags: doc.len.tags,
        body: doc.len.body,
      },
      rank: doc.rank,
    },
  };
}

/** Validate and copy one `terms` entry; `null` on any shape mismatch. */
function readTermEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [term, postings] = entry;
  if (typeof term !== "string" || !Array.isArray(postings)) return null;
  const postingMap = new Map();
  for (const posting of postings) {
    if (!Array.isArray(posting) || posting.length !== 2) return null;
    const [path, tf] = posting;
    if (typeof path !== "string") return null;
    if (!Array.isArray(tf) || tf.length !== 4 || !tf.every(isFiniteNumber)) return null;
    postingMap.set(path, [...tf]);
  }
  return { term, postings: postingMap };
}

/**
 * The inverse of `serializeIndex`. Never throws and never returns a
 * partially-valid index — anything it cannot fully validate (not a string,
 * unparseable JSON, wrong version, a malformed doc or posting anywhere) comes
 * back `null`, and the caller rebuilds. Every parsed string lands as a `Map`
 * key, never as a property name on a plain object, so `"__proto__"` as a doc
 * path or `"constructor"` as a term is inert here.
 *
 * @param {string} text
 * @returns {ReturnType<typeof emptyIndex>|null}
 */
export function parseIndex(text) {
  if (typeof text !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!Array.isArray(parsed.docs) || !Array.isArray(parsed.terms)) return null;

  const docs = new Map();
  for (const entry of parsed.docs) {
    const read = readDocEntry(entry);
    if (!read) return null;
    docs.set(read.path, read.doc);
  }

  const terms = new Map();
  for (const entry of parsed.terms) {
    const read = readTermEntry(entry);
    if (!read) return null;
    terms.set(read.term, read.postings);
  }

  return { version: 1, docs, terms };
}

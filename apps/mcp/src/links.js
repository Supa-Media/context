/**
 * Links between notes, and how they survive a move.
 *
 * ## The rule this exists for
 *
 * **A reference follows what it points at.** Renaming or moving a note rewrites
 * every link to it, everywhere the caller can see, by default and without being
 * asked. A brain whose links rot the first time somebody tidies a folder is a
 * brain people stop tidying; every note in it is also an Obsidian note, where
 * this is the behaviour people already have.
 *
 * Nothing here talks to a store. It is text in, text out, so the interesting
 * part — resolution and re-expression — is testable without a bucket, and the
 * part that writes (`rewriteReferences` in `index.js`) has nothing in it but
 * the walk.
 *
 * ## What counts as a link
 *
 * Two forms, because those are the two a Context bucket actually contains:
 *
 *   - `[[folder/note]]`, `[[note|alias]]`, `[[note#heading]]`, `![[note]]` —
 *     Obsidian's wikilinks, which is what every agent writing into these
 *     buckets emits.
 *   - `[label](folder/note.md)` — CommonMark inline links, which is what
 *     everything else emits.
 *
 * Reference definitions (`[id]: target`) are deliberately not handled. They are
 * absent from these buckets, and a rewriter that half-understands a form is
 * worse than one that leaves it alone: the unhandled half goes stale silently
 * while the handled half looks maintained.
 *
 * **Code is not rewritten.** A fenced block or a code span containing
 * `[[example]]` is documentation *about* a link, and rewriting it corrupts an
 * example — this repository's own notes are full of them. `codeRanges` masks
 * both before anything else runs.
 *
 * ## Three shapes of target, and each is re-expressed as it was written
 *
 *   - **relative** — `../../2-products/x/overview`, resolved against the
 *     referring note's own folder. This is the shape the workspace's notes use,
 *     and the one in the bug report that started this.
 *   - **rooted** — `1-projects/x/overview`, resolved from the bucket root.
 *   - **bare** — `overview`, resolved by name across the bucket.
 *
 * A link written relative stays relative, and a link written rooted stays
 * rooted, because the alternative is a move that silently reformats notes it
 * was not asked to touch — a diff nobody asked for, in a file the customer also
 * opens in Obsidian and syncs to their own machine. **Relative is also the
 * shape that has to be recomputed rather than substituted**: when a folder
 * moves, a link *inside* it that points *outside* it has a different number of
 * `../` from its new home, and a rewriter that only swapped paths would leave
 * every one of them broken while reporting success.
 *
 * ## A bare link is rewritten only when it is unambiguous
 *
 * `[[overview]]` in a bucket with nine `overview.md` files resolves by a rule
 * (Obsidian's shortest-path-wins) that this module does not implement and must
 * not guess at. So a bare link is rewritten only when exactly one note in the
 * bucket carries that name and it is the one that moved. Otherwise it is left
 * exactly as written: a link that still resolves the way it always did beats a
 * link this code decided the meaning of.
 */

/* ------------------------------- scanning -------------------------------- */

/**
 * The spans of `text` that are code, and therefore not links.
 *
 * Fenced blocks first (``` and ~~~, any length ≥ 3, closed by a fence of the
 * same character and at least the same length, or by the end of the document),
 * then inline spans on the lines that are left. Both are CommonMark's rules
 * reduced to what a Markdown note in a bucket actually uses — this is not a
 * parser, and it does not need to be: over-masking costs one un-rewritten link,
 * and the failure it exists to prevent is corrupting somebody's code sample.
 */
export function codeRanges(text) {
  const ranges = [];
  let offset = 0;
  let fence = null; // { char, length, start }

  for (const line of text.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (opener) {
        fence = { char: opener[1][0], length: opener[1].length, start: offset };
      }
    } else if (
      opener &&
      opener[1][0] === fence.char &&
      opener[1].length >= fence.length
    ) {
      ranges.push([fence.start, offset + line.length]);
      fence = null;
    }
    offset += line.length + 1;
  }
  // An unterminated fence runs to the end of the document, which is what every
  // Markdown renderer does with one and what makes a half-written note safe.
  if (fence !== null) ranges.push([fence.start, text.length]);

  // Inline spans, outside the fenced ranges. A run of N backticks closes on the
  // next run of exactly N.
  const spans = /(`+)(?:[^`]|(?!\1)`)*?\1/g;
  for (const match of text.matchAll(spans)) {
    const start = match.index;
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    ranges.push([start, start + match[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

const WIKILINK = /(!?)\[\[([^\]\n]+)\]\]/g;
/*
  `[label](target)`, where the target is either `<…>` or a run with no
  whitespace and no closing paren, optionally followed by a title. Deliberately
  not a balanced-paren matcher: a target containing `)` has to be written
  `<…>` to be a link at all in most renderers, and pretending otherwise is how
  a rewriter eats the rest of a paragraph.
*/
const INLINE = /\[([^\]\n]*)\]\((<[^>\n]*>|[^\s()]*)\s*(?:"[^"\n]*"|'[^'\n]*')?\)/g;

/**
 * Every link in `text`, in document order, with the span of its *target*.
 *
 * The span is the target and not the whole link, so a rewrite replaces a path
 * and leaves the label, the alias, the embed marker and the anchor exactly as
 * the person wrote them.
 */
export function parseLinks(text) {
  const skip = codeRanges(text);
  const inCode = (index) => skip.some(([from, to]) => index >= from && index < to);
  const found = [];

  for (const match of text.matchAll(WIKILINK)) {
    if (inCode(match.index)) continue;
    const inner = match[2];
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    // `[[` plus the embed marker's width.
    const start = match.index + match[1].length + 2;
    found.push({ kind: "wiki", target, start, end: start + target.length });
  }

  for (const match of text.matchAll(INLINE)) {
    if (inCode(match.index)) continue;
    const raw = match[2];
    const bracketed = raw.startsWith("<") && raw.endsWith(">");
    const target = bracketed ? raw.slice(1, -1) : raw;
    const start = match.index + match[1].length + 3 + (bracketed ? 1 : 0);
    found.push({ kind: "inline", target, start, end: start + target.length });
  }

  return found.sort((a, b) => a.start - b.start);
}

/* ------------------------------ resolution ------------------------------- */

/** A scheme, a protocol-relative URL, or a mail address: not ours to touch. */
function isExternal(target) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

/**
 * Split a target into the part that names a file and the part that does not.
 *
 * `note#heading`, `note#^block-id`. The anchor is carried through a rewrite
 * untouched: where somebody was pointing *inside* a note is not something a
 * move knows anything about.
 */
function splitAnchor(target) {
  const hash = target.indexOf("#");
  if (hash === -1) return { file: target, anchor: "" };
  return { file: target.slice(0, hash), anchor: target.slice(hash) };
}

/** `a/b/c.md` → `a/b`; a note at the root → `""`. */
export function dirOf(path) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Apply `.` and `..` to a path, or answer `null` if it escapes the bucket.
 *
 * Escaping is refused rather than clamped. A link that walks above the root
 * does not resolve to anything, and turning it into a root-relative path would
 * invent a target the person never wrote — which, in a module that then goes on
 * to *write files*, is the difference between a broken link and a wrong one.
 */
export function normalizeSegments(segments) {
  const out = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out;
}

/** The three shapes described in the module comment. */
export function styleOf(file) {
  if (file.startsWith("./") || file.startsWith("../")) return "relative";
  return file.includes("/") ? "rooted" : "bare";
}

/**
 * The note a link points at, or `null` for anything this module will not touch.
 *
 * `byName` maps a note's basename (without `.md`) to every path carrying it,
 * and is only consulted for a bare target — see the module comment for why an
 * ambiguous one resolves to nothing rather than to a guess.
 */
export function resolveLink(link, fromPath, byName) {
  const target = link.target.trim();
  if (target === "" || target.startsWith("#") || isExternal(target)) return null;

  const { file } = splitAnchor(target);
  if (file === "") return null;

  const decoded = link.kind === "inline" ? safeDecode(file) : file;
  const style = styleOf(decoded);

  if (style === "bare") {
    const name = decoded.replace(/\.md$/, "");
    const candidates = byName?.get(name);
    return candidates?.length === 1 ? candidates[0] : null;
  }

  const base = style === "relative" ? dirOf(fromPath).split("/") : [];
  const segments = normalizeSegments([...base, ...decoded.split("/")]);
  if (segments === null || segments.length === 0) return null;

  const path = segments.join("/");
  /*
    A wikilink omits the extension; an inline link usually carries it. Anything
    already carrying a *different* extension is an attachment — an image, a PDF
    — and is resolved as written rather than having `.md` bolted onto it.
  */
  if (path.endsWith(".md")) return path;
  return /\.[a-z0-9]{1,8}$/i.test(path) ? path : `${path}.md`;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ---------------------------- re-expression ------------------------------ */

/** The path from one folder to another note, as `../../x/y.md`. */
export function relativePath(fromDir, toPath) {
  const from = fromDir === "" ? [] : fromDir.split("/");
  const to = toPath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
    shared += 1;
  }
  const up = new Array(from.length - shared).fill("..");
  const down = to.slice(shared);
  return [...up, ...down].join("/");
}

/**
 * Write `targetPath` the way the original link was written.
 *
 * Style is preserved, the `.md` is dropped for a wikilink and kept for an
 * inline one, and an inline target that would otherwise need quoting is
 * percent-encoded.
 *
 * `referrerPath` is where the referring note is **now**, which is what a
 * relative link has to be measured from after a folder move.
 */
export function expressLink(link, referrerPath, targetPath) {
  const { file: original, anchor } = splitAnchor(link.target.trim());
  const written = link.kind === "inline" ? safeDecode(original) : original;
  const style = styleOf(written);

  let file;
  if (style === "bare") {
    file = targetPath.slice(targetPath.lastIndexOf("/") + 1);
  } else if (style === "rooted") {
    file = targetPath;
  } else {
    const relative = relativePath(dirOf(referrerPath), targetPath);
    /*
      Two notes in the same folder produce a bare relative path, which would
      read as a *bare* link on the way back in and resolve by name instead of by
      position. `./` is what keeps that round trip honest, and is also kept when
      the person wrote one.
    */
    const needsDot = !relative.startsWith("..") && (!relative.includes("/") || written.startsWith("./"));
    file = needsDot ? `./${relative}` : relative;
  }

  if (link.kind === "wiki") return `${file.replace(/\.md$/, "")}${anchor}`;
  return `${encodeTarget(file)}${anchor}`;
}

/**
 * Percent-encode the characters that would end an inline link early.
 *
 * Not `encodeURIComponent`, which would eat the slashes that make it a path.
 * Spaces, parentheses and angle brackets are the ones that actually break the
 * grammar; everything else in a bucket path is already safe.
 */
function encodeTarget(file) {
  return file.replace(/[ ()<>]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/* -------------------------------- rewrite -------------------------------- */

/**
 * Rewrite every link in one note so it still points where it pointed.
 *
 * `fromPath` is where the note was when its links were written and `toPath` is
 * where it is now — the same string for a note that did not itself move.
 * **Both are needed even when they are equal**, and when they differ this is
 * the whole job: a note carried along by a folder move keeps every link it had,
 * and every relative one of them now needs a different number of `../`.
 *
 * `renames` maps a moved note's old path to its new one. A link resolving to a
 * path that is not in it is still re-expressed when the *referrer* moved, and
 * otherwise left byte-identical.
 *
 * Returns `null` when nothing changed, so a caller can skip the write rather
 * than stamp a new etag and a `.history/` entry on an unchanged file — and
 * otherwise the new text with the number of targets it moved, because the count
 * is what a move reports back and deriving it by diffing afterwards would be a
 * second, disagreeing implementation of "what changed".
 */
export function rewriteLinks(text, { fromPath, toPath, renames, byName }) {
  const links = parseLinks(text);
  if (links.length === 0) return null;

  let out = "";
  let cursor = 0;
  let changed = 0;

  for (const link of links) {
    const resolved = resolveLink(link, fromPath, byName);
    if (resolved === null) continue;
    const destination = renames.get(resolved) ?? resolved;
    // The referrer stayed put and the target stayed put: nothing to say.
    if (destination === resolved && fromPath === toPath) continue;

    const replacement = expressLink(link, toPath, destination);
    if (replacement === link.target) continue;

    out += text.slice(cursor, link.start) + replacement;
    cursor = link.end;
    changed += 1;
  }

  return changed === 0 ? null : { text: out + text.slice(cursor), changed };
}

/**
 * Basename → every path carrying it, for resolving bare links.
 *
 * Built once per operation over the note keys the caller can see, and handed to
 * every `rewriteLinks` call: a name that is ambiguous is ambiguous for the whole
 * bucket, not per note.
 */
export function indexByName(paths) {
  const byName = new Map();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const existing = byName.get(name);
    if (existing) existing.push(path);
    else byName.set(name, [path]);
  }
  return byName;
}

/**
 * Links between notes, and how they survive a move — the app's copy.
 *
 * **The gateway has its own, at `apps/mcp/src/links.js`, and they must agree.**
 *
 * Two copies, and the boundary that forces it is not the one you would guess.
 * The control plane *can* reach into the gateway — `fileOps.ts` already imports
 * `../../../mcp/src/search/*.js` — so a first version of this comment claimed
 * the duplication was structural on that side, and it was wrong. What actually
 * forces it is the other two edges:
 *
 *   - **The gateway cannot import this package.** It is the piece customers
 *     self-host, dependency-free by rule, and
 *     `scripts/check-gateway-imports.mjs` enforces that every specifier in it
 *     is relative.
 *   - **The mobile app cannot import the gateway.** Metro is configured with
 *     `sharedPackages: ["@context/shared"]`, so this package is the sanctioned
 *     way anything reaches the app's bundle, and the console's editor needs
 *     this engine to draw a wikilink as a link.
 *
 * The control plane then takes *this* copy rather than the gateway's, which is
 * a choice and worth saying: it puts the two halves of the app — a rename made
 * through the console, and a link rendered by the console — provably on one
 * engine.
 *
 * The repository's answer to a rule with a copy on each side of a boundary is
 * not a comment asking for care. It is a test that runs both over one corpus
 * and fails when they disagree: `apps/convex/__tests__/linkParity.test.ts`,
 * the same shape as `consoleVisibility.test.ts` pinning the console's tier
 * logic against `scopeForRole`.
 *
 * Everything below is a port, not a redesign. **Read the gateway's file for the
 * reasoning** — why the three target styles are preserved rather than
 * normalised, why a bare link is only rewritten when one note answers to the
 * name, why code is masked first, and why a relative link is recomputed rather
 * than substituted. Repeating it here would give the argument two copies too,
 * and they would drift the way the code would.
 */

/** Where a link sits in a note, and what it points at. */
export interface Link {
  kind: "wiki" | "inline";
  /**
   * Is this an embed (`![[note]]`, `![alt](note.md)`) rather than a plain link?
   *
   * The parser has always known — the `!` is group 1 of the wikilink pattern —
   * and used to throw it away, because a rewrite replaces the target and never
   * the marker. It is kept now because a reader has to distinguish them: an
   * embed is what puts a drawing or an image *inside* the note it is read from,
   * so "what does this note contain" cannot be answered without it.
   */
  embed: boolean;
  /** The raw target as written, alias and label already stripped. */
  target: string;
  /** The span of the target itself, so a rewrite replaces only the path. */
  start: number;
  end: number;
}

/**
 * One reference as a reader sees it. `definition` is `[id]: target`, reported
 * by `extractReferences` only; `parseLinks` and `rewriteLinks` never see it.
 * `fragment` is the anchor with its `#` (empty for an external target); `style`
 * is the written shape of the file part, `null` when there is no file to shape.
 */
export interface LinkOccurrence extends Omit<Link, "kind"> {
  kind: "wiki" | "inline" | "definition";
  fragment: string;
  style: LinkStyle | null;
}

/** What a reference points at, and why it did not resolve when it did not. */
export type LinkResolution =
  | { state: "resolved"; path: string }
  | { state: "missing" | "ambiguous" | "unknown" | "invalid" | "unsupported" | "external" };

/**
 * `byName` is `indexByName`'s map. `paths`, when the caller has the full list
 * of notes, is what separates `missing` from `unknown`.
 */
export interface LinkCatalog {
  byName?: ReadonlyMap<string, string[]>;
  paths?: ReadonlySet<string>;
}

/** The three shapes a target can be written in. */
export type LinkStyle = "relative" | "rooted" | "bare";

export interface RewriteOptions {
  /** Where the referring note was when its links were written. */
  fromPath: string;
  /** Where the referring note is now — the same string if it did not move. */
  toPath: string;
  /** Every moved note, old path to new. */
  renames: ReadonlyMap<string, string>;
  /** Basename to every path carrying it, for bare links. See `indexByName`. */
  byName?: ReadonlyMap<string, string[]>;
}

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
 *
 * Written out rather than left to a regex for the reason the gateway's copy
 * gives at length: the inline span and the membership test were both quadratic
 * in the length of a note, and nothing caps the text that arrives here. This
 * copy runs in the console's editor, in the viewer's own browser, where the
 * cost was a frozen tab. `apps/convex/__tests__/linkParity.test.ts` holds the
 * two copies to one corpus, and `apps/mcp/test/linkScanCost.test.mjs` holds
 * the gateway's to the regexes these replaced.
 */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let offset = 0;
  let fence: { char: string; length: number; start: number } | null = null;

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

  // Inline spans, outside the fenced ranges. An opening run of `k` backticks
  // closes at the first position after it carrying `k` or more, and `k` counts
  // down from the whole run's length.
  const runs = backtickRuns(text);
  if (runs.length > 0) {
    const longestAfter: number[] = new Array(runs.length);
    let longest = 0;
    for (let r = runs.length - 1; r >= 0; r -= 1) {
      longest = Math.max(longest, runs[r].length);
      longestAfter[r] = longest;
    }
    // A snapshot, so the spans pushed below cannot move this cursor.
    const fenced = within(ranges.slice());
    let at = 0; // the run holding the position being tried
    let position = runs[0].start;
    while (at < runs.length) {
      if (position >= runs[at].start + runs[at].length) {
        at += 1;
        if (at === runs.length) break;
        position = runs[at].start;
        continue;
      }
      const span = closingSpan(runs, at, position, longestAfter);
      if (span === null) {
        position += 1;
        continue;
      }
      if (!fenced(position)) ranges.push([position, span.end]);
      // Where the regex's lastIndex would land: past the whole match.
      position = span.end;
      while (at < runs.length && position >= runs[at].start + runs[at].length) at += 1;
      if (at === runs.length) break;
      if (position < runs[at].start) position = runs[at].start;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

interface BacktickRun {
  start: number;
  length: number;
}

/** The maximal runs of backticks in `text`, in order. */
function backtickRuns(text: string): BacktickRun[] {
  const runs: BacktickRun[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "`") continue;
    const start = i;
    while (i < text.length && text[i] === "`") i += 1;
    runs.push({ start, length: i - start });
    i -= 1;
  }
  return runs;
}

/**
 * The span an inline code opener at `position` closes, or `null`.
 *
 * `at` is the run holding `position`. The opener is the backticks from
 * `position` to the end of that run, and shorter openers are tried after
 * longer ones, which is what `(`+)` backtracking did.
 */
function closingSpan(
  runs: readonly BacktickRun[],
  at: number,
  position: number,
  longestAfter: readonly number[],
): { end: number } | null {
  const available = runs[at].start + runs[at].length - position;
  for (let k = available; k >= 1; k -= 1) {
    const after = position + k;
    // Inside the opener's own run first: what is left of it can close the span.
    const leftHere = runs[at].start + runs[at].length - after;
    if (leftHere >= k) return { end: after + k };
    if (at + 1 < runs.length && longestAfter[at + 1] >= k) {
      for (let r = at + 1; r < runs.length; r += 1) {
        if (runs[r].length >= k) return { end: runs[r].start + k };
      }
    }
  }
  return null;
}

/**
 * `index => is it inside one of `ranges``, for indices asked in increasing
 * order. Ranges are sorted by start but may overlap — an inline span can begin
 * before a fence opener and end after it — so this carries the furthest end
 * seen rather than comparing against one range.
 */
function within(ranges: readonly [number, number][]): (index: number) => boolean {
  let next = 0;
  let furthest = -1;
  return (index: number) => {
    while (next < ranges.length && ranges[next][0] <= index) {
      furthest = Math.max(furthest, ranges[next][1]);
      next += 1;
    }
    return index < furthest;
  };
}

/**
 * Every link in `text`, in document order, with the span of its *target*.
 *
 * The span is the target and not the whole link, so a rewrite replaces a path
 * and leaves the label, the alias, the embed marker and the anchor exactly as
 * the person wrote them.
 */
export function parseLinks(text: string): Link[] {
  const skip = codeRanges(text);
  const found: Link[] = [];

  const wikiInCode = within(skip);
  for (const link of wikilinkMatches(text)) {
    if (wikiInCode(link.index)) continue;
    const inner = link.inner;
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    // `[[` plus the embed marker's width.
    const start = link.index + (link.bang ? 1 : 0) + 2;
    found.push({ kind: "wiki", embed: link.bang, target, start, end: start + target.length });
  }

  const inlineInCode = within(skip);
  for (const link of inlineMatches(text)) {
    if (inlineInCode(link.index)) continue;
    const raw = link.raw;
    const bracketed = raw.startsWith("<") && raw.endsWith(">");
    const target = bracketed ? raw.slice(1, -1) : raw;
    const start = link.index + link.label.length + 3 + (bracketed ? 1 : 0);
    found.push({
      kind: "inline",
      embed: link.index > 0 && text[link.index - 1] === "!",
      target,
      start,
      end: start + target.length,
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/**
 * The wikilinks in `text`, in order, as `/(!?)\[\[([^\]\n]+)\]\]/g` matched
 * them.
 *
 * `[^\]\n]+` can only end where the first `]` or newline at or after the
 * brackets is, because a shorter run would need `]]` to start before it. So the
 * whole match is decided by that one position, which a cursor walking forward
 * with the candidates finds in one pass over the note — where the regex
 * rescanned to the end of the line from every `[[`, and `[[` repeated is a
 * `[[` at every other character.
 */
function* wikilinkMatches(
  text: string,
): Generator<{ index: number; bang: boolean; inner: string }> {
  let from = 0;
  let stop = 0; // the first `]` or newline at or after `stop`, kept moving
  for (;;) {
    const open = text.indexOf("[[", from);
    if (open === -1) return;
    const inner = open + 2;
    if (stop < inner) stop = inner;
    while (stop < text.length && text[stop] !== "]" && text[stop] !== "\n") stop += 1;
    if (stop > inner && text[stop] === "]" && text[stop + 1] === "]") {
      // `(!?)` takes the `!` only when it has not already been consumed, which
      // is what the regex's lastIndex decided and `open > from` decides here.
      const bang = open > from && text[open - 1] === "!";
      yield { index: bang ? open - 1 : open, bang, inner: text.slice(inner, stop) };
      from = stop + 2;
    } else {
      from = open + 1;
    }
  }
}

/**
 * The inline links in `text`, in order, as
 * `/\[([^\]\n]*)\]\((<[^>\n]*>|[^\s()]*)\s*(?:"[^"\n]*"|'[^'\n]*')?\)/g`
 * matched them.
 *
 * Only the label's `[^\]\n]*` is replaced by a cursor: it is the quadratic
 * half, scanning to the end of the line from every `[`. The tail keeps the
 * pattern it always had, anchored at the `(`, and backtracks no further than
 * the one run it is looking at.
 */
function* inlineMatches(
  text: string,
): Generator<{ index: number; label: string; raw: string }> {
  /*
    The target, an optional title and the closing paren. The target is either
    `<…>` or a run with no whitespace and no closing paren. Deliberately not a
    balanced-paren matcher: a target containing `)` has to be written `<…>` to
    be a link at all in most renderers, and pretending otherwise is how a
    rewriter eats the rest of a paragraph.

    Built per call, so a partly-consumed generator cannot clobber another's
    `lastIndex`.
  */
  const tailAt = /\((<[^>\n]*>|[^\s()]*)\s*(?:"[^"\n]*"|'[^'\n]*')?\)/y;
  let from = 0;
  let stop = 0;
  for (;;) {
    const open = text.indexOf("[", from);
    if (open === -1) return;
    const label = open + 1;
    if (stop < label) stop = label;
    while (stop < text.length && text[stop] !== "]" && text[stop] !== "\n") stop += 1;
    if (text[stop] === "]" && text[stop + 1] === "(") {
      tailAt.lastIndex = stop + 1;
      const tail = tailAt.exec(text);
      if (tail !== null) {
        yield { index: open, label: text.slice(label, stop), raw: tail[1] };
        from = tailAt.lastIndex;
        continue;
      }
    }
    from = open + 1;
  }
}

/* ------------------------------ resolution ------------------------------- */

/** A scheme, a protocol-relative URL, or a mail address: not ours to touch. */
function isExternal(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

/**
 * Split a target into the part that names a file and the part that does not.
 *
 * `note#heading`, `note#^block-id`. The anchor is carried through a rewrite
 * untouched: where somebody was pointing *inside* a note is not something a
 * move knows anything about.
 */
function splitAnchor(target: string): { file: string; anchor: string } {
  const hash = target.indexOf("#");
  if (hash === -1) return { file: target, anchor: "" };
  return { file: target.slice(0, hash), anchor: target.slice(hash) };
}

/** `a/b/c.md` → `a/b`; a note at the root → `""`. */
export function dirOf(path: string): string {
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
export function normalizeSegments(segments: readonly string[]): string[] | null {
  const out: string[] = [];
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
export function styleOf(file: string): LinkStyle {
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
export function resolveLink(
  link: Pick<Link, "kind" | "target">,
  fromPath: string,
  byName?: ReadonlyMap<string, string[]>,
): string | null {
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* ------------------------------- reading --------------------------------- */

/*
  `[label]: target` on a line of its own. A footnote (`[^1]: text`) is not one,
  and the target is `<…>` or a run with no whitespace; a title after it is left
  unread because nothing here needs it.
*/
const DEFINITION = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm;

/**
 * Every reference in `text` for a *reader* ("what does this note point at"),
 * in document order, with no length cap. See the gateway's copy for the
 * reasoning; definitions are reported here and nowhere else.
 */
export function extractReferences(text: string): LinkOccurrence[] {
  const skip = codeRanges(text);
  const inCode = (index: number) => skip.some(([from, to]) => index >= from && index < to);
  const found: (Link | Omit<LinkOccurrence, "fragment" | "style">)[] = parseLinks(text);

  for (const match of text.matchAll(DEFINITION)) {
    if (inCode(match.index)) continue;
    const raw = match[1];
    const bracketed = raw.startsWith("<") && raw.endsWith(">");
    const target = bracketed ? raw.slice(1, -1) : raw;
    const start = match.index + match[0].length - raw.length + (bracketed ? 1 : 0);
    found.push({ kind: "definition", embed: false, target, start, end: start + target.length });
  }

  return found
    .sort((a, b) => a.start - b.start)
    .map((link) => {
      const target = link.target.trim();
      const { file, anchor } = splitAnchor(target);
      const external = isExternal(target);
      return {
        ...link,
        fragment: external ? "" : anchor,
        style: external || file === "" ? null : styleOf(decodeFor(link, file)),
      };
    });
}

/** Wikilinks are written as-is; inline links and definitions are URL-encoded. */
function decodeFor(link: Pick<LinkOccurrence, "kind">, file: string): string {
  return link.kind === "wiki" ? file : safeDecode(file);
}

/**
 * What an occurrence points at, as a verdict rather than a path-or-null.
 *
 * Without `catalog.paths` a computed path or an unmatched bare name is
 * `unknown`, not `missing`: absence of a list is not absence of a note. Never
 * throws on anything `extractReferences` produces.
 *
 * `catalog` must contain only targets the caller may see; built from anything
 * wider, `ambiguous`/`missing` versus `resolved` reveals notes the caller cannot
 * see (architecture README section 7.3).
 */
export function resolveReference(
  occurrence: Pick<LinkOccurrence, "kind" | "target">,
  fromPath: string,
  catalog: LinkCatalog,
): LinkResolution {
  const target = occurrence.target.trim();
  if (isExternal(target)) return { state: "external" };
  if (occurrence.kind === "definition") return { state: "unsupported" };
  const { file } = splitAnchor(target);
  if (file === "" || file === "." || file === "..") return { state: "invalid" };

  const absent = catalog.paths ? "missing" : "unknown";
  const decoded = decodeFor(occurrence, file);
  if (styleOf(decoded) === "bare") {
    const candidates = catalog.byName?.get(decoded.replace(/\.md$/, ""));
    if (candidates?.length === 1) return { state: "resolved", path: candidates[0] };
    return { state: candidates && candidates.length > 1 ? "ambiguous" : absent };
  }

  const path = resolveLink(occurrence as Pick<Link, "kind" | "target">, fromPath, catalog.byName);
  if (path === null) return { state: "invalid" };
  if (!catalog.paths) return { state: "unknown" };
  return catalog.paths.has(path) ? { state: "resolved", path } : { state: "missing" };
}

/* ---------------------------- re-expression ------------------------------ */

/** The path from one folder to another note, as `../../x/y.md`. */
export function relativePath(fromDir: string, toPath: string): string {
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
export function expressLink(
  link: Pick<Link, "kind" | "target">,
  referrerPath: string,
  targetPath: string,
): string {
  const { file: original, anchor } = splitAnchor(link.target.trim());
  const written = link.kind === "inline" ? safeDecode(original) : original;
  const style = styleOf(written);

  let file: string;
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
function encodeTarget(file: string): string {
  return file.replace(/[ ()<>]/g, (character: string) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
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
export function rewriteLinks(
  text: string,
  { fromPath, toPath, renames, byName }: RewriteOptions,
): { text: string; changed: number } | null {
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
export function indexByName(paths: readonly string[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const existing = byName.get(name);
    if (existing) existing.push(path);
    else byName.set(name, [path]);
  }
  return byName;
}

/**
 * An image line: what the file says, and the only thing the layout is kept in.
 *
 * ## Why a line is the unit
 *
 * `livePreview.ts`'s rule is that the buffer *is* the Markdown, so an image
 * cannot be given a position, a rotation or a z-order — there is nowhere
 * honest to keep one. What Markdown *can* carry is decided by what every other
 * reader of the file already does with it, and two of those turn out to be
 * enough for everything people actually ask for:
 *
 *  - **Several embeds on one line render side by side.** Not a convention of
 *    ours: an image is an inline node in CommonMark and in Obsidian, so
 *    `![[a.png|320]] ![[b.png|320]]` is a row *there* as well as here. A row is
 *    therefore a line, and dragging one image beside another is one line edit.
 *  - **A width lives in the pipe.** `![[a.png|320]]` is Obsidian's own
 *    grammar, inside the embed `links.ts` already parses and rewrites when a
 *    note moves, which an `<img width>` tag is not — see
 *    `docs/decisions/app-and-console.md`, "A pasted image is a width in the
 *    note and a file in the bucket".
 *
 * The one thing neither gives is alignment, and that is what the directive
 * below is for: an HTML comment, which **every** Markdown renderer drops from
 * its output. So a centred row is centred here and merely left-aligned in
 * Obsidian — the image still renders, at the width it was given, and nothing is
 * lost but the centring. That is the trade this file exists to make: metadata
 * we understand, in the file, degrading to invisible rather than to garbage,
 * and never in a sidecar the Markdown does not contain.
 *
 * ## What is deliberately not here
 *
 * No height (a cap on the width is the whole size model, and aspect stays the
 * image's own), no crop box, no float, no coordinates. Each would be a second
 * number with no portable home, and the escape hatch for wanting them is a
 * drawing, which is a canvas format that carries them honestly.
 *
 * Pure, and tested without a DOM or an editor: every awkward case here is a
 * string case — a line that is nearly all images, a directive with a key
 * nobody knows, a width somebody typed as `0` — and none of them need a
 * renderer. `__tests__/imageLine.test.ts` is the whole contract.
 */

/** How a row sits in the text column. `left` is the default and writes nothing. */
export type ImageAlign = "left" | "center" | "right";

/** The two embed forms, kept because a note that uses one keeps getting it. */
export type ImageForm = "wiki" | "inline";

/** One embed on an image line. `from`/`to` span the whole embed. */
export interface ImageRef {
  form: ImageForm;
  /** The file the embed points at, as written. */
  target: string;
  /** The alt text, or `""` for a wikilink, which has no separate slot for one. */
  alt: string;
  /** The width cap in px, or `null` when the embed carries none. */
  width: number | null;
  from: number;
  to: number;
}

/** A line that is nothing but image embeds, plus what we know about it. */
export interface ImageLine {
  images: ImageRef[];
  align: ImageAlign;
  /** The span of the directive comment, when the line carries one. */
  directive: { from: number; to: number } | null;
}

/**
 * The directive, and why it is this shape.
 *
 * `<!-- context: … -->` rather than a bare `<!-- align=center -->` so it is
 * obvious in a diff whose comment it is, and so a person reading the raw file
 * in Obsidian has a word to search for. Keys are `key=value`, space separated,
 * and an unknown key is **kept** rather than dropped: a future version of this
 * editor may add one, and a note edited by an older console must not silently
 * lose it.
 */
const DIRECTIVE = /<!--\s*context:\s*([^>]*?)\s*-->/;

/** `![[target]]` and `![[target|320]]`, the width in the alias slot. */
const WIKI_EMBED = /!\[\[([^\]|#]+?)(?:\|([^\]]*))?\]\]/g;

/** `![alt](target)` and `![alt|320](target)`. */
const INLINE_EMBED = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/** A width Obsidian would honour: a positive integer, nothing else. */
function widthFrom(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const width = Number.parseInt(trimmed, 10);
  return width > 0 ? width : null;
}

/**
 * The alias slot, split into the width we understand and the rest.
 *
 * Obsidian uses the same slot for a display name, so `![[a.png|the sketch]]`
 * is an alias and not a width. Splitting rather than assuming keeps both: the
 * alias travels through a resize untouched.
 */
function splitAlias(alias: string | undefined): {
  alt: string;
  width: number | null;
} {
  if (alias === undefined) return { alt: "", width: null };
  const parts = alias.split("|");
  const last = parts[parts.length - 1];
  const width = widthFrom(last);
  if (width === null) return { alt: alias, width: null };
  return { alt: parts.slice(0, -1).join("|"), width };
}

function parseDirective(text: string): {
  align: ImageAlign;
  span: { from: number; to: number } | null;
} {
  const match = DIRECTIVE.exec(text);
  if (match === null) return { align: "left", span: null };
  const span = { from: match.index, to: match.index + match[0].length };
  for (const pair of match[1].split(/\s+/)) {
    const [key, value] = pair.split("=");
    if (key !== "align") continue;
    if (value === "center" || value === "right" || value === "left") {
      return { align: value, span };
    }
  }
  return { align: "left", span };
}

/**
 * The embeds on `text`, in order, whichever form they are written in.
 *
 * Both patterns are run over the whole line and the results sorted, rather than
 * one pattern winning: a line may honestly hold one of each, and the row draws
 * them in the order they are written rather than the order the regexes ran.
 */
export function embedsIn(text: string): ImageRef[] {
  const found: ImageRef[] = [];
  for (const match of text.matchAll(WIKI_EMBED)) {
    const { alt, width } = splitAlias(match[2]);
    found.push({
      form: "wiki",
      target: match[1].trim(),
      alt,
      width,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  for (const match of text.matchAll(INLINE_EMBED)) {
    if (found.some((ref) => match.index >= ref.from && match.index < ref.to))
      continue;
    const { alt, width } = splitAlias(match[1]);
    found.push({
      form: "inline",
      target: match[2].trim(),
      alt,
      width,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return found.sort((left, right) => left.from - right.from);
}

/**
 * `text` read as an image line, or `null` when it is prose that happens to
 * contain an image.
 *
 * The distinction is the whole reason this returns null at all: an image in the
 * middle of a sentence is part of the sentence — resizing it by dragging would
 * reflow somebody's paragraph — and only a line that is *nothing but* embeds is
 * a row this editor lays out. Whitespace and one directive are allowed; a
 * single stray word is not.
 */
export function parseImageLine(text: string): ImageLine | null {
  const images = embedsIn(text);
  if (images.length === 0) return null;
  const { align, span } = parseDirective(text);
  let rest = "";
  let cursor = 0;
  for (const image of images) {
    rest += text.slice(cursor, image.from);
    cursor = image.to;
  }
  rest += text.slice(cursor);
  if (span !== null) {
    // The directive may sit anywhere outside the embeds; remove it by span
    // rather than by regex so a comment inside an alt text cannot be taken for
    // one. `slice` on the already-stripped remainder would need the offsets
    // recomputed, so it is taken out of the original and re-stripped.
    rest = rest.replace(DIRECTIVE, "");
  }
  if (rest.trim() !== "") return null;
  return { images, align, directive: span };
}

/** Is this line a row of images this editor draws? */
export function isImageLine(text: string): boolean {
  return parseImageLine(text) !== null;
}

/** One embed, written the way this editor writes them. */
export function embedFor(
  target: string,
  width: number | null,
  form: ImageForm = "wiki",
): string {
  if (form === "inline") {
    const alt = width === null ? "" : `|${width}`;
    return `![${alt}](${target})`;
  }
  return width === null ? `![[${target}]]` : `![[${target}|${width}]]`;
}

/** The same embed, with its width replaced (or removed for `null`). */
export function withWidth(image: ImageRef, width: number | null): string {
  if (image.form === "inline") {
    const alt = image.alt === "" ? "" : image.alt;
    const label = width === null ? alt : `${alt}|${width}`;
    return `![${label}](${image.target})`;
  }
  const alias =
    width === null
      ? image.alt === ""
        ? null
        : image.alt
      : image.alt === ""
        ? String(width)
        : `${image.alt}|${width}`;
  return alias === null
    ? `![[${image.target}]]`
    : `![[${image.target}|${alias}]]`;
}

/**
 * `text` with image `index` resized.
 *
 * Returns the line unchanged when there is no such image, rather than throwing:
 * the caller is a pointer drag against a document that may have changed under
 * it, and a no-op is the right answer to "resize an image that is no longer
 * there".
 */
export function lineWithWidth(
  text: string,
  index: number,
  width: number | null,
): string {
  const line = parseImageLine(text);
  if (line === null) return text;
  const image = line.images[index];
  if (image === undefined) return text;
  return (
    text.slice(0, image.from) + withWidth(image, width) + text.slice(image.to)
  );
}

/**
 * `text` with its alignment set.
 *
 * `left` removes the directive rather than writing `align=left`, because the
 * absence of a directive is what a file written by anything else looks like and
 * the two must not be different states. Any other key in an existing directive
 * survives.
 */
export function lineWithAlign(text: string, align: ImageAlign): string {
  const match = DIRECTIVE.exec(text);
  const others =
    match === null
      ? []
      : match[1]
          .split(/\s+/)
          .filter((pair) => pair !== "" && !pair.startsWith("align="));
  const keys = align === "left" ? others : [...others, `align=${align}`];
  const directive =
    keys.length === 0 ? "" : `<!-- context: ${keys.join(" ")} -->`;
  const withoutDirective =
    match === null ? text : text.replace(DIRECTIVE, "").trimEnd();
  if (directive === "") return withoutDirective.trimEnd();
  return `${withoutDirective.trimEnd()} ${directive}`;
}

/**
 * The line that results from moving image `index` of `fromText` onto the end of
 * `ontoText`'s row — the drag that makes two images sit side by side.
 *
 * Returns `null` when either line is not an image line, which is the guard that
 * keeps a drop onto a paragraph from rewriting the paragraph.
 */
export function joinRows(
  ontoText: string,
  fromText: string,
  index: number,
): { onto: string; from: string } | null {
  const target = parseImageLine(ontoText);
  const source = parseImageLine(fromText);
  if (target === null || source === null) return null;
  const moving = source.images[index];
  if (moving === undefined) return null;
  const embed = withWidth(moving, moving.width);
  const remaining = (
    fromText.slice(0, moving.from) + fromText.slice(moving.to)
  ).trim();
  const lastImage = target.images[target.images.length - 1];
  const onto =
    ontoText.slice(0, lastImage.to) +
    ` ${embed}` +
    ontoText.slice(lastImage.to);
  return { onto, from: remaining };
}

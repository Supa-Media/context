/**
 * A drawing is a note whose body is not meant to be read as text.
 *
 * ## The problem this exists for
 *
 * An Obsidian Excalidraw drawing is stored as `<name>.excalidraw.md` — a real
 * Markdown file, in the customer's own bucket, alongside their notes. Every
 * `.md` rule in the gateway therefore already applies to it, and each one is
 * wrong in the same way:
 *
 *  - `list_notes` shows it as an ordinary note.
 *  - the search indexer tokenizes it, so a megabyte of LZ-String base64 becomes
 *    index terms that can never be usefully hit and crowd out the ones that can.
 *  - `read_note` returns the whole file, uncapped, so asking to read a drawing
 *    spends a caller's entire context on a compressed blob it cannot decode.
 *
 * None of that is a storage problem. The file is fine, and
 * `docs/decisions/obsidian-plugins.md` is explicit that we do not touch it:
 * "`.canvas` and `.excalidraw.md` are opaque, not malformed. A file we do not
 * parse is still a file we do not corrupt." This module keeps that promise and
 * adds the other half — **we now read it without rewriting it.** Nothing here
 * produces a new file body; every function takes text and returns a
 * description of it.
 *
 * ## What a caller gets instead of the payload
 *
 * `describeDrawing` renders the drawing as prose: what is in it, what the
 * labels say, and which shape points at which. An agent asked "what does the
 * ingest diagram show" can answer from that, which is the actual request behind
 * "support Excalidraw" — the picture matters to a person, and to an agent the
 * arrows and the labels *are* the picture. The frontend renders the real thing
 * from the same parse (`scene.js`), so the two never disagree about what the
 * file contains.
 *
 * ## The file format, as the plugin actually writes it
 *
 *     ---
 *     excalidraw-plugin: parsed
 *     ---
 *
 *     # Excalidraw Data
 *
 *     ## Text Elements
 *     Ingest ^a1b2c3d4
 *
 *     ## Element Links
 *     a1b2c3d4: [[2-areas/apps/context/storage]]
 *
 *     ## Embedded Files
 *     9f8e7d: [[diagram-source.png]]
 *
 *     %%
 *     ## Drawing
 *     ```compressed-json
 *     N4KABGYEwpgngQgVyqAbA9g...
 *     ```
 *     %%
 *
 * Three things about that are load-bearing and easy to get wrong:
 *
 *  1. **The payload fence is either `json` or `compressed-json`**, and which one
 *     is a plugin *setting*, not a version. Both appear in live vaults.
 *  2. **The headings were `#` before they were `##`.** A vault that predates the
 *     change still has `# Text Elements`, and those files are exactly the old
 *     ones somebody most wants read back. Both levels are accepted.
 *  3. **`%%` wraps the payload** so Obsidian hides it. It is a comment to
 *     Obsidian and noise to us; the fence inside is what matters, and finding
 *     the fence directly means a file that omits the `%%` still parses.
 *
 * ## Everything degrades to "we could not read it"
 *
 * A drawing whose payload is missing, truncated, not valid base64, not valid
 * JSON, or valid JSON of some shape we do not recognise is not an error. It
 * parses to a drawing with `elements: null` and whatever text elements the
 * Markdown half carried — which is usually all of the labels, because the
 * plugin writes them out in plain text precisely so they stay searchable. The
 * reason is in `lzstring.js`'s header: the cost of a bug here must be a missing
 * preview, never a refusal to open somebody's file.
 */

import { decompressFromBase64 } from "./lzstring.js";

/** The suffix that makes a note a drawing. */
export const DRAWING_SUFFIX = ".excalidraw.md";

/**
 * Is this key a drawing?
 *
 * Suffix only. The frontmatter key (`excalidraw-plugin`) is the plugin's own
 * marker and a more "correct" test, but it requires reading the file to answer
 * a question the listing and the search walk ask about a *key*, before any read
 * has happened. The suffix is what the plugin names its files and what the
 * customer sees; a file that carries the frontmatter under another name is
 * still handled correctly once read, because `parseDrawing` does not check.
 */
export function isDrawingPath(key) {
  return typeof key === "string" && key.toLowerCase().endsWith(DRAWING_SUFFIX);
}

/** `1-projects/plan.excalidraw.md` -> `plan`. */
export function drawingName(key) {
  if (typeof key !== "string") return "";
  const leaf = key.slice(key.lastIndexOf("/") + 1);
  return isDrawingPath(leaf) ? leaf.slice(0, -DRAWING_SUFFIX.length) : leaf.replace(/\.md$/i, "");
}

/**
 * A ceiling on the payload this will try to decode.
 *
 * A drawing is a file somebody made by hand, so a payload past this is not a
 * big diagram, it is a file doing something else. Decoding runs in a Worker
 * with a CPU budget, and the decompressor's dictionary grows with its input:
 * refusing early is the difference between "no preview" and "the request that
 * read this note timed out".
 */
export const MAX_PAYLOAD_CHARS = 4_000_000;

/**
 * The most elements a parse will return.
 *
 * Past this the answer to "what is in this drawing" stops being a list and
 * starts being a summary, and the renderer has a frame budget. `truncated`
 * says so rather than presenting a floor as a total — the trap
 * `docs/decisions/` names for the note count, in a second place.
 */
export const MAX_ELEMENTS = 5_000;

/** `^a1b2c3` at the end of a text-element line: the plugin's id, not content. */
const ELEMENT_ID = /\s*\^([A-Za-z0-9_-]+)\s*$/;

/** `## Text Elements`, `# Text Elements`, and the same for the other sections. */
function sectionPattern(title) {
  return new RegExp(`^#{1,6}\\s+${title}\\s*$`, "i");
}

const SECTIONS = [
  ["textElements", sectionPattern("Text Elements")],
  ["elementLinks", sectionPattern("Element Links")],
  ["embeddedFiles", sectionPattern("Embedded Files")],
  ["drawing", sectionPattern("Drawing")],
  ["data", sectionPattern("Excalidraw Data")],
];

/**
 * Split `text` into a drawing.
 *
 * Returns `{ name, textElements, elementLinks, embeddedFiles, elements,
 * payload, truncated, unreadable }`. `elements` is `null` exactly when the
 * payload could not be read, and `unreadable` then says why in one word, for a
 * message a person sees rather than for a branch.
 */
export function parseDrawing(text, key = "") {
  const body = typeof text === "string" ? text : "";
  const name = drawingName(key);
  const sections = splitSections(stripFrontmatter(body));

  const textElements = parseTextElements(sections.textElements ?? "");
  const elementLinks = parseIdMap(sections.elementLinks ?? "");
  const embeddedFiles = parseIdMap(sections.embeddedFiles ?? "");
  const payload = findPayload(body);

  let elements = null;
  let appState = null;
  let unreadable = null;
  let truncated = false;

  if (!payload) {
    unreadable = "missing";
  } else if (payload.text.length > MAX_PAYLOAD_CHARS) {
    unreadable = "oversized";
  } else {
    const json = payload.compressed ? decompressFromBase64(payload.text) : payload.text;
    if (json === null) {
      unreadable = "undecodable";
    } else {
      const scene = safeJson(json);
      if (scene === null) {
        // Decompression (or the plain fence) gave us something, and it is not
        // JSON. "Undecodable" rather than "unrecognised": we never got as far
        // as a shape to recognise.
        unreadable = "undecodable";
      } else if (!Array.isArray(scene.elements)) {
        unreadable = "unrecognised";
      } else {
        const live = scene.elements.filter((element) => element && !element.isDeleted);
        truncated = live.length > MAX_ELEMENTS;
        elements = truncated ? live.slice(0, MAX_ELEMENTS) : live;
        appState = scene.appState ?? null;
      }
    }
  }

  return {
    name,
    textElements,
    elementLinks,
    embeddedFiles,
    elements,
    appState,
    truncated,
    unreadable,
    /** Present so a caller can say how big the thing it declined to inline was. */
    payloadChars: payload ? payload.text.length : 0,
  };
}

/* -------------------------------- sections -------------------------------- */

function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1);
}

/**
 * Every heading this module knows, mapped to the lines under it.
 *
 * A heading it does not know ends the section it is in, so prose somebody added
 * under their own heading never lands inside `Text Elements`.
 */
function splitSections(text) {
  const out = {};
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current) out[current] = buffer.join("\n").trim();
    buffer = [];
  };

  for (const line of text.split("\n")) {
    if (/^#{1,6}\s+/.test(line)) {
      const match = SECTIONS.find(([, pattern]) => pattern.test(line));
      flush();
      // `Excalidraw Data` is a container for the others, not a section itself.
      current = match && match[0] !== "data" ? match[0] : null;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

/**
 * The text elements, in file order.
 *
 * One element per blank-line-separated block, because a label with a line break
 * in it is written across lines with a single `^id` at the end. Splitting per
 * line instead would report a three-line label as three labels, which is how a
 * description ends up claiming a diagram has more in it than it does.
 */
function parseTextElements(section) {
  if (!section) return [];
  return section
    .split(/\n\s*\n/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return null;
      const match = ELEMENT_ID.exec(trimmed);
      return {
        id: match ? match[1] : null,
        text: (match ? trimmed.slice(0, match.index) : trimmed).trim(),
      };
    })
    .filter((entry) => entry && entry.text !== "");
}

/** `id: target` lines, as a Map. Anything that is not one is skipped. */
function parseIdMap(section) {
  const out = new Map();
  if (!section) return out;
  for (const line of section.split("\n")) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (match) out.set(match[1], match[2]);
  }
  return out;
}

/**
 * Where the `Text Elements` block's content sits, as offsets into `text`.
 *
 * From the end of the heading line to the start of the next heading — any
 * heading, known or not — or the `%%` that opens the payload comment. Offsets
 * rather than content because both callers need to ask "is this position
 * inside that block", which is a question `splitSections` cannot answer.
 *
 * Exported because `serialize.js` splices this exact span, and two copies of a
 * span calculation are two chances for the reader and the writer to disagree
 * about where somebody's labels are.
 */
export function textElementsSpan(text) {
  const heading = /^#{1,6}[ \t]+Text Elements[ \t]*$/im.exec(text);
  if (!heading) return null;
  const start = heading.index + heading[0].length + 1;
  const rest = text.slice(start);
  const next = /^(?:#{1,6}[ \t]+\S|%%[ \t]*$)/m.exec(rest);
  return { start, end: next ? start + next.index : text.length };
}

/**
 * The opening fence of the drawing payload: `{ compressed, start }`, or null.
 *
 * ## Why this is not simply the first fence
 *
 * It was, and the reason given was that "these two fence languages do not
 * appear in the Markdown half — the plugin writes that half itself". **The
 * plugin does not write all of it.** `Text Elements` is a person's own typing,
 * copied in verbatim by the plugin and by `renderTextElements` alike, newlines
 * and all — so a drawing with a label that quotes a drawing file puts a second
 * `compressed-json` fence above the real one, and the first-fence rule took it.
 *
 * That is a wrong picture on the read side and a lost drawing on the write
 * side: `serialize.js` splices the span this function finds, so an edit would
 * land in the label while the real payload kept its old contents. Both sides
 * call this, which is the point — a locator the reader and the writer disagree
 * about is worse than either rule alone.
 *
 * Only the `Text Elements` block is skipped, and deliberately not "every
 * section": it is the one whose content is free text by design. `Element
 * Links` and `Embedded Files` are `id: target` lines the plugin composes, and a
 * heading nobody knows ends the block it is in (`splitSections`), so prose
 * added by hand does not land here either. A file with no `Text Elements` block
 * at all — including a bare fence with no headings, which the tests cover —
 * behaves exactly as before.
 */
export function payloadFence(text) {
  const labels = textElementsSpan(text);
  const fence = /^[ \t]*```(compressed-json|json)[ \t]*$/gm;
  for (let opener = fence.exec(text); opener !== null; opener = fence.exec(text)) {
    if (labels && opener.index >= labels.start && opener.index < labels.end) continue;
    return {
      compressed: opener[1] === "compressed-json",
      start: opener.index + opener[0].length + 1,
    };
  }
  return null;
}

/** The drawing payload's text, or null when there is no fence to read. */
function findPayload(text) {
  const opener = payloadFence(text);
  if (!opener) return null;
  const close = text.indexOf("\n```", opener.start - 1);
  const end = close === -1 ? text.length : close;
  return {
    compressed: opener.compressed,
    text: text.slice(opener.start, end).trim(),
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/* ------------------------------- describing ------------------------------- */

/** Excalidraw's own type names, as English, singular and plural. */
const TYPE_NAMES = new Map([
  ["rectangle", ["rectangle", "rectangles"]],
  ["ellipse", ["ellipse", "ellipses"]],
  ["diamond", ["diamond", "diamonds"]],
  ["arrow", ["arrow", "arrows"]],
  ["line", ["line", "lines"]],
  ["freedraw", ["freehand stroke", "freehand strokes"]],
  ["text", ["text label", "text labels"]],
  ["image", ["image", "images"]],
  ["frame", ["frame", "frames"]],
  ["embeddable", ["embed", "embeds"]],
  ["iframe", ["embed", "embeds"]],
]);

function typeName(type, count) {
  const names = TYPE_NAMES.get(type);
  if (!names) return count === 1 ? type : `${type}s`;
  return count === 1 ? names[0] : names[1];
}

/**
 * The label a shape carries, if any.
 *
 * Excalidraw puts a shape's label in a *separate* text element pointing back at
 * it with `containerId`, so the rectangle itself has no text on it and reading
 * only `element.text` would describe a diagram of unlabelled boxes. `byContainer`
 * is that relation inverted.
 */
function labelOf(element, byContainer) {
  if (typeof element.text === "string" && element.text.trim()) return element.text.trim();
  const bound = byContainer.get(element.id);
  return bound ? bound.trim() : null;
}

/**
 * Reading order: top to bottom, then left to right, in bands.
 *
 * Sorting by `y` alone puts a row of boxes into an order decided by a few
 * pixels of drift, which reads as scrambled. A band groups anything whose tops
 * are within one row of each other and sorts inside it by `x`, which is how a
 * person reads a diagram and therefore the order a description has to use.
 *
 * The bands are **grown from the content, not cut at fixed multiples.** Rounding
 * each `y` into a fixed grid has the bug it was meant to fix: two boxes on the
 * same visual row at y=-10 and y=0 land either side of a grid line and come out
 * in different rows, while two 39px apart share one. Found by reading the
 * description of a real diagram, where the first shape listed was the one on
 * the right. So a band opens at the topmost unplaced element and takes
 * everything within `BAND` of *it*.
 */
const BAND = 40;

function readingOrder(elements) {
  const byTop = [...elements].sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
  const out = [];
  let band = [];
  let bandTop = null;

  const flush = () => {
    band.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    out.push(...band);
    band = [];
  };

  for (const element of byTop) {
    const y = element.y ?? 0;
    if (bandTop === null || y - bandTop > BAND) {
      flush();
      bandTop = y;
    }
    band.push(element);
  }
  flush();
  return out;
}

/**
 * The drawing as prose.
 *
 * This is what `read_note` returns for a drawing, so it is written to be read
 * by whatever asked — an agent or a person — rather than to be parsed. It says
 * what it does not know, because a description that quietly omits the half it
 * could not decode is worse than one that says the payload was unreadable.
 */
export function describeDrawing(drawing, { path = "" } = {}) {
  const title = drawing.name || drawingName(path) || "drawing";
  const lines = [`# ${title}`, "", "*An Excalidraw drawing, described as text. The file itself is unchanged.*", ""];

  if (!drawing.elements) {
    lines.push(unreadableSentence(drawing), "");
    if (drawing.textElements.length > 0) {
      lines.push("## Labels", "");
      for (const element of drawing.textElements) lines.push(`- ${oneLine(element.text)}`);
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  const elements = drawing.elements;
  const byId = new Map(elements.map((element) => [element.id, element]));
  const byContainer = new Map();
  for (const element of elements) {
    if (element.type === "text" && element.containerId && typeof element.text === "string") {
      byContainer.set(element.containerId, element.text);
    }
  }

  lines.push(inventorySentence(elements, drawing.truncated), "");

  /* -- labels ---------------------------------------------------------- */

  const labelled = readingOrder(
    elements.filter((element) => element.type !== "text" || !element.containerId)
  )
    .map((element) => ({ element, label: labelOf(element, byContainer) }))
    .filter((entry) => entry.label);

  if (labelled.length > 0) {
    lines.push("## Labels, in reading order", "");
    for (const { element, label } of labelled) {
      const shape = element.type === "text" ? "" : ` (${typeName(element.type, 1)})`;
      lines.push(`- ${oneLine(label)}${shape}`);
    }
    lines.push("");
  }

  /* -- connections ------------------------------------------------------ */

  const describe = (id) => {
    const element = byId.get(id);
    if (!element) return null;
    const label = labelOf(element, byContainer);
    return label ? oneLine(label) : `an unlabelled ${typeName(element.type, 1)}`;
  };

  const connections = [];
  for (const element of readingOrder(elements)) {
    if (element.type !== "arrow") continue;
    const from = element.startBinding ? describe(element.startBinding.elementId) : null;
    const to = element.endBinding ? describe(element.endBinding.elementId) : null;
    if (!from && !to) continue;
    const label = labelOf(element, byContainer);
    const annotation = label ? ` — ${oneLine(label)}` : "";
    connections.push(`- ${from ?? "(unattached)"} → ${to ?? "(unattached)"}${annotation}`);
  }

  if (connections.length > 0) {
    lines.push("## Connections", "", ...connections, "");
  }

  /* -- links out -------------------------------------------------------- */

  const links = [];
  for (const element of readingOrder(elements)) {
    const target = element.link ?? drawing.elementLinks.get(element.id);
    if (!target) continue;
    const label = labelOf(element, byContainer) ?? typeName(element.type, 1);
    links.push(`- ${oneLine(label)} → ${oneLine(String(target))}`);
  }
  for (const [, target] of drawing.embeddedFiles) {
    links.push(`- embedded file → ${oneLine(String(target))}`);
  }

  if (links.length > 0) {
    lines.push("## Links out", "", ...links, "");
  }

  return lines.join("\n").trimEnd();
}

function inventorySentence(elements, truncated) {
  const counts = new Map();
  for (const element of elements) {
    counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${count} ${typeName(type, count)}`);

  const total = `${elements.length}${truncated ? "+" : ""} element${elements.length === 1 && !truncated ? "" : "s"}`;
  const box = boundingBox(elements);
  const size = box ? `, spanning ${Math.round(box.width)}×${Math.round(box.height)}` : "";
  const cut = truncated
    ? ` Only the first ${MAX_ELEMENTS} are described; the drawing has more.`
    : "";
  return `${total}${size}: ${parts.join(", ")}.${cut}`;
}

function unreadableSentence(drawing) {
  switch (drawing.unreadable) {
    case "missing":
      return "This file carries no drawing payload, so only its text is available.";
    case "oversized":
      return `The drawing payload is ${Math.round(drawing.payloadChars / 1000)}k characters, past what is decoded inline, so only its text is available.`;
    case "undecodable":
      return "The drawing payload could not be decompressed, so only its text is available. The file is untouched.";
    default:
      return "The drawing payload is not in a shape this reader recognises, so only its text is available. The file is untouched.";
  }
}

/** The scene's extent, or null when nothing in it has a position. */
export function boundingBox(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const element of elements) {
    const x = Number(element.x);
    const y = Number(element.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const width = Number.isFinite(Number(element.width)) ? Number(element.width) : 0;
    const height = Number.isFinite(Number(element.height)) ? Number(element.height) : 0;
    // Width and height are signed for a shape dragged up or left, so the corner
    // a caller wants is not always (x+width, y+height).
    minX = Math.min(minX, x, x + width);
    minY = Math.min(minY, y, y + height);
    maxX = Math.max(maxX, x, x + width);
    maxY = Math.max(maxY, y, y + height);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/**
 * Everything in the drawing that is worth a search term.
 *
 * This is what the indexer stores instead of the file. A drawing is findable by
 * its labels, its name and the notes it links to — which is what somebody is
 * searching for when they go looking for a diagram — and the payload
 * contributes nothing, because base64 tokenizes into terms no query produces.
 */
export function drawingSearchText(drawing) {
  /*
    Deduplicated, because the plugin writes every label twice on purpose: once
    as plain text in the Markdown half so a vault search can find it, and again
    inside the payload. Counting both doubles the term frequency of a drawing's
    own labels against every other note in the index, which quietly ranks
    drawings above notes that say the same thing once.
  */
  const parts = new Set([drawing.name]);
  for (const element of drawing.textElements) parts.add(element.text);
  if (drawing.elements) {
    for (const element of drawing.elements) {
      if (typeof element.text === "string") parts.add(element.text);
      if (typeof element.link === "string") parts.add(element.link);
    }
  }
  for (const [, target] of drawing.elementLinks) parts.add(String(target));
  for (const [, target] of drawing.embeddedFiles) parts.add(String(target));
  return [...parts].filter(Boolean).join("\n");
}

/** One line, bounded, for a list item. */
function oneLine(value) {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}

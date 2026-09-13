/**
 * A drawing from nothing, which is the one file this package is allowed to
 * invent.
 *
 * ## Why this is separate from `serialize.js`, and why it exists at all
 *
 * `serialize.js` refuses to build a file from a template, and its header says
 * why: it edits bytes somebody's bucket already holds, so a serializer that
 * regenerated the file would silently drop the frontmatter, the plugin's
 * warning line, `Element Links`, `Embedded Files`, a heading somebody added,
 * the trailing newline, even CRLF. That argument is airtight **about editing an
 * existing file**, and it carried a second sentence that went further: that a
 * new drawing is created by the editor that owns the format, and this package
 * only edits what comes back.
 *
 * That second sentence had a cost nobody had priced. It meant the console could
 * not offer New drawing at all: a person had to install Obsidian and the
 * Excalidraw plugin to start a diagram, in a product whose console renders and
 * edits drawings natively on web and on a phone. The feature read as "we
 * support Obsidian's format" when what is true is that we support drawings and
 * keep Obsidian's format so files move both ways.
 *
 * So the rule is narrowed rather than dropped: **an existing file is edited,
 * never regenerated; a file that does not exist yet is scaffolded here, once.**
 * The moment this file has been written, every later change goes through
 * `serializeDrawing` and the splice discipline applies to it like any other
 * drawing.
 *
 * ## The scaffold is the plugin's, not ours
 *
 * The risk the old rule was protecting against is real: two producers of one
 * format that disagree. It is answered by writing what the plugin writes rather
 * than by not writing at all. The frontmatter key, the warning line, the
 * `# Excalidraw Data` container, the `## Text Elements` section and the `%%`
 * wrapper are all the plugin's own, and the warning line's wording is copied
 * from a real file rather than composed here.
 *
 * If the plugin later changes that wording, a file we scaffolded keeps the old
 * one until Obsidian next saves it, at which point the plugin rewrites the
 * line itself. That is the whole of the drift, and it is cosmetic: the line
 * exists to tell somebody reading the raw Markdown to switch views.
 *
 * ## `compressed-json`, because that is what the plugin writes
 *
 * The fence language is a plugin *setting*, and both appear in live vaults. An
 * empty scene would be more readable as plain `json`, and that is the wrong
 * reason to pick it: a drawing this product created should be indistinguishable
 * from one Obsidian created, sitting in the same folder. `serializeDrawing`
 * keeps whichever language a file arrived in, so this choice is only ever the
 * starting point.
 */

import { compressToBase64 } from "./lzstring.js";

/**
 * The plugin's line for somebody who opens a drawing as plain Markdown.
 *
 * Copied from a real file, character for character, including the two spaces
 * after the warning sign. `packages/drawings/test/serialize.test.mjs` carries
 * the same string in its fixture, captured from a vault rather than written.
 */
const SWITCH_VIEW_NOTICE =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==";

/** How the plugin wraps a long base64 payload. Cosmetic to a parser, not to a diff. */
const WRAP_COLUMNS = 64;

/**
 * An empty drawing, as a complete `.excalidraw.md` file body.
 *
 * The caller writes it wherever they are creating the note. It carries a real
 * payload, which is what the gateway's write guard tests for
 * (`toolWriteNote` refuses a `.excalidraw.md` path whose content is not a
 * drawing), so a file made here can be written through the same path as any
 * other note rather than needing one of its own.
 */
export function newDrawing() {
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };

  const payload = compressToBase64(JSON.stringify(scene));
  const wrapped = [];
  for (let i = 0; i < payload.length; i += WRAP_COLUMNS) {
    wrapped.push(payload.slice(i, i + WRAP_COLUMNS));
  }

  return [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "---",
    SWITCH_VIEW_NOTICE,
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    "",
    "%%",
    "## Drawing",
    "```compressed-json",
    `${wrapped.join("\n")}`,
    "```",
    "%%",
    "",
  ].join("\n");
}

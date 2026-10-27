/**
 * Pages in the gateway: the check a `.page.md` write passes, and the format
 * guide agents are given (`orient about: "pages"`, and the line background
 * jobs are told). The format itself is `packages/shared/src/pages/`, the same
 * copy the app and the page runtime read.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`.
 */

// Each file by itself: Node's ESM import sees a CommonJS file's names only when it lists them plainly.
import { isPagePath, parsePage } from "../../../packages/shared/src/pages/parse.cjs";
import { BLOCK_KINDS } from "../../../packages/shared/src/pages/blocks.cjs";

export { isPagePath };

/** At most this many problems are listed; the rest are counted. */
const MAX_LISTED = 8;

function lineAt(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

/**
 * Why a page cannot be saved as written, or null when it can. The checks are
 * for the writer (a chart with no numbers, a choice of one), never for
 * safety: the runtime escapes every word and draws whatever it is given.
 */
export function pageProblems(content) {
  const { problems } = parsePage(content);
  if (problems.length === 0) return null;
  const listed = problems.slice(0, MAX_LISTED).map((problem) => `- line ${lineAt(content, problem.from)}: ${problem.message}`);
  const more = problems.length > MAX_LISTED ? [`- and ${problems.length - MAX_LISTED} more.`] : [];
  return [
    "this page has blocks that cannot be drawn, so it was not saved:",
    ...listed,
    ...more,
    'Fix them and write again. orient about: "pages" has the format.',
  ].join("\n");
}

/** One line per block kind, from the kinds themselves, so the guide never drifts from the checks. */
const KIND_LINES = Object.entries(BLOCK_KINDS).map(([kind, { about }]) => `- \`${kind}\`: ${about}`);

/** What `orient about: "pages"` answers. */
export const PAGE_GUIDE = [
  "## Pages (`<name>.page.md`)",
  "",
  "A note whose name ends in `.page.md` is drawn as a page: words, charts and choices people read, edit, tick and comment on in the app. It is still Markdown, so every word stays editable and searchable.",
  "",
  "- **Words** are ordinary Markdown: `#` title, `##` sections (each a section, or a tab with `layout: tabs`), lists, `- [ ]` tasks people tick, tables, `> [!NOTE]` callouts, links and `[[wiki links]]`.",
  "- **Front matter**: `title`, `kicker` (a small line above the title), `theme` (light, paper, dark, night; else the reader's), `accent` (blue, green, orange, plum, red, ink), `layout: tabs`.",
  "- **Blocks** are fenced data the page draws: the fence names the kind and an optional caption, then one `- ` line per item and `key: value` settings. An item is `|`-separated parts, the first may start with `Label: `. Example:",
  "",
  "  ```compare Quotes per head",
  "  limit: 35",
  "  - Casa Lola: $29 | Family style",
  "  - Marlow's: $41 | Over budget",
  "  ```",
  "",
  ...KIND_LINES,
  "",
  "- **Look**: a ```` ```css ```` fence restyles the page (`--pg-accent`, `.pg-stat`, `h1`); it can load nothing from the network.",
  "- **Code boxes**: a ```` ```box height=320 ```` fence holds HTML and script for something no block draws (a calculator, a quiz, a custom chart). It runs sealed in its own frame, loads nothing, and reads the page's blocks as `window.page.blocks`. Prefer a block; reach for a box only when none fits.",
  "- A write with a block that cannot be drawn is refused with the line to fix. A `choose` block's pick comes back as its `chosen:` line: read the note again to see it.",
].join("\n");

/** The line a background job is told about writing its result as a page. */
export const PAGE_JOB_LINE =
  "Write the deliverable as a page: a note named `<name>.page.md` that leads with the answer, then `##` sections. " +
  "Put numbers and options in blocks people can read at a glance (```stats, ```compare, ```chart, ```timeline, ```choose, ```places, ```versus, ```progress, ```people, ```steps, ```board: " +
  "one `- Label: value | detail` line per item), sources as links, and next steps as `- [ ]` tasks. " +
  'orient about: "pages" has the whole format; a page that cannot be drawn is refused with the line to fix.';

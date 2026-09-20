/**
 * The form on a shared note, as a stranger fills it in.
 *
 * ## Why this is a file and not three hooks inside the screen
 *
 * Everything here is pure: what forms a note carries, what an empty answer set
 * looks like, and whether what somebody typed is sendable. None of it renders,
 * so all of it is testable without mounting a page — and a page that is only
 * testable by mounting is a page whose validation gets checked once, by hand,
 * on the happy path.
 *
 * ## The grammar is imported, never restated
 *
 * `parseFormBlocks` and `validateSubmission` come from `apps/mcp/src/forms.js`,
 * which is the same file the gateway, the control plane and the console editor
 * reach for. Four surfaces, one grammar — and the reason is specific rather
 * than tidy: a second copy here would drift from the one the server enforces,
 * and the drift shows up as a form that fills in happily and is refused on
 * submit, in front of somebody who has no account and no way to ask why.
 *
 * So this file checks **before** sending only to save a round trip. The server
 * checks again, and the server's answer is the one that decides.
 */

import {
  FORM_FENCE_LANG,
  parseFormBlocks,
  validateSubmission,
} from "../../../mcp/src/forms.js";

/** One declared field, as `parseFormBlocks` normalizes it. */
export interface CollectField {
  readonly name: string;
  readonly type: "line" | "text" | "select" | "number" | "date" | "checkbox";
  readonly required: boolean;
  readonly max?: number;
  readonly min?: number;
  readonly options?: readonly string[];
}

/** One form block on the note, as this page draws it. */
export interface CollectForm {
  readonly id: string;
  readonly submit: "member" | "editor" | "owner";
  readonly fields: readonly CollectField[];
}

interface ParsedBlock {
  config?: {
    id: string;
    submit: "member" | "editor" | "owner";
    fields: readonly CollectField[];
  };
  error?: string;
  line: number;
}

/**
 * The form inside **one** fence, addressed by the fence itself.
 *
 * The renderer walks the note's blocks and swaps a `form` fence for a form, so
 * it needs the block in front of it parsed — not the nth entry of a
 * note-level list. Those two drift the moment a note carries a form that is
 * dropped (a broken one, an editors-only one), and the drift puts one form's
 * fields under another form's heading.
 *
 * `source` is the fence BODY, without the marker lines the parser scans for,
 * so they are put back. Cheaper than teaching the grammar a second entry
 * point, and there is exactly one grammar either way.
 *
 * **The rebuilt marker is longer than anything in the body**, and that is what
 * turns a silent truncation into a refusal. `markdown.ts` accepts `~~~form` as
 * well as ```` ```form ````, so a body really can reach here with a bare
 * ```` ``` ```` line in it. Such a line is never valid inside a form block —
 * every line is `key: value`, a field entry, a comment or blank — so the right
 * answer is always "this is not a form". Rebuild with a bare ```` ``` ````
 * instead and the fence closes at that line, the lines *above* it parse as a
 * whole form, and the page draws one missing every field below. A longer
 * marker cannot be closed by anything inside, so the grammar sees the body
 * entire and refuses it.
 */
export function formInFence(source: string): CollectForm | null {
  const marker = "`".repeat(longestFence(source) + 1);
  const blocks = parseFormBlocks(`${marker}form\n${source}\n${marker}`) as ParsedBlock[];
  return blocks.length === 1 ? answerable(blocks[0]!) : null;
}

/** The longest run of backticks opening a line in `source`, or 2. */
function longestFence(source: string): number {
  let longest = 2;
  for (const line of source.split("\n")) {
    const run = /^\s*(`{3,})/.exec(line);
    if (run !== null) longest = Math.max(longest, run[1]!.length);
  }
  return longest;
}

/**
 * The form a code block should be drawn as, or `null` to draw the block.
 *
 * **The one place that decision is made**, called by `ShareScreen` and by the
 * test that proves a read link draws the block. It used to be a closure in the
 * screen with a copy of it in the test, which is the #755 shape exactly: the
 * logic correct where it was checked and wrong where it ran.
 *
 * Three conditions, and `collecting` is the one that matters. It comes from
 * the server — `readSharedNote` reports it off the share row — and never from
 * the note's own text: a note carrying a form block is not the same thing as a
 * link its owner published to collect through, and a page that inferred one
 * from the other would draw a Send button on every shared note that happened
 * to have a form on it.
 */
export function fenceAsForm(
  block: { text: string; language?: string },
  options: { collecting: boolean },
): CollectForm | null {
  if (!options.collecting) return null;
  if (block.language?.toLowerCase() !== FORM_FENCE_LANG) return null;
  return formInFence(block.text);
}

/**
 * One parsed block, or `null` if a stranger must not be shown it as a form.
 *
 * Two filters, and each is the page telling the truth rather than being tidy:
 *
 *  - **A block that did not parse is dropped.** The reader is not the author
 *    and cannot fix it; a half-built form with the fields it managed to read
 *    would collect answers into a shape nobody declared. `docs/decisions/forms.md`
 *    calls this "inert rather than half-working", and the author sees the error
 *    in their own console, where it can be fixed.
 *  - **A form that only editors may answer is dropped.** The server refuses it
 *    through a link — `roleAtLeast` does that, not a second policy — so drawing
 *    a Send button on one is drawing a button that is going to fail. Saying
 *    nothing is better than saying "sorry" after somebody typed.
 *
 * Either way the fence falls through to the ordinary code block, so the reader
 * still sees what is on the note.
 */
function answerable(block: ParsedBlock): CollectForm | null {
  const config = block.config;
  if (config === undefined) return null;
  if (config.submit !== "member") return null;
  return { id: config.id, submit: config.submit, fields: config.fields };
}

/**
 * An empty answer for every field, keyed by name.
 *
 * Every field, including the ones nobody has to fill in: a controlled input
 * whose value arrives as `undefined` and later becomes a string is the React
 * warning about switching from uncontrolled to controlled, and the visible
 * symptom is a box that loses what was typed in it.
 *
 * A checkbox starts `"no"` rather than empty, because `validateSubmission`
 * reads a checkbox as a word and "" is not one of its two.
 */
export function blankAnswers(form: CollectForm): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const field of form.fields) {
    answers[field.name] = field.type === "checkbox" ? "no" : "";
  }
  return answers;
}

/** What `submitThroughLink` takes, or why it cannot be built yet. */
export type Sendable =
  | { ok: true; values: { field: string; value: string }[] }
  | { ok: false; error: string };

/**
 * The answers as the server wants them, or the first thing wrong with them.
 *
 * The order is the whole point: `validateSubmission` is asked, and what it
 * hands back is **its** normalization — the trimmed line, the canonical `yes`,
 * the number as a string — not what was typed. A page that sent the raw boxes
 * and only used the validator for a yes/no would be a page where "valid here"
 * and "valid there" are two different questions.
 */
export function sendable(form: CollectForm, answers: Record<string, string>): Sendable {
  const supplied: Record<string, string> = {};
  for (const field of form.fields) {
    supplied[field.name] = answers[field.name] ?? "";
  }
  const checked = validateSubmission(form as unknown as Parameters<typeof validateSubmission>[0], supplied) as {
    values?: Record<string, string>;
    error?: string;
  };
  if (checked.error !== undefined || checked.values === undefined) {
    return { ok: false, error: checked.error ?? "that form could not be read" };
  }
  const values = Object.entries(checked.values).map(([field, value]) => ({ field, value }));
  return { ok: true, values };
}

/**
 * The label a field gets, from the name its author wrote.
 *
 * `client_name` reads as "Client name" to the person filling it in and stays
 * `client_name` in the answers file, which is the author's column heading.
 * Nothing is renamed — this is presentation, and the wire keeps the name.
 */
export function fieldLabel(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  if (words === "") return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the visitor is told when the answer did not land, by code.
 *
 * Every one of these is a fact about **this submission** that the person can
 * act on. The one refusal that is deliberately vague is the link itself:
 * revoked, expired, never existed and not-collecting all arrive as
 * `LINK_NOT_COLLECTING` and all say the same sentence, because a stranger
 * holding a URL must not be able to tell a link that was taken back from one
 * that never was.
 */
export function refusalText(code: string | null, fallback: string): string {
  switch (code) {
    case "LINK_NOT_COLLECTING":
      return "This form is not taking answers. Ask whoever sent you the link.";
    case "COLLECT_CAP_REACHED":
      return "This form has taken all the answers it was set up for.";
    case "CONTEXT_READ_ONLY":
      return "This form is not taking new answers right now.";
    case "CHALLENGE_REFUSED":
      return fallback;
    case "FORM_INVALID":
      return fallback;
    default:
      return fallback === "" ? "That did not send. Try again in a moment." : fallback;
  }
}

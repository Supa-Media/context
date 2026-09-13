/**
 * Writing a ```` ```form ```` block, with the editor offering what fits.
 *
 * The owner's ask, twice: "how can we give helpers so that they are
 * writing/building the right form format", and then the shape it should take —
 * "Im not really thinking of adding a full UI, Im thinking more so that we have
 * auto complete for when people do add a form, that allows them to easily see
 * the accepted fields, it should all be text editable".
 *
 * So this is not a builder and nothing here writes a block on somebody's
 * behalf. It answers one question — *what is allowed where the caret is* — and
 * the answer comes from the grammar rather than from a list kept here. An agent
 * writes these blocks from the tool schema; a person writes them from this.
 *
 * ## Why the choices can be a fixed table when the grammar is elsewhere
 *
 * `docs/decisions/forms.md` states it as a design constraint rather than a
 * coincidence: "the grammar is a small strict subset precisely so that what
 * autocomplete offers and what the gateway accepts can be the same list." The
 * vocabularies below are `CONFIG_KEYS`, `FIELD_KEYS`, `FIELD_TYPES`, `LAYOUTS`,
 * `SUBMIT_ROLES` and `VOTE_MODES` from `apps/mcp/src/forms.js` — and they are
 * not re-typed on trust: `__tests__/formComplete.test.ts` parses the offers
 * back through `parseFormBlocks` and fails if this file ever suggests something
 * the grammar refuses.
 *
 * ## Context is read off the text, not off the tree
 *
 * A pure function of the document and a position, which is what makes every
 * case below a test with no editor in it. It also sidesteps the reason
 * `livePreview.ts` keeps saying "off the text rather than off a `CodeText`
 * child": the Markdown grammar parses the inside of some fences into nodes and
 * not others, and a `form` fence is unhighlighted, so the tree has little to
 * say about where inside one the caret is.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { FORM_FENCE_LANG } from "../../../../mcp/src/forms.js";

/** One offer: what is shown, what is written, and a word about why. */
export interface FormChoice {
  readonly label: string;
  /** What replaces the typed word. Defaults to `label`. */
  readonly insert?: string;
  /** How far back into the inserted text the caret lands, from its end. */
  readonly caretBack?: number;
  readonly detail?: string;
}

/** Where the caret is, as far as the grammar is concerned. */
export type FormSpot =
  | { kind: "fence-info" }
  | { kind: "key" }
  | { kind: "key-value"; key: string }
  | { kind: "field-entry" }
  | { kind: "field-key" }
  | { kind: "field-value"; key: string };

const CONFIG_KEYS: ReadonlyArray<FormChoice> = [
  { label: "id", insert: "id: ", detail: "this form’s name, [a-z0-9-]" },
  { label: "responses", insert: "responses: ", detail: "the note answers are written to" },
  { label: "layout", insert: "layout: table", detail: "table or sections" },
  { label: "submit", insert: "submit: member", detail: "lowest role that may answer" },
  { label: "edit_own", insert: "edit_own: true", detail: "may people change their answer" },
  { label: "show_responses", insert: "show_responses: true", detail: "draw readable responses below" },
  { label: "votes", insert: "votes: named", detail: "named or off" },
  { label: "fields", insert: "fields:\n  - { name: , type: line, max: 120 }", caretBack: 26, detail: "the questions, one per line" },
];

const FIELD_KEYS: ReadonlyArray<FormChoice> = [
  { label: "name", insert: "name: ", detail: "[a-z][a-z0-9_]*, not id/by/at/votes" },
  { label: "type", insert: "type: line", detail: "line, text, select, number, date, checkbox" },
  { label: "max", insert: "max: 120", detail: "required on line and text" },
  { label: "min", insert: "min: 0", detail: "number only" },
  { label: "required", insert: "required: true" },
  { label: "options", insert: "options: [a, b]", caretBack: 6, detail: "select only" },
];

const FIELD_TYPES: ReadonlyArray<FormChoice> = [
  { label: "line", detail: "one line of text; needs max" },
  { label: "text", detail: "a paragraph; needs max" },
  { label: "select", detail: "one of options" },
  { label: "number", detail: "min and max bound it" },
  { label: "date", detail: "2026-09-12" },
  { label: "checkbox", detail: "yes or no" },
];

const VALUES: ReadonlyMap<string, ReadonlyArray<FormChoice>> = new Map([
  ["layout", [
    { label: "table", detail: "one row per response" },
    { label: "sections", detail: "one heading per response" },
  ]],
  ["submit", [
    { label: "member", detail: "anybody in the context" },
    { label: "editor", detail: "people who can write notes" },
    { label: "owner", detail: "the owner alone" },
  ]],
  ["votes", [
    { label: "named", detail: "upvotes, with the voters listed" },
    { label: "off", detail: "no voting" },
  ]],
  ["edit_own", [
    { label: "true", detail: "a submitter may change or withdraw theirs" },
    { label: "false", detail: "answers are final once sent" },
  ]],
  ["show_responses", [
    { label: "true", detail: "show responses when the viewer may read them" },
    { label: "false", detail: "keep responses out of the form" },
  ]],
  ["required", [{ label: "true" }, { label: "false" }]],
]);

/**
 * A whole block, offered where a fence's language would go.
 *
 * The one place this file writes more than a word, and the reason is the one
 * the owner named: a person who has never seen a form block cannot autocomplete
 * their way into one key at a time, because they do not know the first key.
 * Typing three backticks and `f` is a thing somebody does by accident on the
 * way to a code block, so it is offered rather than inserted, and what it
 * inserts is a form that parses as it stands.
 */
const STARTER = `${FORM_FENCE_LANG}
id: feedback
responses: feedback-responses.md
layout: table
submit: member
edit_own: true
show_responses: false
votes: named
fields:
  - { name: summary, type: line, max: 120, required: true }
  - { name: detail, type: text, max: 2000 }`;

/* -------------------------------------------------------------------------- */

/** The word being typed immediately before `pos`, and where it starts. */
function wordBefore(text: string, pattern: RegExp): { word: string; back: number } {
  const match = pattern.exec(text);
  const word = match === null ? "" : match[0];
  return { word, back: word.length };
}

/**
 * Is the caret inside an open `form` fence, and on which line of its body?
 *
 * Walks fences in order exactly as `parseFormBlocks` does — the only honest way
 * to know which fence a line closes, and the reason that function scans lines
 * rather than matching a regex over the note. A caret inside an ordinary code
 * block that happens to *quote* a form block is therefore not inside a form,
 * which is the case a regex gets wrong.
 */
export function formFenceAt(
  doc: string,
  pos: number,
): { body: string[]; lineInBody: number } | null {
  const upto = doc.slice(0, pos);
  const lines = upto.split("\n");
  let fence: string | null = null;
  let isForm = false;
  let bodyStart = 0;

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (fence === null) {
      const opener = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
      if (opener !== null) {
        fence = opener[2];
        isForm = opener[3].toLowerCase() === FORM_FENCE_LANG;
        bodyStart = i + 1;
      }
      continue;
    }
    const closer = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(line);
    if (closer !== null && closer[2][0] === fence[0] && closer[2].length >= fence.length) {
      fence = null;
      isForm = false;
    }
  }
  if (fence === null || !isForm) return null;
  return { body: lines.slice(bodyStart, lines.length - 1), lineInBody: lines.length - 1 - bodyStart };
}

/**
 * What the caret is in the middle of, or `null` if nothing is offered here.
 *
 * Exported with `FormSpot` because the interesting half of this feature is
 * which positions it *refuses* — the same reason `openWikilink` is exported
 * next door. Offering config keys inside a `{ … }`, or field types on a line
 * that is not one, is how an autocompletion starts producing blocks that do not
 * parse.
 */
export function formSpotAt(doc: string, pos: number): { spot: FormSpot; back: number } | null {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const before = doc.slice(lineStart, pos);

  const inside = formFenceAt(doc, pos);
  if (inside === null) {
    // Not in a form. The one offer outside one is the block itself, on a fence
    // that has just been opened and not yet named.
    const opening = /^(\s{0,3})(`{3,}|~{3,})([a-z]*)$/.exec(before);
    if (opening === null) return null;
    return { spot: { kind: "fence-info" }, back: opening[3].length };
  }

  // Inside a `{ … }` field entry: the braces decide, not the indentation, so a
  // continuation typed without the leading `- ` is still read as one.
  const brace = before.lastIndexOf("{");
  if (brace !== -1 && !before.slice(brace).includes("}")) {
    const segment = before.slice(brace + 1);
    const pair = /(?:^|,)\s*([a-z_]+)\s*:\s*([^,]*)$/.exec(segment);
    if (pair !== null) {
      const typed = wordBefore(pair[2], /[A-Za-z0-9_.-]*$/);
      return { spot: { kind: "field-value", key: pair[1] }, back: typed.back };
    }
    const typed = wordBefore(segment, /[a-z_]*$/);
    return { spot: { kind: "field-key" }, back: typed.back };
  }

  // A list item under `fields:`. Offered only where a list item is legal, which
  // is a line indented under a `fields:` that has already been written.
  const item = /^\s+-\s*$/.exec(before);
  if (item !== null && inside.body.some((line) => /^fields\s*:\s*$/.test(line))) {
    return { spot: { kind: "field-entry" }, back: 0 };
  }

  const keyed = /^([a-z_]+)\s*:\s*([^:]*)$/.exec(before);
  if (keyed !== null) {
    const typed = wordBefore(keyed[2], /[A-Za-z0-9_.-]*$/);
    return { spot: { kind: "key-value", key: keyed[1] }, back: typed.back };
  }

  const typed = wordBefore(before, /^[a-z_]*$/);
  if (typed.word !== before.trimStart() && before.trim() !== "") return null;
  return { spot: { kind: "key" }, back: typed.back };
}

/** The offers for one spot, in the order they should be read. */
export function formChoicesFor(spot: FormSpot, body: readonly string[] = []): FormChoice[] {
  switch (spot.kind) {
    case "fence-info":
      return [{ label: FORM_FENCE_LANG, insert: STARTER, detail: "a form people can fill in" }];
    case "key": {
      // A key already written is not offered again — the grammar refuses a
      // repeat with `"x" is set twice`, so offering one is offering an error.
      const used = new Set(
        body.flatMap((line) => {
          const match = /^([a-z_]+)\s*:/.exec(line);
          return match === null ? [] : [match[1]];
        }),
      );
      return CONFIG_KEYS.filter((choice) => !used.has(choice.label));
    }
    case "key-value":
      return [...(VALUES.get(spot.key) ?? [])];
    case "field-entry":
      return [
        { label: "{ … }", insert: "{ name: , type: line, max: 120 }", caretBack: 24, detail: "a question" },
      ];
    case "field-key":
      return [...FIELD_KEYS];
    case "field-value":
      return spot.key === "type" ? [...FIELD_TYPES] : [...(VALUES.get(spot.key) ?? [])];
  }
}

/* -------------------------------------------------------------------------- */

/**
 * The completion source, for the one `autocompletion` this editor configures.
 *
 * A source rather than an extension: CodeMirror's `override` is a single list,
 * and two `autocompletion()` calls each passing one would leave whichever
 * combined last as the editor's only source — see `editorCompletion`.
 */
export function formCompletionSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const found = formSpotAt(doc, context.pos);
    if (found === null) return null;

    /*
      Typing opens the list; an explicit request is not required. That is the
      opposite of the `[[` source's rule next door and the difference is real:
      there, two keystrokes of a link are enough to mean something and the list
      would be in the way. Here the whole point is that nobody knows the
      vocabulary, so it has to appear without being summoned.
    */
    const choices = formChoicesFor(found.spot, formFenceAt(doc, context.pos)?.body ?? []);
    if (choices.length === 0) return null;

    const options: Completion[] = choices.map((choice) => ({
      label: choice.label,
      detail: choice.detail,
      type: "keyword",
      apply: (view, _completion, from, to) => {
        const insert = choice.insert ?? choice.label;
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length - (choice.caretBack ?? 0) },
          userEvent: "input.complete",
        });
      },
    }));

    return { from: context.pos - found.back, options };
  };
}

/** For a surface that wants only this one — the tests, and nothing else yet. */
export function formCompletion(): Extension {
  return autocompletion({ override: [formCompletionSource()], closeOnBlur: true });
}

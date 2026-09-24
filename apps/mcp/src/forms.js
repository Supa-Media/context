/**
 * Markdown forms: the grammar, the validator, and the response renderer.
 *
 * ## What this file is for
 *
 * A note may carry a fenced ```form block. That block declares fields and one
 * policy — who may submit, whether a submitter may edit their own answer,
 * whether votes are kept. Answers are written to a **separate note**, named by
 * the block, whose visibility is decided the ordinary way in `privacy.md` and
 * never by the block. The gateway renders every response row itself; a
 * submitter sends values and never Markdown.
 *
 * ## Three rules hold the whole design up
 *
 * 1. **The gateway writes the response file, so it can round-trip it.**
 *    Editing one answer or taking back one vote means finding a response in a
 *    file and rewriting it, which means parsing back what we rendered. So
 *    `renderResponsesFile(parseResponsesFile(x))` must equal `x` for anything
 *    we produced — that is the property `formsRoundTrip` checks, and every
 *    escaping rule below exists to keep it true for arbitrary submitted text.
 *
 * 2. **A block that does not parse makes the form inert, never half-working.**
 *    Same discipline as the privacy manifest: fail closed. `parseFormBlocks`
 *    returns the error rather than a best guess, callers refuse submissions,
 *    and the surrounding note stays ordinary readable Markdown.
 *
 * 3. **Layout is declared, not inferred.** `table` puts a response on one row;
 *    `sections` gives it a heading. A paragraph field in a table is allowed —
 *    it renders cramped, which is the author's call to make. What is *not*
 *    allowed is losing it: a raw newline in a cell would end the row and spill
 *    the rest of the answer out of the table, so cells are escaped.
 *
 * Zero dependencies, Workers runtime: no Node APIs, no YAML library. The
 * grammar is deliberately a small strict subset rather than "some YAML", so
 * that what an editor's autocomplete offers and what this accepts are the same
 * list.
 *
 * Split by responsibility into `forms/`: `grammar.js` (the constants),
 * `parseBlock.js` (the fence), `config.js` (the config), `validate.js`
 * (submitted values), `render.js` and `renderBlock.js` (rendering), and
 * `parseResponses.js` (parsing). This file re-exports the same names it
 * always has.
 */

export { FORM_FENCE_LANG } from "./forms/grammar.js";
export { parseFormBlocks } from "./forms/parseBlock.js";
export { validateSubmission } from "./forms/validate.js";
export {
  responsesMarker,
  emptyResponsesFile,
  newResponseId,
  responseStamp,
  renderResponsesFile,
  escapeCell,
  unescapeCell,
  escapeBlock,
  unescapeBlock,
} from "./forms/render.js";
export { parseResponsesFile } from "./forms/parseResponses.js";
export { renderFormBlock } from "./forms/renderBlock.js";

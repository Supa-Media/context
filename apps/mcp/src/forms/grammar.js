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
 */

/** The info string that marks a fenced block as a form. */
export const FORM_FENCE_LANG = "form";

/** Field types, and whether a value may span lines. */
export const FIELD_TYPES = new Map([
  ["line", { multiline: false, needsMax: true }],
  ["text", { multiline: true, needsMax: true }],
  ["select", { multiline: false, needsMax: false }],
  ["number", { multiline: false, needsMax: false }],
  ["date", { multiline: false, needsMax: false }],
  ["checkbox", { multiline: false, needsMax: false }],
]);

/** Every key the block accepts. Anything else is an error, not a warning. */
export const CONFIG_KEYS = new Set([
  "id",
  "responses",
  "layout",
  "submit",
  "edit_own",
  "show_responses",
  "votes",
  "notify",
  "fields",
]);

/** Every key one field entry accepts. */
export const FIELD_KEYS = new Set(["name", "type", "max", "min", "required", "options"]);

export const LAYOUTS = new Set(["table", "sections"]);
export const SUBMIT_ROLES = new Set(["member", "editor", "owner"]);
export const VOTE_MODES = new Set(["named", "off"]);

/**
 * Who gets told when an answer arrives — a *person*, never an address.
 *
 * `owner`, or a handle. This is the narrowest part of the notification feature
 * and the narrowness is the feature, so it is stated here rather than in the
 * decision doc alone.
 *
 * A form block sits in a note **any editor can rewrite**, which is already the
 * stated reason `responses:` names a path and never a visibility: an edit to a
 * code fence must not be able to do what `set_visibility` does with a
 * confirmation step and an audit line. An email address in this position would
 * be strictly worse than a visibility flag, because it is not a permission at
 * all — it is an **egress destination**. One line changed in Obsidian would
 * redirect every future answer to somebody else's inbox, and the form's owner
 * would see nothing.
 *
 * It is worse again once the form is published. A collect link takes answers
 * from strangers with no account, so an address here would make every
 * published form a mail relay whose destination one editor chooses and whose
 * *content* any stranger supplies — on our own sending domain. That is the
 * threat `functions/invitationEmail.ts` already fences on four sides, and it
 * fences it by never letting the sender choose a stranger's address either.
 *
 * So the block names a person and the **control plane resolves where**, exactly
 * as `ingestionSettings` decides who may post into a context by mail: an
 * identity, a live membership, a verified address. Context can mail a member of
 * this workspace and nobody else, and removing somebody's membership stops
 * their mail without anybody editing a note.
 *
 * The shape is all this file can check. Whether `@dan` is a member here, holds
 * a verified address, and may read the answers file is three questions about
 * state this module has never had access to, and they are asked where they can
 * be answered — see `apps/convex/functions/formNotify.ts`.
 *
 * Two characters are the whole grammar's business: the leading `@` tells a
 * handle from the literal `owner`, and `names.ts` claims `[a-z0-9-]{2,32}`, so
 * a value that parses here can hold no space, no delimiter and no line break.
 * That is not an accident to rely on quietly — the renderer below refuses
 * anything else, and `renderFormBlock` writes this value into a line-oriented
 * format where a newline would become a second key.
 */
export const NOTIFY_RE = /^(?:owner|@[a-z0-9-]{2,32})$/;

/**
 * Column headings the renderer owns, so a field may not be called one of them.
 *
 * Case-insensitive: a field named `votes` and the votes column would render two
 * columns with one heading, and parsing that back is a guess.
 */
export const RESERVED_FIELD_NAMES = new Set(["id", "by", "at", "votes"]);

export const MAX_FIELDS = 24;
export const MAX_OPTIONS = 24;
export const MAX_OPTION_LENGTH = 64;
export const MAX_LINE_CAP = 500;
export const MAX_TEXT_CAP = 20000;

export const FORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const RESPONSE_ID_RE = /^r-[0-9a-f]{8}$/;

/**
 * A response's header line in the `sections` layout: `## <id> · <by> · <at>`.
 *
 * One constant because there are two readers of it — the scan for the first
 * header and the walk that builds the responses — and a header the first one
 * finds but the second does not would silently drop a response.
 *
 * **`by` is the only field that may hold a space.** The id and the timestamp
 * are shapes this module writes; `by` is a *stamp*, and a stamp is not always
 * a handle. A username cannot hold a space — `names.ts` claims
 * `[a-z0-9][a-z0-9-]{0,62}` — so `(\S+)` was a contract that held for as long
 * as every answer came from somebody with an account. An answer that arrives
 * through a published link is stamped with the link instead ("via @name/slug"),
 * which `renderSections` writes into this line unescaped and this expression
 * then could not read back. The file is rewritten in full on every submission,
 * edit, retraction and vote, so one unreadable header is not one lost row: it
 * is the next answer from anybody refused, with a message blaming prose the
 * author never wrote.
 *
 * `·` is the delimiter and therefore the one character `by` may not hold.
 * Nothing that reaches it can: a username is `[a-z0-9-]`, and a link stamp is
 * built from a handle and a slug.
 */
export const SECTION_HEADER_RE = /^##\s+(\S+)\s+·\s+([^·]+?)\s+·\s+(\S+)\s*$/;


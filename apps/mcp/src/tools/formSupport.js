/** Role checks, response-file reads and argument shaping shared by the form tools. Moved verbatim out of `src/index.js`. */

import { eligible as collaborationEligible, supported as collaborationSupported, readDocument as readCollaborationDocument } from "@context/collaboration";
import { encryptedNoteRefusal, openStoredNote } from "../notes/sealing.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { parseResponsesFile } from "../forms.js";
import { toolError } from "./results.js";

/* --------------------------------- forms ---------------------------------- */

/**
 * Form participation, and the four tools that are all one write.
 *
 * ## Why a submission is not a note write
 *
 * A form collects answers from people who cannot write notes. A `member` of a
 * shared workspace holds no `context:write` in it — by `effectiveScopes`, and
 * correctly — so every path below writes a file the caller could not write
 * directly. Three things keep that from being a hole:
 *
 *  - **The caller never supplies Markdown.** They send values; `forms.js`
 *    checks them against the declared fields and renders the row. There is no
 *    argument on any of these tools that reaches the file as text.
 *  - **The destination is the form's, not the caller's.** `responses:` is read
 *    out of a note an editor wrote, and the response file must already carry
 *    this form's marker — so a submission cannot be aimed at `index.md`, and a
 *    file that is not a response file is never written to.
 *  - **Identity is stamped, never claimed.** `by` comes from
 *    `store.actor.name`, and every ownership test compares against that.
 *
 * ## Why the whole file is rewritten every time
 *
 * Both layouts have structure a bare append cannot maintain — a table has a
 * header, and an edit or a vote changes a response in the middle. So each
 * mutation reads the file, parses it back, changes one response, and rewrites
 * it under the etag it read. That makes the round-trip property in `forms.js`
 * load-bearing rather than decorative: a parse that loses a character loses it
 * from everybody's response, not just the one being edited.
 *
 * ## Why a store without conditional writes is refused
 *
 * A form is the most contended write this gateway has: a bug tracker shared
 * with everybody is many people appending to one file. Without `If-Match` two
 * submissions a second apart silently become one. B2 and Wasabi do not support
 * it reliably, the adapter probes for it at connect time, and the honest
 * answer on such a store is to refuse the submission rather than take it and
 * lose it.
 */

/** How many times a mutation re-reads and re-applies before giving up. */
export const FORM_WRITE_ATTEMPTS = 4;

/** Roles, ordered, so a form's `submit` policy can be compared against one. */
const ROLE_RANK = new Map([
  ["member", 1],
  ["editor", 2],
  ["owner", 3],
]);

export function roleAtLeast(role, required) {
  const held = ROLE_RANK.get(role) || 0;
  const needed = ROLE_RANK.get(required) || ROLE_RANK.get("member");
  return held >= needed;
}

/**
 * What a caller who cannot read the response file is told when it is unusable.
 *
 * One message for every reason — absent, not a response file, another form's,
 * another layout, encrypted — because each of those is a fact about a file
 * this caller may not read, and `docs/decisions/forms.md` refuses "a lookup
 * that tells somebody something about a file they may not read". A member
 * submitting to a private drop-box gets this too, which is the honest cost:
 * they could not have read the reason anyway, and the line points at somebody
 * who can.
 */
export const RESPONSE_FILE_UNUSABLE =
  "this form is not collecting responses right now. An editor of this context can check the " +
  "file it collects into; nothing has been written.";

/** Whoever is calling, as a form records and authorizes them. */
export function formActor(store) {
  return { name: store.actor?.name || null, role: store.actor?.role || null };
}

/** Read the response file back, refusing anything this gateway did not write. */
export async function readFormResponses(store, config, responsesPath) {
  const object = await getWithLegacyFallback(store, responsesPath);
  if (!object) return { missing: true };
  const stored = await object.text();
  const opened = await openStoredNote(store, stored);
  if (!opened.ok) return { refusal: encryptedNoteRefusal(responsesPath) };
  let text = opened.text;
  let collaboration = null;
  if (collaborationSupported(store) && collaborationEligible(responsesPath, text)) {
    try {
      collaboration = await readCollaborationDocument(store, responsesPath);
      text = collaboration.text;
    } catch {
      return { refusal: toolError("this response file cannot be updated safely right now") };
    }
  }
  const parsed = parseResponsesFile(text, config);
  if (parsed.error) return { refusal: toolError(parsed.error) };
  return {
    etag: collaboration?.etag ?? object.etag,
    stored,
    responses: parsed.responses,
    ...(collaboration ? { collaboration } : {}),
  };
}

/**
 * `[{ field, value }]` → `{ field: value }`.
 *
 * The wire shape is a list of pairs rather than an object of answers because a
 * form's field names are the author's, not the schema's, and this gateway
 * refuses to advertise an object node it cannot close — an open one at that
 * position would accept anything a prompt-injected client put there, which is
 * the whole reason `toolArguments.js` exists. A duplicate field is refused
 * rather than resolved: two answers to one question have no right answer.
 */
export function valuesFromPairs(pairs) {
  if (!Array.isArray(pairs)) return { error: "values must be a list of { field, value } entries" };
  const values = {};
  for (const pair of pairs) {
    const field = pair?.field;
    if (Object.prototype.hasOwnProperty.call(values, field)) {
      return { error: `"${field}" is answered twice` };
    }
    values[field] = pair?.value;
  }
  return { values };
}

/**
 * Who can read the answers, in the caller's own words.
 *
 * Three cases, not two. A note held to a named group is neither `team` nor
 * `private`, and "only this person can read the answers" said of one would be
 * the control lying in the direction that matters. Only ever called for a
 * destination the caller may collect into — see `toolCreateForm`.
 */
export function whoReads(visibility) {
  if (visibility === "team") {
    return (
      "Everyone with team access to this context can read the answers. " +
      "Call set_visibility to hold them back."
    );
  }
  if (visibility === "private") {
    return (
      "Only this context's owner can read the answers. " +
      "Call set_visibility to share them with the team."
    );
  }
  return `The answers are held to ${visibility}: only the people that rule names can read them.`;
}

/** A form id from the note's own filename, which is what an author would pick. */
export function defaultFormId(stem) {
  const name = stem.slice(stem.lastIndexOf("/") + 1);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "form";
}

/**
 * The ownership test both editing tools share.
 *
 * An editor of the context may act on anybody's response — they can already
 * rewrite the whole file with `write_note`, so refusing here would be a lock on
 * a door standing open. A submitter may act on their own, and only where the
 * form's author allowed it.
 */
export function mayChangeResponse(response, config, actor, verb) {
  if (roleAtLeast(actor.role, "editor")) return null;
  if (response.by !== actor.name) {
    return toolError(`permission denied: that response is ${response.by}'s, not yours.`);
  }
  if (!config.edit_own) {
    return toolError(`permission denied: this form does not let people ${verb} their own response.`);
  }
  return null;
}

/**
 * Form participation from the console, by somebody who cannot write notes.
 *
 * ## Why this exists at all, rather than calling the gateway
 *
 * The gateway already implements forms, and the console cannot reach it. The
 * console writes through Convex — `files.writeNote` opens the bucket with the
 * shared store factory — and the web console holds no MCP grant: the
 * auto-approved grant in `docs/decisions/identity-and-access.md` is the desktop
 * shell's alone, gated on a `127.0.0.1` redirect, and that decision explicitly
 * refuses to make itself general. So a member filling in a form on a page they
 * are reading has no path through the gateway, and needs one here.
 *
 * ## What is shared and what is not
 *
 * **The format is not reimplemented.** `apps/mcp/src/forms.js` is pure — no
 * store, no session, no Workers API — so the block grammar, the value
 * validation, the escaping and the response renderer are imported and used
 * unchanged. A form written through an AI client and a form filled in from the
 * console produce byte-identical rows, because they are the same renderer.
 *
 * **The authorization is.** `participatesInForms` lives on a gateway session
 * and has no meaning here: the console's caller is a Convex identity, and what
 * stands in for the grant's write scope is that they are signed in as
 * themselves in a first-party surface. What must agree across the two is the
 * part a person would notice being wrong — which role may submit, whose
 * response may be edited, whether a vote is idempotent — and
 * `__tests__/formsAuthorization.test.ts` asserts that against the gateway's own
 * rules rather than restating them in a comment.
 *
 * That is the same arrangement `lib/privacy.ts` already has with the gateway's
 * privacy engine, and it is accepted here for the same reason: two callers with
 * genuinely different inputs, one differential test proving one answer.
 *
 * ## The response file is written without being readable
 *
 * A form's answers may be held back from the people who submit them — a survey
 * whose responses only the team reads. So the response file is opened with
 * `store.get` directly rather than through `readFile`, deliberately bypassing
 * `canSee`: this is a **write-only** path into one file an editor named, and the
 * caller is never handed its contents. `submitForm` returns an id and nothing
 * else. Every read the console makes of that file still goes through `readFile`
 * and is still refused when the manifest says so.
 */

import {
  emptyResponsesFile,
  newResponseId,
  parseFormBlocks,
  parseResponsesFile,
  renderResponsesFile,
  responseStamp,
  validateSubmission,
} from "../../../mcp/src/forms.js";
import {
  FileOpError,
  loadPrivacyState,
  normalizePath,
  type FileErrorCode,
  type FileStore,
} from "./fileOps";
import { canSee, isPlumbing } from "./privacy";
import { type Clearance } from "./clearance";
import type { Scope } from "./privacy";
import { isEncryptedNote } from "./noteEncryption";

/** One refusal shape, so no branch below phrases its own. */
function refuse(code: FileErrorCode, message: string): FileOpError {
  return new FileOpError(code, message);
}

/** How many times a mutation re-reads and re-applies before giving up. */
const WRITE_ATTEMPTS = 4;

export type WorkspaceRole = "owner" | "editor" | "member";

const ROLE_RANK: Record<WorkspaceRole, number> = { member: 1, editor: 2, owner: 3 };

function roleAtLeast(held: WorkspaceRole, required: string): boolean {
  const needed = ROLE_RANK[(required as WorkspaceRole) in ROLE_RANK ? (required as WorkspaceRole) : "member"];
  return ROLE_RANK[held] >= needed;
}

/** Who is acting, as a form records and authorizes them. */
export interface FormActor {
  /**
   * Their username, with the `@` — or, for an answer sent through a collect
   * link, the link itself. Stamped on the row; never taken from input.
   */
  name: string;
  role: WorkspaceRole;
}

/**
 * What an answer sent through a collect link is stamped with.
 *
 * Readable, because an owner reading their own answers needs to know which
 * came from a stranger and through which link — and **unusable as an
 * identity**, because it holds a space and a slash, which `names.ts` forbids
 * in a handle (`[a-z0-9][a-z0-9-]{0,62}`). So no person can ever be stamped
 * with one, and no link can be mistaken for a person.
 */
export function linkStamp(handle: string, slug: string | null): string {
  return slug === null ? `via a link to @${handle}` : `via @${handle}/${slug}`;
}

/** Whether a stamp names a link rather than a person. See `linkStamp`. */
export function isLinkStamp(by: string): boolean {
  return by.startsWith("via ");
}

export interface FormAnswer {
  field: string;
  value: string;
}

export type FormAction =
  | { kind: "submit"; values: FormAnswer[] }
  | { kind: "update"; responseId: string; values: FormAnswer[] }
  | { kind: "retract"; responseId: string }
  | { kind: "vote"; responseId: string; vote: "up" | "none" };

export interface FormResult {
  /** The response this call created or changed. */
  responseId: string;
  /** The form's id, echoed so the console can confirm which block acted. */
  formId: string;
  /** The response file, so the caller can refresh a listing that is now stale. */
  responsesPath: string;
  /** How many votes the response carries now. Absent where the form has none. */
  votes?: number;
  /**
   * Who to tell, when this call was a submission to a form that names
   * somebody. Absent otherwise, and identifiers only — see
   * `FormNotifyMaterial`.
   *
   * It is deliberately **not** part of what `runFileOperation` returns to its
   * caller — see the `form` branch there. A submitter gets their response id;
   * they do not get told who the form tells.
   */
  notify?: FormNotifyMaterial;
}

/**
 * The identifiers a notification needs, and deliberately not the answers.
 *
 * **No field values, no submitter, no timestamp.** This travels as the
 * arguments of a scheduled job, and Convex persists a scheduled job's arguments
 * until it runs — so answers in here would be note content stored in the
 * control plane, which non-negotiable #1 says never happens. It is a short
 * window and it is still the wrong side of a line that is absolute on purpose.
 *
 * So the content is read back at delivery, from the customer's bucket, through
 * `canSee` **as the recipient** — see `readResponseForNotification`. That costs
 * one read and buys two things beyond the non-negotiable: the mail carries what
 * the file says rather than what an argument claimed, and the same call that
 * fetches it is the call that decides whether this person may have it. A
 * boolean check beside separately-carried content is two facts that can
 * disagree; this is one.
 *
 * `to` is the block's raw `notify` value — `owner`, or a handle. It is carried
 * as written and resolved in the control plane, because resolving it is three
 * questions about state this module has never had access to: is that a person,
 * are they still a member here, may they read the answers.
 */
export interface FormNotifyMaterial {
  to: string;
  formId: string;
  notePath: string;
  responsesPath: string;
}

interface FormConfigField {
  name: string;
  type: string;
  required: boolean;
  max?: number;
  min?: number;
  options?: string[];
}

interface FormConfig {
  id: string;
  responses: string;
  layout: "table" | "sections";
  submit: WorkspaceRole;
  edit_own: boolean;
  votes: "named" | "off";
  /** `owner` or a handle, when the block names somebody to tell. */
  notify?: string;
  fields: FormConfigField[];
}

interface StoredResponse {
  id: string;
  by: string;
  at: string;
  values: Record<string, string>;
  votes: string[];
}

/**
 * `[{ field, value }]` → `{ field: value }`.
 *
 * A list rather than an object on the wire because Convex validators are
 * closed the same way the gateway's tool schemas are: a free-form object of
 * caller-chosen keys is a shape neither can check. A duplicate field is refused
 * rather than resolved — two answers to one question have no right answer.
 */
function valuesFromAnswers(answers: FormAnswer[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const answer of answers) {
    if (Object.prototype.hasOwnProperty.call(values, answer.field)) {
      throw refuse("FORM_INVALID", `"${answer.field}" is answered twice.`);
    }
    values[answer.field] = answer.value;
  }
  return values;
}

/**
 * Find the form a call names, on a note the caller can already see.
 *
 * "No such note" and "a note you may not read" are one refusal, which is the
 * rule every read in this file's neighbour follows: `readFile` throws
 * `notFound()` for both, and a form is not the place to start distinguishing
 * them.
 */
async function resolveForm(
  store: FileStore,
  clearance: Clearance,
  pathInput: string,
  formId: string | undefined,
): Promise<{ config: FormConfig; responsesPath: string }> {
  const path = normalizePath(pathInput);
  if (path === null || !path.endsWith(".md")) {
    throw refuse("PATH_INVALID", "That path is not valid.");
  }
  const state = await loadPrivacyState(store);
  if (!canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) {
    throw refuse("FILE_NOT_FOUND", "That file does not exist.");
  }
  const object = await store.get(path);
  if (object === null) throw refuse("FILE_NOT_FOUND", "That file does not exist.");
  const text = await object.text();
  if (isEncryptedNote(text)) {
    throw refuse("FORM_INVALID", "That note is encrypted; the control plane holds no key for it.");
  }

  const blocks = parseFormBlocks(text) as Array<{ config?: FormConfig; error?: string; line: number }>;
  if (blocks.length === 0) throw refuse("FORM_NOT_FOUND", "That note carries no form.");

  let chosen: { config?: FormConfig; error?: string; line: number } | undefined;
  if (formId) {
    chosen = blocks.find((block) => block.config?.id === formId);
    // A block that does not parse has no id to match on, so a note whose only
    // form is broken answers with the parse error rather than "no such form".
    if (!chosen && blocks.length === 1 && blocks[0].error) chosen = blocks[0];
    if (!chosen) throw refuse("FORM_NOT_FOUND", `That note carries no form called "${formId}".`);
  } else {
    if (blocks.length > 1) {
      throw refuse("FORM_NOT_FOUND", `That note carries ${blocks.length} forms; name one.`);
    }
    chosen = blocks[0];
  }
  if (chosen.error || !chosen.config) {
    throw refuse(
      "FORM_INVALID",
      `This form cannot be used: ${chosen.error} (block at line ${chosen.line}).`,
    );
  }

  const config = chosen.config;
  const responsesPath = normalizePath(config.responses);
  if (responsesPath === null || !responsesPath.endsWith(".md") || responsesPath === path) {
    throw refuse("FORM_INVALID", "This form names a response file that cannot be written.");
  }
  return { config, responsesPath };
}

/**
 * Apply one change to a form's responses, retrying against a concurrent one.
 *
 * `mutate` runs again on every attempt rather than once, because the questions
 * it answers — is this response still there, have you already voted — are about
 * the state being written over. Re-applying a decision made against a stale
 * read is how a vote gets counted twice.
 */
export async function runFormAction(
  store: FileStore,
  options: { clearance: Clearance; path: string; formId?: string; actor: FormActor; action: FormAction },
): Promise<FormResult> {
  const { config, responsesPath } = await resolveForm(
    store,
    options.clearance,
    options.path,
    options.formId,
  );

  if (store.capabilities && store.capabilities.conditionalWrite === false) {
    throw refuse(
      "FORM_STORAGE_UNSUITABLE",
      "This context's storage cannot do conditional writes, so two responses arriving together " +
        "would overwrite each other. Forms need a store that supports them.",
    );
  }

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // Read WITHOUT canSee — see the module comment. This is a write-only path
    // into the response file, and nothing below returns its contents.
    const object = await store.get(responsesPath);
    if (object === null) {
      throw refuse(
        "FORM_NOT_COLLECTING",
        "This form has no response file yet. An editor can create it by saving the form's note again.",
      );
    }
    const stored = await object.text();
    if (isEncryptedNote(stored)) {
      throw refuse("FORM_INVALID", "That response file is encrypted; the control plane holds no key.");
    }
    const parsed = parseResponsesFile(stored, config) as {
      responses?: StoredResponse[];
      error?: string;
    };
    if (parsed.error || !parsed.responses) {
      throw refuse("FORM_INVALID", parsed.error ?? "That response file cannot be read.");
    }

    const applied = applyAction(config, parsed.responses, options.actor, options.action);
    const rendered = renderResponsesFile(config, applied.responses) as string;
    const put = await store.put(responsesPath, rendered, {
      onlyIf: { etagMatches: object.etag },
    });
    // A refused conditional write means somebody else's response landed between
    // our read and our write. Nothing of theirs is lost: the next pass reads it
    // and re-applies ours on top.
    if (put === null) continue;

    return {
      responseId: applied.responseId,
      formId: config.id,
      responsesPath,
      ...(config.votes === "named" ? { votes: applied.votes } : {}),
      ...(notifyMaterialFor(config, options, responsesPath) ?? {}),
    };
  }

  throw refuse(
    "CONFLICT",
    "Other responses kept landing while this one was being written. Try again.",
  );
}

/**
 * The one answer a notification is about, read as the person being told.
 *
 * This is the whole of the notification feature's privacy story, and it is one
 * call rather than two on purpose. The obvious shape — check a boolean, then
 * render content carried separately — is two facts about one file that can
 * disagree, and the place they would disagree is the place where being wrong
 * means the content has already been sent. Here the read that produces the
 * answers is the read that `canSee` authorised, so there is no arrangement of
 * them that mails something the manifest refuses.
 *
 * It is asked **at delivery**, against the manifest as it stands then, for the
 * reason `functions/shares.ts` re-derives a share's visibility on every read:
 * an answer computed when the form was written goes stale the moment its owner
 * changes their mind in `privacy.md`, and mail is the copy that cannot be
 * recalled.
 *
 * Three asymmetries worth stating, because each looks like an oversight:
 *
 *  - **The form's own note is read without `canSee`**, exactly as
 *    `runFormAction` reads the response file without it. The path did not come
 *    from a caller; it came from the submission that just happened. What is
 *    taken from that note is the block, which is the only thing that knows how
 *    to parse the answers — never its prose.
 *  - **The response file is read with `canSee`**, because that is the file
 *    whose contents are about to be mailed.
 *  - **A response that is gone is not an error.** Between a submission and its
 *    notification somebody may have retracted it, and there is nothing to
 *    announce; `null` and "you may not see this" are the same outcome to the
 *    caller, which is the refusal shape every read in this package uses.
 */
export async function readResponseForNotification(
  store: FileStore,
  clearance: Clearance,
  target: {
    notePath: string;
    formId: string;
    responsesPath: string;
    responseId: string;
    /** Who the caller believes this form tells. Checked against the block. */
    to: string;
  },
): Promise<{ by: string; at: string; answers: FormAnswer[] } | null> {
  const responsesPath = normalizePath(target.responsesPath);
  const notePath = normalizePath(target.notePath);
  if (responsesPath === null || notePath === null) return null;
  /*
    NO SEPARATE `privacy.md` REFUSAL HERE, AND THAT IS A FINDING RATHER THAN AN
    OMISSION.

    One was written. `canSee` answers `true` for the manifest at `private`
    scope — correctly; an owner may read their own access map — and this is the
    one read in this package whose result is *emailed*, so a form whose
    `responses:` pointed there looked like a way to mail somebody their own
    access map.

    Sabotaging the refusal failed nothing, twice over: nothing can write a
    response into `privacy.md` (the marker check refuses a file this package
    did not write), and nothing can read one back out of it (the same check, in
    `parseResponsesFile`, which is what this function's `parsed.error` branch
    catches). A guard nobody has checked is not a guard, and a guard that
    cannot be reached is not one either — so the property is stated here
    instead of being enforced twice, where it is enforced once and tested.
  */
  if (!responsesPath.endsWith(".md") || isPlumbing(responsesPath)) return null;

  const state = await loadPrivacyState(store);
  if (!canSee(responsesPath, clearance.scope, state.rules, state.overrides, clearance.names)) {
    return null;
  }

  const note = await store.get(notePath);
  if (note === null) return null;
  const noteText = await note.text();
  if (isEncryptedNote(noteText)) return null;
  const blocks = parseFormBlocks(noteText) as Array<{ config?: FormConfig }>;
  const config = blocks.find((block) => block.config?.id === target.formId)?.config;
  if (config === undefined) return null;
  /*
    THE RECIPIENT IS READ OUT OF THE BLOCK, NEVER TAKEN FROM THE CALLER.

    `to` arrived as an argument — through a scheduled job, and through
    `/gateway/forms/notify`, which a leaked gateway secret can reach. Without
    this line that argument decides who a real answer is mailed to, and the
    only thing standing between it and an arbitrary member of the context is
    that the member has to be able to read the file. That is a smaller hole
    than a relay and it is the same *shape*: a destination supplied by a
    caller rather than derived from the thing being sent.

    So the block is the authority on who it tells, exactly as the session is
    the authority on `by`. An argument that disagrees with the file is refused
    rather than reconciled.
  */
  if (config.notify !== target.to) return null;

  const stored = await store.get(responsesPath);
  if (stored === null) return null;
  const storedText = await stored.text();
  if (isEncryptedNote(storedText)) return null;
  const parsed = parseResponsesFile(storedText, config) as {
    responses?: StoredResponse[];
    error?: string;
  };
  if (parsed.error || !parsed.responses) return null;

  const response = parsed.responses.find((row) => row.id === target.responseId);
  if (response === undefined) return null;
  return {
    by: response.by,
    at: response.at,
    // Declaration order, which is the order the person who built the form
    // chose to ask in and the order the responses file renders.
    answers: config.fields.map((field) => ({
      field: field.name,
      value: response.values[field.name] ?? "",
    })),
  };
}

/**
 * The notification material for a call that was a submission, or nothing.
 *
 * **Only `submit`.** An edit, a retraction and a vote are all changes to an
 * answer that has already been announced, and mailing one is either noise or —
 * for a vote, which a whole workspace can cast — a way for one member to fill
 * another's inbox by clicking. "Anytime there is a submission" is what was
 * asked for and it is what this is; widening it later is a decision, so the
 * switch is a `kind` check rather than a truthiness test that would quietly
 * admit the other three if the shape of `FormAction` changed.
 *
 * Read off the response that was **stored**, not off the arguments: `values`
 * here are what `validateSubmission` normalised and what the file now holds, so
 * the mail and the note cannot describe different answers. Field order follows
 * the form's declaration rather than the submission's, because that is the
 * order the person who built the form chose to ask in and the order the
 * responses file renders.
 */
function notifyMaterialFor(
  config: FormConfig,
  options: { path: string; action: FormAction },
  responsesPath: string,
): { notify: FormNotifyMaterial } | null {
  if (options.action.kind !== "submit") return null;
  if (config.notify === undefined) return null;
  return {
    notify: {
      to: config.notify,
      formId: config.id,
      notePath: options.path,
      responsesPath,
    },
  };
}

interface Applied {
  responses: StoredResponse[];
  responseId: string;
  votes: number;
}

function applyAction(
  config: FormConfig,
  responses: StoredResponse[],
  actor: FormActor,
  action: FormAction,
): Applied {
  switch (action.kind) {
    case "submit": {
      if (!roleAtLeast(actor.role, config.submit)) {
        throw refuse(
          "FORM_FORBIDDEN",
          `This form takes responses from ${config.submit}s of this context and above.`,
        );
      }
      const checked = validateSubmission(config, valuesFromAnswers(action.values)) as {
        values?: Record<string, string>;
        error?: string;
      };
      if (checked.error || !checked.values) {
        throw refuse("FORM_INVALID", checked.error ?? "Those answers are not valid.");
      }
      const taken = new Set(responses.map((response) => response.id));
      let id = newResponseId() as string;
      while (taken.has(id)) id = newResponseId() as string;
      const response: StoredResponse = {
        id,
        // Stamped, never claimed. There is no argument on any caller that
        // reaches this field.
        by: actor.name,
        at: responseStamp() as string,
        values: checked.values,
        votes: [],
      };
      return { responses: [...responses, response], responseId: id, votes: 0 };
    }

    case "update": {
      const index = indexOfResponse(responses, action.responseId);
      const existing = responses[index];
      assertMayChange(existing, config, actor, "edit");
      const checked = validateSubmission(config, valuesFromAnswers(action.values)) as {
        values?: Record<string, string>;
        error?: string;
      };
      if (checked.error || !checked.values) {
        throw refuse("FORM_INVALID", checked.error ?? "Those answers are not valid.");
      }
      const next = responses.slice();
      // `by`, `at` and the votes other people cast are not the submitter's to
      // rewrite: an edit changes the answers and nothing else.
      next[index] = { ...existing, values: checked.values };
      return { responses: next, responseId: existing.id, votes: existing.votes.length };
    }

    case "retract": {
      const index = indexOfResponse(responses, action.responseId);
      const existing = responses[index];
      assertMayChange(existing, config, actor, "delete");
      return {
        responses: responses.filter((response) => response.id !== existing.id),
        responseId: existing.id,
        votes: 0,
      };
    }

    case "vote": {
      if (config.votes !== "named") {
        throw refuse("FORM_FORBIDDEN", "This form does not collect votes.");
      }
      if (!roleAtLeast(actor.role, config.submit)) {
        throw refuse(
          "FORM_FORBIDDEN",
          `This form takes votes from ${config.submit}s of this context and above.`,
        );
      }
      const index = indexOfResponse(responses, action.responseId);
      const existing = responses[index];
      const others = existing.votes.filter((voter) => voter !== actor.name);
      // Idempotent in both directions: voting twice is one vote, and taking
      // back a vote never cast is the state you asked for, not an error.
      const votes = action.vote === "up" ? [...others, actor.name] : others;
      const next = responses.slice();
      next[index] = { ...existing, votes };
      return { responses: next, responseId: existing.id, votes: votes.length };
    }
  }
}

function indexOfResponse(responses: StoredResponse[], responseId: string): number {
  const index = responses.findIndex((response) => response.id === responseId);
  if (index === -1) throw refuse("FORM_NOT_FOUND", "No such response on this form.");
  return index;
}

/**
 * The ownership test the editing actions share.
 *
 * An editor of the context may act on anybody's response — they can already
 * rewrite the whole file through `writeNote`, so refusing here would be a lock
 * on a door standing open. A submitter may act on their own, and only where the
 * form's author allowed it.
 */
function assertMayChange(
  response: StoredResponse,
  config: FormConfig,
  actor: FormActor,
  verb: "edit" | "delete",
): void {
  if (roleAtLeast(actor.role, "editor")) return;
  /*
    A LINK'S STAMP AUTHORISES NOTHING, INCLUDING FOR THE LINK.

    An answer sent through a collect link is stamped with the link, and that
    stamp is **shared** by every stranger who used it. `assertMayChange`
    authorises by comparing `response.by` to `actor.name`, so without this a
    stranger would match every other stranger's answer through the same link —
    #748's finding with a different constant in the middle. That one closed a
    `by: null` collision where two people with no handle matched each other.

    **This was two checks and is one.** The other read `actor.viaLink === true`
    — a flag threaded from `collect.ts` — and sabotaging it failed nothing: a
    link actor's *name* is always a link stamp, so this line already catches
    it, and a link acting on a person's row is caught by the equality below. A
    guard nobody can reach is not a guard, so the flag and its plumbing went.

    What that leaves load-bearing is the **shape of the stamp**: `linkStamp`
    must never produce something a username could be. `names.ts` claims
    `[a-z0-9][a-z0-9-]{0,62}`, the stamp holds a space, and `collectMode.test.ts`
    pins it rather than trusting this sentence.

    An editor is unaffected — they may already rewrite the whole file with
    `writeNote` — and that is the only way an answer sent through a link is
    ever changed or removed.
  */
  if (isLinkStamp(response.by)) {
    throw refuse(
      "FORM_FORBIDDEN",
      "An answer sent through a link cannot be changed or withdrawn by whoever sent it. An editor of this context can.",
    );
  }
  if (response.by !== actor.name) {
    throw refuse("FORM_FORBIDDEN", `That response is ${response.by}'s, not yours.`);
  }
  if (!config.edit_own) {
    throw refuse("FORM_FORBIDDEN", `This form does not let people ${verb} their own response.`);
  }
}


/* -------------------------------------------------------------------------- */
/*                      seeding a form's response file                        */
/* -------------------------------------------------------------------------- */

/** What `ensureFormResponseFiles` did, for the author who just saved. */
export interface FormSeedResult {
  /** Response files this write created. */
  created: string[];
  /** Forms whose `responses:` points somewhere unusable, and why. */
  occupied: string[];
}

/**
 * Create the empty response file for every valid form on a note just written.
 *
 * **On the author's write, never on the first submission**, which is the rule
 * `docs/decisions/forms.md` states and the reason is a permission: the author
 * holds write access and the submitter may not. A member whose first bug report
 * had to create a note would be refused; a member whose first bug report *could*
 * create one would be a way for a member to create notes.
 *
 * The gateway does this in `toolWriteNote` and the console has to as well, or a
 * form authored in the console collects nothing: the block parses, the widget
 * draws, and every submission is refused with `FORM_NOT_COLLECTING` because the
 * file the marker check looks for was never written. Two write paths, one rule.
 *
 * **It only ever creates.** A path that already holds something is left exactly
 * as it is — including somebody's ordinary note, which is reported back so the
 * author can see their `responses:` is aimed at the wrong place. That is the
 * second of two independent guards; the first is the marker check in
 * `runFormAction`, which stops a submission writing into a file this code did
 * not write.
 *
 * Failures here never fail the note's own write. The note is the customer's
 * content and is already in the bucket; a response file that could not be
 * seeded is a form that is not collecting yet, which the author is told about
 * and can fix by saving again.
 */
export async function ensureFormResponseFiles(
  store: FileStore,
  options: { text: string; notePath: string },
): Promise<FormSeedResult> {
  const created: string[] = [];
  const occupied: string[] = [];
  const blocks = parseFormBlocks(options.text) as Array<{ config?: FormConfig }>;

  for (const block of blocks) {
    const config = block.config;
    if (config === undefined) continue;
    const responsesPath = normalizePath(config.responses);
    if (
      responsesPath === null ||
      !responsesPath.endsWith(".md") ||
      isPlumbing(responsesPath) ||
      responsesPath === options.notePath
    ) {
      occupied.push(`${config.id} → ${config.responses} (not a writable note path)`);
      continue;
    }

    const existing = await store.get(responsesPath);
    if (existing !== null) {
      const stored = await existing.text();
      // An encrypted file is not a response file and must not be reported as
      // one — the control plane holds no key to tell what is inside it.
      if (isEncryptedNote(stored)) {
        occupied.push(`${config.id} → ${responsesPath} (encrypted)`);
        continue;
      }
      const parsed = parseResponsesFile(stored, config) as { error?: string };
      if (parsed.error !== undefined) {
        occupied.push(`${config.id} → ${responsesPath} (${parsed.error})`);
      }
      continue;
    }

    /*
      Conditional on *absence* where the store has proven it honours one, which
      is the rule `importVaultFiles` states at length and this follows rather
      than restates: sending the precondition to a backend that ignores it is
      how a write that should have been skipped comes back reported as created,
      with somebody's file gone under it. The `get` above is the check where the
      capability is unproven, and its one-round-trip race is the same window
      that function documents.

      The gap matters here for its own reason: two editors saving one form at
      once, or a submission landing in between, would otherwise have the later
      empty file erase the earlier responses.
    */
    const put =
      store.capabilities?.conditionalWrite === true
        ? await store.put(responsesPath, emptyResponsesFile(config) as string, {
            onlyIf: { absent: true },
          })
        : await store.put(responsesPath, emptyResponsesFile(config) as string);
    if (put === null) continue;
    created.push(responsesPath);
  }

  return { created, occupied };
}

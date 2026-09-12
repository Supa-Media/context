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
  /** Their username, with the `@`. Stamped on the row; never taken from input. */
  name: string;
  role: WorkspaceRole;
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
  scope: Scope,
  pathInput: string,
  formId: string | undefined,
): Promise<{ config: FormConfig; responsesPath: string }> {
  const path = normalizePath(pathInput);
  if (path === null || !path.endsWith(".md")) {
    throw refuse("PATH_INVALID", "That path is not valid.");
  }
  const state = await loadPrivacyState(store);
  if (!canSee(path, scope, state.rules, state.overrides)) {
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
  options: { scope: Scope; path: string; formId?: string; actor: FormActor; action: FormAction },
): Promise<FormResult> {
  const { config, responsesPath } = await resolveForm(
    store,
    options.scope,
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
    };
  }

  throw refuse(
    "CONFLICT",
    "Other responses kept landing while this one was being written. Try again.",
  );
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

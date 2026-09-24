/**
 * A form's responses file: where one may be collected, resolving a form for a
 * caller, and the conditional read-modify-write every response change goes
 * through.
 */

import {
  canSee,
  effectiveVisibility,
  isPlumbing,
  visibilityOf,
} from "../../privacy/engine.js";
import {
  emptyResponsesFile,
  parseFormBlocks,
  parseResponsesFile,
  renderResponsesFile,
} from "../../forms.js";
import { encryptedNoteRefusal, openStoredNote, sealNoteContent } from "../../notes/sealing.js";
import {
  FORM_WRITE_ATTEMPTS,
  formActor,
  readFormResponses,
  RESPONSE_FILE_UNUSABLE,
} from "../formSupport.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { isEncryptedNote } from "../../encryption.js";
import { normalizePath } from "../../notes/paths.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { projectWrittenNoteAfterResponse } from "../../search/writeProjection.js";
import { recordChange } from "../../activity/record.js";
import { replaceText as replaceCollaborationText } from "@context/collaboration";
import { toolError, toolText } from "../results.js";
import { writesOneRule } from "../../privacy/state.js";

/**
 * May this connection's own write reach the file a form collects into?
 *
 * `responses:` is a path the *caller* chose, in a note the caller is writing,
 * so it is a second route to a file `write_note` answers for directly — and it
 * has to answer the same way. A team connection is refused a create in private
 * space there (`scope === "team" && !existing && inheritedVisibility !==
 * "team"`) and is told nothing about what is already at the path: one refusal,
 * whether the note exists or not.
 *
 * Without this, the author's own write was the oracle `write_note` refuses to
 * be. Aimed at a private note that exists it answered "form not collecting
 * yet: … (that file is not a form response file)"; aimed at a private response
 * file it named the form that file belongs to; aimed at a private path holding
 * nothing it answered "response file created" — and created a note in private
 * space, through a connection that may not write one.
 *
 * `effectiveVisibility` rather than `canSee`, and `!== "team"` rather than
 * `=== "private"`, for the reason the same test is spelled that way in
 * `toolWriteNote`: a note held back to a group is not `"private"`, and a
 * destination a team connection may not write must fail this whatever tier it
 * is held at.
 */
export function mayCollectResponsesAt(scope, path, rules, overrides) {
  if (scope !== "team") return true;
  return effectiveVisibility(path, rules, overrides) === "team";
}

/**
 * Find the form a call names, or the reason it cannot be used.
 *
 * The note has to be one this connection can already see, which is where the
 * refusal for "no such note" and "a note you may not read" become the same
 * three bytes — the rule every read in this file follows.
 */
async function resolveForm(store, scope, rules, overrides, args) {
  const path = normalizePath(args.path);
  if (!path || !path.endsWith(".md")) return { refusal: toolError("invalid path (must end in .md)") };
  /*
    Both questions asked, then decided — `toolReadNote` argues it in full. This
    is the read half of every form mutation, so the gate the read tools were
    equalised for lives here too.

    On a metadata probe, and the distinction matters here as much as anywhere:
    resolving an invisible path with the real `get` below would buffer that
    note's whole body on `S3Store` and `DropboxStore` before anything asked
    whether this caller may read it. The body is fetched only once both
    questions have passed.
  */
  const seen = canSee(path, scope, rules, overrides);
  const present = await probeWithLegacyFallback(store, path);
  if (!seen || !present) return { refusal: toolError("not found") };
  const object = await getWithLegacyFallback(store, path);
  if (!object) return { refusal: toolError("not found") };
  const opened = await openStoredNote(store, await object.text());
  if (!opened.ok) return { refusal: encryptedNoteRefusal(path) };

  const blocks = parseFormBlocks(opened.text);
  if (!blocks.length) return { refusal: toolError("that note carries no form") };

  const wanted = typeof args.form_id === "string" && args.form_id ? args.form_id : null;
  let chosen;
  if (wanted) {
    chosen = blocks.find((block) => block.config?.id === wanted);
    // A broken block has no id to match on, so a note whose only form is
    // broken answers with the parse error rather than "no such form" — the
    // author needs the first message, not the second.
    if (!chosen && blocks.length === 1 && blocks[0].error) chosen = blocks[0];
    if (!chosen) return { refusal: toolError(`that note carries no form called "${wanted}"`) };
  } else {
    if (blocks.length > 1) {
      return { refusal: toolError(`that note carries ${blocks.length} forms; name one with form_id`) };
    }
    chosen = blocks[0];
  }
  if (chosen.error) {
    return {
      refusal: toolError(
        `this form cannot be used: ${chosen.error} (block at line ${chosen.line}). ` +
          "An editor of this context can fix the block; nothing has been written."
      ),
    };
  }

  const config = chosen.config;
  const responses = normalizePath(config.responses);
  if (!responses || !responses.endsWith(".md") || isPlumbing(responses) || !writesOneRule(responses)) {
    return { refusal: toolError("this form names a response file that cannot be written") };
  }
  if (responses === path) {
    return { refusal: toolError("this form points its responses at the form itself") };
  }
  return { path, config, responsesPath: responses };
}

/**
 * One mutation of a response file, retried against a concurrent one.
 *
 * `mutate` is handed the responses as they are *right now* and returns either a
 * refusal or a new list. It is called again on every retry rather than once,
 * because the checks it makes — "is this response still there", "have you
 * already voted" — are about the state that is being written over, and
 * re-applying a decision made against a stale read is how a vote gets counted
 * twice.
 */
export async function mutateFormResponses(store, scope, rules, overrides, args, action, mutate) {
  const actor = formActor(store);
  if (!actor.name) {
    return toolError(
      "this connection has no username to record a response under; create your workspace first."
    );
  }
  const form = await resolveForm(store, scope, rules, overrides, args);
  if (form.refusal) return form.refusal;
  const { config, responsesPath } = form;

  if (!store?.capabilities?.conditionalWrite) {
    return toolError(
      "this context's storage cannot do conditional writes, so two responses arriving together " +
        "would overwrite each other. Forms need a store that supports them — R2 and S3 do."
    );
  }

  /*
   * A response file the caller cannot read answers with one message.
   *
   * Submitting to a file you may not read is the drop-box the design chose —
   * "a form whose responses are private is final" — so this does not refuse the
   * submission. What it refuses is the *diagnosis*: absent, not a response
   * file, another form's, another layout and encrypted are five distinguishable
   * facts about a note this caller may not open, and a form's `responses:` can
   * be aimed anywhere by whoever wrote the note. The author's write is gated by
   * `mayCollectResponsesAt`; this is the same gap through the submitting door.
   */
  const blind = !canSee(responsesPath, scope, rules, overrides);
  for (let attempt = 0; attempt < FORM_WRITE_ATTEMPTS; attempt++) {
    const current = await readFormResponses(store, config, responsesPath);
    if (current.refusal) return blind ? toolError(RESPONSE_FILE_UNUSABLE) : current.refusal;
    if (current.missing) {
      return toolError(
        blind
          ? RESPONSE_FILE_UNUSABLE
          : "this form has no response file yet. An editor of this context can create it by saving " +
            "the form's note again; nothing has been written."
      );
    }

    const applied = mutate(current.responses, { config, actor });
    if (applied.refusal) return applied.refusal;

    const rendered = renderResponsesFile(config, applied.responses);
    let body = rendered;
    if (isEncryptedNote(current.stored)) {
      const sealed = await sealNoteContent(store, rendered, current.stored);
      if (sealed === null) return encryptedNoteRefusal(responsesPath);
      body = sealed;
    }
    let put;
    if (current.collaboration) {
      try {
        put = await replaceCollaborationText(store, responsesPath, {
          documentId: current.collaboration.documentId,
          expectedEtag: current.etag,
          text: rendered,
        });
      } catch {
        // The collaboration engine owns the CAS and can merge a concurrent
        // editor update. A failed merge is retried from a fresh read below;
        // never fall back to a raw put that would orphan the document state.
        continue;
      }
    } else {
      put = await store.put(responsesPath, body, { onlyIf: { etagMatches: current.etag } });
    }
    // A refused conditional write means somebody else landed a response between
    // our read and our write. Nothing of theirs is lost: the next pass reads
    // their row and re-applies ours on top.
    if (!put) continue;

    await recordChange(store, action, scope, [responsesPath], {
      form_id: config.id,
      response_id: applied.responseId,
      etag: put.etag,
      // The response file's own visibility is `privacy.md`'s answer, not this
      // write's, so it is reported rather than decided here.
      team_visible: effectiveVisibility(responsesPath, rules, overrides) === "team",
    });
    await projectWrittenNoteAfterResponse(store, {
      path: responsesPath,
      content: rendered,
      version: put.etag,
      visibility: effectiveVisibility(responsesPath, rules, overrides),
    });
    /*
      A NEW ANSWER, AND ONLY A NEW ANSWER, TELLS SOMEBODY.

      `action` rather than a flag: an edit, a retraction and a vote all land in
      this same helper, and every one of them is a change to an answer that has
      already been announced. Mailing a vote would also hand any member of a
      context a button that fills another member's inbox.

      Identifiers only — see `controlPlane.notifyFormSubmission`. The values
      this worker just wrote are deliberately not sent; the control plane reads
      them back out of the bucket, as the recipient, when it delivers.
    */
    if (action === "submit_form" && config.notify && typeof store.reportFormSubmission === "function") {
      store.reportFormSubmission({
        to: config.notify,
        formId: config.id,
        notePath: form.path,
        responsesPath,
        responseId: applied.responseId,
      });
    }
    return toolText(applied.message);
  }

  return toolError(
    "conflict: other responses kept landing while this one was being written. Try again."
  );
}

/**
 * Create the response file for every valid form a just-written note declares.
 *
 * Done on the *author's* write rather than on the first submission, because the
 * author holds write access and the submitter may not: a `member` whose first
 * bug report had to create a note would be refused, and a member whose first
 * bug report *could* create one would be a way to create notes.
 *
 * Only ever creates. A path that already holds something is left exactly as it
 * is — including a file that is not a response file, which is reported back so
 * the author can see their `responses:` is aimed at somebody's note.
 */
export async function ensureFormResponseFiles(store, scope, rules, overrides, blocks, notePath) {
  const created = [];
  const occupied = [];
  for (const block of blocks) {
    if (!block.config) continue;
    const responsesPath = normalizePath(block.config.responses);
    if (
      !responsesPath ||
      !responsesPath.endsWith(".md") ||
      isPlumbing(responsesPath) ||
      !writesOneRule(responsesPath) ||
      responsesPath === notePath
    ) {
      occupied.push(`${block.config.id} → ${block.config.responses} (not a writable note path)`);
      continue;
    }
    // Before the `get`, because the `get` is the oracle: reaching the file at
    // all is what this connection may not do.
    if (!mayCollectResponsesAt(scope, responsesPath, rules, overrides)) {
      occupied.push(
        `${block.config.id} → ${responsesPath} (this connection cannot collect responses there; ` +
          "use a personal connection)"
      );
      continue;
    }
    const existing = await getWithLegacyFallback(store, responsesPath);
    if (existing) {
      const opened = await openStoredNote(store, await existing.text());
      const parsed = opened.ok ? parseResponsesFile(opened.text, block.config) : { error: "encrypted" };
      if (parsed.error) occupied.push(`${block.config.id} → ${responsesPath} (${parsed.error})`);
      continue;
    }
    // Conditional on absence where the store can do it. The gap between the
    // `get` above and this `put` is small and is still a gap: two editors
    // saving the same form at once, or a submission landing in between, would
    // otherwise have the later empty file erase the earlier responses.
    const put = await store.put(
      responsesPath,
      emptyResponsesFile(block.config),
      store?.capabilities?.conditionalCreate ? { onlyIf: { absent: true } } : undefined
    );
    if (!put) continue;
    created.push(responsesPath);
    await recordChange(store, "create_note", scope, [responsesPath], {
      form_id: block.config.id,
      etag: put.etag,
      team_visible: visibilityOf(responsesPath, rules) === "team",
    });
  }
  return { created, occupied };
}

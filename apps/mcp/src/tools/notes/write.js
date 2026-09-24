/**
 * `write_note` — create or replace one note: path and privacy checks,
 * conditional write, encryption, collaboration hand-off, and the change
 * recorded afterwards.
 */

import {
  announceCommittedToPresence,
  announceWriteToPresence,
  isConsoleActor,
  presenceActor,
} from "../../live/presence.js";
import { byteSize, frontmatterVisibility, normalizeVisibility } from "../../notes/format.js";
import { clearExactVisibilityIfAbsent } from "../../moves/objects.js";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  readDocument as readCollaborationDocument,
  replaceText as replaceCollaborationText,
} from "@context/collaboration";
import {
  effectiveVisibility,
  isPlumbing,
  overrideFor,
  visibilityOf,
} from "../../privacy/engine.js";
import { encryptedNoteRefusal, openStoredNote, sealNoteContent } from "../../notes/sealing.js";
import { ensureFormResponseFiles } from "../forms/responses.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { isDrawingPath, parseDrawing } from "../../../../../packages/drawings/src/excalidraw.js";
import { isEncryptedNote } from "../../encryption.js";
import { isPersonalCommunicationsPath, normalizePath } from "../../notes/paths.js";
import { parseFormBlocks } from "../../forms.js";
import { pathUnderActiveMovedSource } from "../../moves/jobs.js";
import { persistExactVisibility, UNWRITABLE_PATH_REFUSAL, writesOneRule } from "../../privacy/state.js";
import { projectWrittenNoteAfterResponse } from "../../search/writeProjection.js";
import { recordChange } from "../../activity/record.js";
import { shareWrittenNote } from "../links.js";
import { toolError, toolText, writePermissionError } from "../results.js";

export async function toolWriteNote(store, scope, rules, overrides, args, options = {}) {
  const path = normalizePath(args.path);
  const content = args.content;
  const expectedEtag = args.expected_etag;
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (typeof content !== "string") return toolError("content must be a string");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (isPersonalCommunicationsPath(path) && store.actor?.workspaceKind === "shared") {
    return toolError("personal communications can only be synced to a personal workspace");
  }
  /*
   * A DRAWING IS NEVER OVERWRITTEN WITH TEXT.
   *
   * `read_note` returns a drawing as a *description* — see `toolReadNote` —
   * which creates a failure mode that did not exist before it: a client that
   * reads a note, edits a line and writes the whole thing back would replace
   * somebody's diagram with a paragraph about the diagram, and the only copy of
   * those elements is the file it just destroyed. That is exactly the
   * data-loss shape `docs/decisions/plugins.md` refuses ("a file we do
   * not parse is still a file we do not corrupt"), arriving through the gateway
   * instead of through a tidy-up.
   *
   * So a write to a `.excalidraw.md` path must itself be a drawing. The test is
   * "does this parse as one", not "is the caller trusted" or "did the caller
   * pass a flag": a real drawing written by a real editor passes it, and text
   * that only describes one cannot. Creating a new drawing through the gateway
   * is still allowed — it just has to carry a payload.
   *
   * Before the etag check on purpose. A caller who is about to destroy a
   * drawing should be told that, not told their etag is stale.
   */
  if (isDrawingPath(path)) {
    const incoming = parseDrawing(content, path);
    if (incoming.unreadable === "missing") {
      return toolError(
        "that path holds an Excalidraw drawing, and this content carries no drawing payload. " +
          "read_note returns a drawing as a description, not as its source — writing that back " +
          "would replace the drawing with text. Edit it in Excalidraw or Obsidian instead."
      );
    }
  }
  /*
   * A FORM BLOCK THAT DOES NOT PARSE IS REFUSED AT THE WRITE, NOT AT THE READ.
   *
   * The read-time parse still fails closed — that is what protects a note
   * hand-edited in Obsidian, which never comes through here. This is the other
   * half, and it is the cheap half: an author working through the gateway is
   * told which line is wrong while they still have the text in front of them,
   * instead of discovering it when somebody's submission is refused.
   *
   * Before the write, and before anything is looked up: a note is never stored
   * carrying a form nobody can use.
   */
  const formBlocks = parseFormBlocks(content);
  const brokenForm = formBlocks.find((block) => block.error);
  if (brokenForm) {
    return toolError(
      `the form block at line ${brokenForm.line} is not valid: ${brokenForm.error}. ` +
        "Fix it or remove it — a note is not saved with a form that cannot be used."
    );
  }
  if (await pathUnderActiveMovedSource(store, path)) {
    return toolError("conflict: that folder is being moved; write to the destination path instead");
  }
  // Any override that is not `team` is a destination a team connection may not
  // write, and `!== "team"` rather than `=== "private"` is the whole of it.
  // With only two tiers those were the same test; with a group rule they are
  // not, and the gap was a privilege escalation: a note the owner had scoped
  // to a group, sitting in a `team` folder and not yet created, passed this
  // check and the `!existing` check below (which reads the FOLDER default),
  // was written by a team connection, and `persistExactVisibility` then
  // replaced the owner's group rule with `team`. `undefined` is spelled out
  // because "no override at all" must keep falling through to the folder.
  const pathOverride = overrideFor(overrides, path);
  // Refused here rather than left to `persistExactVisibility`'s backstop, which
  // throws — and a throw reaches the client as a protocol error instead of a
  // refusal it can read and act on.
  if (!writesOneRule(path)) return toolError(UNWRITABLE_PATH_REFUSAL);

  const existing = await getWithLegacyFallback(store, path);
  const inheritedVisibility = visibilityOf(path, rules);
  const existingVisibility = existing
    ? effectiveVisibility(path, rules, overrides)
    : null;
  const requestedVisibility = normalizeVisibility(args.visibility);
  if (requestedVisibility && !["private", "team"].includes(requestedVisibility)) {
    return toolError("visibility must be private or team");
  }

  /*
   * ONE REFUSAL ABOUT THIS DESTINATION, AT ONE COST.
   *
   * `writePermissionError` ends with "No private-path information is disclosed
   * by this error". That sentence is the specification, and three things had to
   * change for it to be true.
   *
   * **The caller's own request is answered separately, and only it.** A team
   * connection that ASKED for `private` is told exactly that — they chose the
   * value, so saying it back infers nothing about storage. Every other reason
   * this destination is closed collapses into one message below.
   *
   * That split is the fix. The private-content sentence used to be reached on
   * `desiredVisibility`, which falls back to `existingVisibility` — so it fired
   * for a caller who asked for nothing, purely because a note was **there** and
   * not team-visible, while the identical path with nothing at it got the other
   * message. Two refusals, two different sentences, keyed on existence: the
   * exact inference the error text denies making, with no timing needed to read
   * it.
   *
   * **And the three reasons are now decided together, after the lookup.** An
   * exact override used to refuse from the manifest alone, before the note was
   * ever fetched — a round trip cheaper than the folder cases. An exact
   * override is written only when somebody deliberately named THAT path in
   * `privacy.md`, which a team caller cannot read, so the cheap refusal said
   * "this note was singled out". The lookup now runs for every reason, and the
   * body is the same in each.
   */
  if (scope === "team" && requestedVisibility && requestedVisibility !== "team") {
    return toolError(
      "permission denied: a team connection cannot create or change private content; use a personal connection"
    );
  }
  if (
    scope === "team" &&
    ((pathOverride !== undefined && pathOverride !== "team") ||
      (!existing && inheritedVisibility !== "team") ||
      (existing && existingVisibility !== "team"))
  ) {
    return writePermissionError("write destination");
  }

  const desiredVisibility = requestedVisibility || existingVisibility || scope;
  /*
   * `create_form` NEVER OVERWRITES, AND SAYS SO HERE RATHER THAN LOOKING FIRST.
   *
   * A caller that probed for the note itself would be a second existence
   * oracle beside this one, answering under its own rules. This sits *after*
   * the three team-scope checks above, all of which refuse with the same
   * message whether or not anything is there — so a connection that may not
   * write here still learns nothing, and one that may was always going to be
   * told by the write.
   */
  if (options.mustCreate && existing) {
    return toolError(
      `that note already exists (etag ${existing.etag}). A form block is ordinary Markdown: ` +
        "read the note, add the block to its content, and save it with write_note — or write " +
        "the form to a path of its own."
    );
  }
  // `!== "team"` on the existing side. A note held back to a group is not
  // `"private"`, so the old test called `@supa-leads` → `team` an ordinary
  // write and asked for no confirmation, while `set_visibility` gated the same
  // transition unconditionally — two tools disagreeing about one publication,
  // with the ungated one the default an agent reaches.
  const isPublishing =
    scope === "private" && desiredVisibility === "team" && (!existing || existingVisibility !== "team");
  if (isPublishing && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: publishing this note to team makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  const declared = frontmatterVisibility(content);
  if (declared && declared !== desiredVisibility) {
    return toolError(
      `visibility mismatch: frontmatter says ${declared}, but enforced visibility would be ${desiredVisibility}. ` +
        "Frontmatter is not access control; pass the matching visibility argument."
    );
  }

  /*
   * READ THE STORED BODY ONCE.
   *
   * `StoredObject.text()` consumes a stream on R2 and S3 both, so it may be
   * called at most once per object — and two things now need it: the conflict
   * message, and the question of whether this note is stored encrypted. Reading
   * it twice worked against the in-memory stub and would have failed in
   * production on the second call.
   *
   * It is read only where there is something to read: a create has no stored
   * body and pays nothing for this.
   */
  const storedBody = existing ? await existing.text() : null;
  const collaborationEligibleExisting = Boolean(
    existing && collaborationSupported(store) && collaborationEligible(path, storedBody),
  );
  if (collaborationEligibleExisting && expectedEtag === undefined) {
    return toolError(
      `conflict: a collaboratively edited note already exists at ${path}; re-read it and include expected_etag to update it`,
    );
  }
  let collaborationResult = null;
  if (collaborationEligibleExisting) {
    try {
      const base = await readCollaborationDocument(store, path);
      // The opaque etag is the version the caller actually read. A retained
      // older version can be merged; deriving a fresh base here would silently
      // turn an agent's stale full-body replacement into an overwrite of an
      // unseen human edit.
      if (desiredVisibility === "private") {
        await persistExactVisibility(store, path, "private", rules);
      }
      collaborationResult = await replaceCollaborationText(store, path, {
        documentId: base.documentId,
        expectedEtag,
        text: content,
      });
    } catch (error) {
      // A supported ordinary note has one write authority: the collaboration
      // engine. Do not fall back to the legacy raw put after a merge failure.
      const message = (() => {
        try {
          return error instanceof Error ? String(error.message).toLowerCase() : "";
        } catch {
          return "";
        }
      })();
      if (message.includes("update") || message.includes("invalid")) {
        return toolError("invalid collaborative update");
      }
      return toolError("conflict: note changed while it was being merged; re-read and try again");
    }
  }
  if (existing) {
    if (expectedEtag && !collaborationResult && existing.etag !== expectedEtag) {
      // The conflict body is what the caller must merge into, so it is the
      // *plaintext* where the note is encrypted. Handing back an envelope would
      // be telling a client to merge its change into base64 — and then storing
      // whatever it produced.
      const opened = await openStoredNote(store, storedBody);
      if (!opened.ok) return encryptedNoteRefusal(path);
      return toolError(
        `conflict: note changed since you read it (current etag ${existing.etag}). ` +
          `Re-read, merge your change into the current content below, and write again.\n\n${opened.text}`
      );
    }
  } else if (expectedEtag) {
    return toolError("conflict: note no longer exists; write again without expected_etag to recreate it");
  }

  /*
   * WHETHER THIS WRITE IS ENCRYPTED IS DECIDED BY THE STORED OBJECT.
   *
   * Not by the submitted content, not by frontmatter, not by an argument. If
   * the note at this path is encrypted, this write is encrypted — whatever the
   * client sent, and whether or not it knows the feature exists.
   *
   * That is the one rule that stops a round trip being a downgrade. A client
   * that read plaintext and echoed it back would otherwise silently store the
   * note in the clear; a client that read an envelope it could not open would
   * otherwise store *that* as the note's new text, encrypting nothing and
   * destroying everything. `set_encryption` is the only way to change the
   * answer, and it is owner-only.
   *
   * The same discipline `write_note` already applies to visibility — "
   * frontmatter is not access control" — applied to the second thing
   * frontmatter must not be allowed to decide.
   */
  let body = collaborationResult?.text ?? content;
  if (storedBody !== null && isEncryptedNote(storedBody)) {
    const sealed = await sealNoteContent(store, content, storedBody);
    // No key, so this write cannot preserve the encryption the note already
    // has. Refusing is the only safe direction: the alternative is storing the
    // plaintext, which is the feature silently turning itself off.
    if (sealed === null) return encryptedNoteRefusal(path);
    body = sealed;
  }

  const action = existing ? "update_note" : "create_note";
  // Tighten the ACL before content becomes visible. For team publishing, keep
  // the private ACL in place until the content write has completed.
  if (desiredVisibility === "private" && !collaborationResult) {
    await persistExactVisibility(store, path, "private", rules);
  }
  const put = collaborationResult
    ? { etag: collaborationResult.etag }
    : await store.put(path, body, {
        onlyIf: existing
          ? { etagMatches: existing.etag }
          : { absent: true },
      });
  if (!put) {
    if (!existing && desiredVisibility === "private") {
      // Remove only an ACL whose path is still absent. If another writer won
      // the create race, leaving the narrowing in place is the safe answer;
      // clearing it would publish their note after this write already lost.
      await clearExactVisibilityIfAbsent(store, path);
    }
    return toolError(
      existing
        ? "conflict: note changed while it was being written; re-read and try again"
        : "conflict: note was created while this write was in progress; re-read and try again",
    );
  }
  if (desiredVisibility === "team") {
    await persistExactVisibility(store, path, "team", rules);
  }
  await recordChange(store, action, scope, [path], {
    etag: put.etag,
    visibility: desiredVisibility,
    team_visible: desiredVisibility === "team",
    /*
      What the activity file needs to tell an edit from a keystroke, measured
      on the bytes that were STORED rather than on the text that was sent: for
      an encrypted note the stored form is an envelope, and comparing new
      plaintext against old ciphertext is a comparison of two different things
      that would read as a large change on every save.
    */
    content_bytes: byteSize(body),
    ...(storedBody === null ? {} : { previous_bytes: byteSize(storedBody) }),
    ...(typeof args.summary === "string" && args.summary.trim()
      ? { summary: args.summary }
      : {}),
  });
  await projectWrittenNoteAfterResponse(store, {
    path,
    content: body,
    version: put.etag,
    visibility: desiredVisibility,
  });
  // And anybody who has this note open right now, so an agent's write appears
  // in their editor as it lands rather than as a conflict later.
  if (collaborationResult) {
    await announceCommittedToPresence(
      store,
      path,
      collaborationResult,
      isConsoleActor(store.actor) ? null : await presenceActor(store.actor),
    );
  } else {
    await announceWriteToPresence(store, {
      path,
      content: body,
      etag: put.etag,
      actor: await presenceActor(store.actor),
    });
  }
  // After the note is safely stored, never before: a response file for a note
  // whose own write then failed is a file referring to a form that does not
  // exist.
  const forms = formBlocks.length
    ? await ensureFormResponseFiles(store, scope, rules, overrides, formBlocks, path)
    : { created: [], occupied: [] };
  const formLines = [
    ...forms.created.map((responses) => `response file created: ${responses}`),
    ...forms.occupied.map((detail) => `form not collecting yet: ${detail}`),
  ];
  const shareLines = await shareWrittenNote(store, path, args);
  return toolText(
    `written: ${path} (etag ${put.etag})\nvisibility: ${desiredVisibility}` +
      (formLines.length ? `\n${formLines.join("\n")}` : "") +
      (shareLines.length ? `\n${shareLines.join("\n")}` : "")
  );
}

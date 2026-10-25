/**
 * Renaming a collaborative note whose row has already moved (a keyed
 * workspace, `notes-by-id.md`). The bytes stay at their id key, so only the
 * engine's own records follow the name: the document state's `path`, the new
 * name's head, and the old name's `moved` fence. No Markdown is read or
 * written here.
 *
 * It runs as a structural journal (`kind: "rename"`). Every step checks the fact
 * it needs and does nothing when that fact already holds, so a retry finishes an
 * interrupted rename at any write. Once the new name is claimed (step 2), a read
 * of the new name finishes it too, with no retry needed. Before that claim, only
 * a retry does:
 *
 *  1. Freeze the state with the journal (`structural`).
 *  2. Claim the new name's head as `prepared` (its source is the old name).
 *     From here a reader of the new name drives recovery, and never starts a
 *     new document over the note.
 *  3. Move the state's `path` to the new name.
 *  4. Fence the old name's head as `moved` with its destination.
 *  5. Activate the new name's head.
 *  6. Unfreeze the state and complete the journal.
 *
 * A name held by another active document refuses the rename before anything
 * is claimed for it, and that refusal leaves the old document as it was.
 */

import { lifecyclePath } from "./admission.js";
import {
  MAX_RETRIES,
  SCHEMA_VERSION,
  fail,
  put,
  randomId,
  requireSupported,
} from "./storage.js";
import {
  identityHead,
  putHead,
  readHead,
  readState,
  readStructural,
  updateStructural,
  validateState,
  writeStructural,
} from "./records.js";
import { scrubStructural } from "./purge.js";
import { headKeyAt } from "./address.js";

/** A name a head may be claimed for: nothing there, or a name a document moved away from. */
function claimable(head) {
  return head === null || head.status === "moved";
}

/**
 * Rename the note at `from` to `to`, whose row has already moved. Answers
 * `{renamed: false, reason: "no_document"}` when the old name has no
 * collaboration history, and `{renamed: false, reason: "already"}` when this
 * rename has already happened. Throws `DESTINATION_EXISTS` when another
 * active document holds `to`; nothing is changed for that document then.
 */
export async function renameDocument(store, from, to, options = {}) {
  requireSupported(store);
  // `internalTrash`: one end may be a trash location (`.context/trash/<stamp>/<path>`), as a trash or restore names it.
  const internal = options?.internalTrash === true;
  if (!lifecyclePath(from, internal) || !lifecyclePath(to, internal) || from === to) {
    throw fail("INELIGIBLE_DOCUMENT", "rename paths must be distinct Markdown notes");
  }
  // Both names file to one head: the note's history is filed by its id (`address.js`), so it is already
  // where the note is, and there is nothing to carry. Fencing "the old name" here would fence the note.
  if ((await headKeyAt(store, from)) === (await headKeyAt(store, to))) return { renamed: false, reason: "already" };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const head = await readHead(store, from);
    if (head === null) return { renamed: false, reason: "no_document" };
    if (head.status === "moved") {
      if (head.destination !== to) throw fail("MOVED", "document moved somewhere else", { destination: head.destination });
      // A journal still present is a rename that has not finished; a completed one was scrubbed.
      if (head.operationId) {
        const journal = await readStructural(store, head.operationId).catch((error) => {
          if (error?.code === "CORRUPT_STATE") return null;
          throw error;
        });
        if (journal?.value.kind === "rename") return recoverRename(store, head.operationId);
      }
      const claimed = await readHead(store, to);
      if (claimed?.status === "active" && claimed.documentId === head.documentId) return { renamed: false, reason: "already" };
      throw fail("CONFLICT", "document is in another lifecycle transition");
    }
    // A sealed note is ciphertext, and a deleted one is a retained fence: neither is a live document to carry.
    if (head.status === "sealed" || head.status === "deleted") return { renamed: false, reason: "not_active" };
    if (head.status !== "active") throw fail("CONFLICT", "document is in another lifecycle transition");

    const stateRecord = await readState(store, head);
    if (!stateRecord) throw fail("CORRUPT_STATE", "renamed document state is missing");
    if (stateRecord.value.structural !== null) {
      // A rename this request began earlier, or another structural operation holding the state.
      const pending = stateRecord.value.structural;
      if (pending.kind === "rename" && pending.to === to) return recoverRename(store, pending.operationId);
      throw fail("CONFLICT", "another structural operation is in progress");
    }
    const state = validateState(stateRecord.value, head, from);
    const operation = {
      schemaVersion: SCHEMA_VERSION,
      kind: "rename",
      operationId: randomId("rename"),
      from,
      to,
      documentId: head.documentId,
      generation: head.generation,
      stateKey: head.stateKey,
      ...(head.noteId === undefined ? {} : { noteId: head.noteId }),
      phase: "started",
    };
    await writeStructural(store, operation);
    const frozen = { ...state, structural: { kind: "rename", operationId: operation.operationId, from, to } };
    const written = await put(store, head.stateKey, JSON.stringify(frozen), { etagMatches: stateRecord.etag });
    if (!written) continue;
    return recoverRename(store, operation.operationId);
  }
  throw fail("CONCURRENT_WRITE", "document kept changing while it was renamed");
}

/**
 * Resume, or finish, a journaled rename. Safe to call at any point after the
 * journal exists: each step is a check and, if the check fails, one conditional
 * write. A refused claim of the new name is rolled back, and the old document
 * stays as it was.
 */
export async function recoverRename(store, operationId, attempt = 0) {
  if (attempt >= MAX_RETRIES) throw fail("CONCURRENT_WRITE", "rename recovery exceeded its retry budget");
  const again = () => recoverRename(store, operationId, attempt + 1);
  const opRecord = await readStructural(store, operationId);
  const op = opRecord.value;
  if (op.kind !== "rename") throw fail("STRUCTURAL_CONFLICT", "structural operation is not a rename");
  if (op.phase === "complete") return { renamed: false, reason: "already", documentId: op.documentId, generation: op.generation };
  if (op.phase === "aborted") throw fail("DESTINATION_EXISTS", op.abortedReason || "rename was refused");

  const stateKey = op.stateKey;
  const ids = { documentId: op.documentId, generation: op.generation };
  if ((await headKeyAt(store, op.from)) === (await headKeyAt(store, op.to))) {
    // A rename journaled before the note's history was filed by its id: the head is the note's now, at both
    // names. Only the state's freeze, and the journal, are left to settle.
    return settleFiledRename(store, opRecord);
  }
  const stateRecord = await readState(store, { stateKey, ...ids });
  if (!stateRecord) throw fail("CORRUPT_STATE", "renamed document state is missing");
  let state = stateRecord.value;
  let stateEtag = stateRecord.etag;
  const ownsState = state.structural?.operationId === operationId;
  if (state.structural !== null && !ownsState) throw fail("CONFLICT", "another structural operation is in progress");

  // 1. Freeze the state with this journal, unless it already has been, or the rename's state step is past.
  if (!ownsState && state.path === op.from) {
    const frozen = { ...state, structural: { kind: "rename", operationId, from: op.from, to: op.to } };
    const written = await put(store, stateKey, JSON.stringify(frozen), { etagMatches: stateEtag });
    if (!written) return again();
    state = frozen;
    stateEtag = written.etag;
  }

  // 2. Claim the new name, unless it is already claimed for this document.
  let toHead = await readHead(store, op.to);
  const claimedHere = toHead?.status === "prepared" && toHead.operationId === operationId;
  const activeHere = toHead?.status === "active" && toHead.documentId === op.documentId;
  if (!claimedHere && !activeHere) {
    if (claimable(toHead)) {
      const prepared = {
        schemaVersion: SCHEMA_VERSION,
        path: op.to,
        documentId: op.documentId,
        generation: op.generation,
        stateKey,
        status: "prepared",
        operationId,
        source: op.from,
        ...(op.noteId === undefined ? {} : { noteId: op.noteId }),
      };
      const claimed = await put(store, await headKeyAt(store, op.to), JSON.stringify(prepared), toHead ? { etagMatches: toHead.etag } : { absent: true });
      if (!claimed) return again();
      toHead = { ...prepared, etag: claimed.etag };
    } else if (toHead.status === "prepared") {
      throw fail("CONFLICT", "the new name is claimed by another structural operation");
    } else {
      return abortRename(store, opRecord, "destination path is already owned by another document", state, stateEtag);
    }
  }

  // 3. The state follows the name.
  if (state.path === op.from) {
    const moved = { ...state, path: op.to };
    const written = await put(store, stateKey, JSON.stringify(moved), { etagMatches: stateEtag });
    if (!written) return again();
    state = moved;
    stateEtag = written.etag;
  }

  // 4. The old name is fenced, with its destination.
  const fromHead = await readHead(store, op.from);
  if (!fromHead) throw fail("STRUCTURAL_CONFLICT", "the old name's head disappeared during the rename");
  if (fromHead.status === "active" && fromHead.documentId === op.documentId) {
    const fenced = await putHead(store, op.from, identityHead(fromHead, "moved", { destination: op.to, operationId }), fromHead.etag);
    if (!fenced) return again();
  } else if (!(fromHead.status === "moved" && fromHead.destination === op.to)) {
    throw fail("STRUCTURAL_CONFLICT", "the old name changed during the rename");
  }

  // 5. The new name is active.
  toHead = await readHead(store, op.to);
  if (toHead?.status === "prepared" && toHead.operationId === operationId) {
    const activated = await putHead(store, op.to, identityHead(toHead, "active"), toHead.etag);
    if (!activated) return again();
  } else if (!(toHead?.status === "active" && toHead.documentId === op.documentId)) {
    throw fail("STRUCTURAL_CONFLICT", "the new name changed during the rename");
  }

  // 6. Unfreeze the state, then complete the journal.
  if (state.structural?.operationId === operationId) {
    const unfrozen = { ...state, structural: null };
    const written = await put(store, stateKey, JSON.stringify(unfrozen), { etagMatches: stateEtag });
    if (!written) return again();
  }
  const completed = await updateStructural(store, { ...op, phase: "complete" }, opRecord.etag);
  if (completed.value.phase !== "complete") return again();
  await scrubStructural(store, operationId);
  return { renamed: true, documentId: op.documentId, generation: op.generation };
}

/**
 * Refuse a rename whose new name another document holds. Only the journal and
 * the state's freeze were written, so the old document is returned to its
 * unfrozen state and the journal records why.
 */
async function abortRename(store, opRecord, reason, state, stateEtag) {
  const op = opRecord.value;
  if (state.structural?.operationId === op.operationId) {
    const unfrozen = { ...state, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(unfrozen), { etagMatches: stateEtag });
    if (!written) throw fail("CONCURRENT_WRITE", "document changed while its rename was refused");
  }
  await updateStructural(store, { ...op, phase: "aborted", abortedReason: reason }, opRecord.etag);
  throw fail("DESTINATION_EXISTS", reason);
}

/** A journaled rename whose two names now file to one head: unfreeze the state and complete the journal. */
async function settleFiledRename(store, opRecord) {
  const op = opRecord.value;
  const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
  if (stateRecord && stateRecord.value.structural?.operationId === op.operationId) {
    const unfrozen = { ...stateRecord.value, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(unfrozen), { etagMatches: stateRecord.etag });
    if (!written) throw fail("CONCURRENT_WRITE", "document changed while its rename settled");
  }
  await updateStructural(store, { ...op, phase: "complete" }, opRecord.etag);
  await scrubStructural(store, op.operationId);
  return { renamed: false, reason: "already", documentId: op.documentId, generation: op.generation };
}

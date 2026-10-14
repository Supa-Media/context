/**
 * One batch of a move from one workspace into another, run next to both
 * buckets.
 *
 * The owner chose this on 2026-10-14 ("Two keys"): for one batch the mover
 * holds both workspaces' storage keys, so a folder moved into another
 * workspace goes bucket to bucket through this Worker and never through
 * Convex. Before, every file was read into a Convex action, handed across the
 * argument boundary twice, and written out again.
 *
 * The control plane still decides everything a person could be exposed by
 * (`apps/convex/functions/lib/contextMoveMover.ts`): which files are in the
 * batch, where each lands, what the destination's privacy rules say about it
 * before it lands, and what the trees in both workspaces show afterwards. The
 * batch arrives here as a list of `{source, destination, size}` named by the
 * spent ticket, never by the caller; what this does to each is the
 * cross-workspace move's own discipline, in the same order:
 *
 * 1. read the source, and leave it where it is (named) if it is a note
 *    encrypted to its own workspace, which nobody could open in the other;
 * 2. a collaboratively edited note travels as its current text, and its
 *    source is retired by tombstoning that exact revision;
 * 3. land it at the destination only if nothing is there;
 * 4. retire the source only if it is still what was read; if somebody edited
 *    it in between, the copy just landed is taken back instead, so neither
 *    the edit nor a duplicate survives the race.
 *
 * Nothing is deleted from the source before the destination answered with an
 * etag for it.
 */

import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  supported as collaborationSupported,
  tombstoneDocument as tombstoneCollaborationDocument,
} from "@context/collaboration";
import { isEncryptedNote } from "../encryption.js";
import { managedEncryptionForStore, storeForBinding } from "../store/factory.js";
import { NoteCapReached } from "../store/noteCap.js";
import { deleteCreatedDestination, retireMovedSource } from "./objects.js";
import { settleInPool } from "./pool.js";

/**
 * Failures that stop the move. The control plane shows each in words of its
 * own and never a provider's text, which can name a key.
 */
export const CONTEXT_MOVE_FAILURES = Object.freeze([
  "DESTINATION_EXISTS",
  "NOTE_CAP_REACHED",
  "STORAGE_UNSAFE",
  "CONFLICT",
]);

/**
 * @typedef {{ source: string, destination: string, size: number }} PlannedObject
 * @typedef {{
 *   source: object, destination: object,
 *   sourceEncryption?: object, destinationEncryption?: object,
 *   noteCap?: number | null,
 *   objects: PlannedObject[],
 *   limits: { lanes: number, byteBudget: number, maxObjectBytes: number },
 * }} ContextMovePage
 */

/**
 * @param {ContextMovePage} page
 * @param {{ buildStore?: typeof storeForBinding }} [deps] seam for tests
 * @returns {Promise<{
 *   landed: { source: string, destination: string, bytes: number }[],
 *   skipped: { path: string, reason: "encrypted" | "too_large" }[],
 *   conflicts: string[],
 *   failure: { destination: string, code: string } | null,
 * }>}
 */
export async function runContextMovePage(page, { buildStore = storeForBinding } = {}) {
  const source = buildStore(page.source, undefined, {
    managedEncryption: managedEncryptionForStore(page.sourceEncryption ?? {}, page.source),
  });
  const destination = buildStore(page.destination, undefined, {
    noteCap: page.noteCap ?? null,
    managedEncryption: managedEncryptionForStore(page.destinationEncryption ?? {}, page.destination),
  });
  // Asked before anything is read, as the control plane's halves ask them.
  if (source.capabilities?.conditionalDelete !== true && source.capabilities?.conditionalWrite !== true) {
    return refusedWhole(page, "STORAGE_UNSAFE");
  }
  if (destination.capabilities?.conditionalCreate !== true) {
    return refusedWhole(page, "STORAGE_UNSAFE");
  }

  const landed = [];
  const skipped = [];
  const conflicts = [];
  /** @type {{ destination: string, code: string } | null} */
  let failure = null;
  const stop = (object, code) => {
    failure ??= { destination: object.destination, code };
  };

  await settleInPool(
    page.objects,
    { lanes: page.limits.lanes, byteBudget: page.limits.byteBudget, sizeOf: (object) => object.size },
    async (object) => {
      // Once one object stops the move, nothing new starts; those already
      // running finish, so each is either moved or untouched.
      if (failure !== null) return;
      try {
        const outcome = await moveOne(source, destination, object, page.limits.maxObjectBytes);
        if (outcome.kind === "landed") landed.push({ source: object.source, destination: object.destination, bytes: outcome.bytes });
        else if (outcome.kind === "skipped") skipped.push({ path: object.source, reason: outcome.reason });
        else if (outcome.kind === "conflict") conflicts.push(object.source);
        else if (outcome.kind === "failed") stop(object, outcome.code);
      } catch (error) {
        stop(object, error instanceof NoteCapReached ? "NOTE_CAP_REACHED" : "STORAGE_UNSAFE");
      }
    },
  );
  return { landed, skipped, conflicts, failure };
}

function refusedWhole(page, code) {
  const first = page.objects[0];
  return {
    landed: [],
    skipped: [],
    conflicts: [],
    failure: { destination: first?.destination ?? "", code },
  };
}

/**
 * @returns {Promise<
 *   | { kind: "landed", bytes: number }
 *   | { kind: "skipped", reason: "encrypted" | "too_large" }
 *   | { kind: "conflict" }
 *   | { kind: "failed", code: string }
 *   | { kind: "gone" }
 * >}
 */
async function moveOne(source, destination, object, maxObjectBytes) {
  if (object.size > maxObjectBytes) return { kind: "skipped", reason: "too_large" };
  const read = await source.get(object.source);
  if (read === null) return { kind: "gone" }; // deleted underneath us; nothing to carry
  let bytes = new Uint8Array(await read.arrayBuffer());
  if (bytes.byteLength > maxObjectBytes) return { kind: "skipped", reason: "too_large" };

  let collaborationEtag;
  if (object.source.endsWith(".md")) {
    const text = new TextDecoder().decode(bytes);
    // Encrypted to the source workspace's key, which does not travel: carried,
    // it would be a note nobody there could ever open.
    if (isEncryptedNote(text)) return { kind: "skipped", reason: "encrypted" };
    if (collaborationSupported(source) && collaborationEligible(object.source, text)) {
      if (source.capabilities?.conditionalDelete !== true) return { kind: "failed", code: "STORAGE_UNSAFE" };
      try {
        const base = await readCollaborationDocument(source, object.source);
        bytes = new TextEncoder().encode(base.text);
        collaborationEtag = base.etag;
      } catch {
        return { kind: "failed", code: "CONFLICT" };
      }
    }
  }

  const created = await destination.put(object.destination, bytes, { onlyIf: { absent: true } });
  if (!created) return { kind: "failed", code: "DESTINATION_EXISTS" };

  let retired;
  try {
    if (collaborationEtag !== undefined) {
      await tombstoneCollaborationDocument(source, object.source, { expectedEtag: collaborationEtag });
      retired = "retired";
    } else {
      retired = await retireMovedSource(source, object.source, read.etag);
    }
  } catch {
    retired = "conflict";
  }
  if (retired !== "retired") {
    // The copy is the older text: it goes, and the edit stays where it was made.
    await deleteCreatedDestination(destination, object.destination, created.etag);
    return { kind: "conflict" };
  }
  return { kind: "landed", bytes: bytes.byteLength };
}

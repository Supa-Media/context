/** Rewriting the links that point at a moved note. */

import { canSee, effectiveVisibility, narrowerVisibility } from "../../privacy/engine.js";
import { recordChange } from "../../activity/record.js";
import { generatedCollaborationBase } from "../../notes/sealing.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { indexByName, rewriteLinks } from "../../links.js";
import { isEncryptedNote } from "../../encryption.js";
import { LINK_SCAN_CAP } from "../../moves/objects.js";
import { listAllNoteKeys } from "../../notes/visibleKeys.js";
import { mapInBatches } from "../../notes/storage.js";
import { forwardPath, readForwarding } from "../../forwarding.js";
import { MOVE_JOB_VERSION } from "../../moves/limits.js";
import { loadMoveJobs, persistMoveJob, writeMoveSentinel } from "../../moves/jobs.js";
import { replaceText as replaceCollaborationText } from "@context/collaboration";

/**
 * Point every link at where its note went.
 *
 * Called after a move has landed, so the bucket already holds the new paths and
 * `renames` is how to get back to the old ones. Three things about it are
 * decisions rather than mechanics.
 *
 * **It rewrites only what this connection can see.** That is `move_folder`'s
 * existing rule, arrived at for the same reason and quoted here because it is
 * easy to talk yourself out of: the gateway holds a credential that can read
 * every object, so it *could* repair a private note's links on behalf of a team
 * caller. It does not. Every other tool here operates on the visible surface,
 * counts reported back are counts over that surface, and a count over notes the
 * caller may not know exist is an inference channel. The residual is real and
 * worth stating: after a team caller moves a note, links to it inside private
 * notes are stale until an owner's connection moves something. An owner sees
 * everything, so an owner's move fixes everything.
 *
 * **The moved notes are rewritten too, not just the notes pointing at them.** A
 * note that moved keeps every relative link it had, and each one now needs a
 * different number of `../`. Fixing the inbound links and not the outbound ones
 * would trade one set of broken links for another.
 *
 * **Names are resolved as they were before the move.** `byName` is built over
 * pre-move paths, because a bare `[[overview]]` was written against the bucket
 * as it was; resolving it against the new shape would miss exactly the note
 * that just moved.
 */
/** An audit row naming thousands of paths is a row nobody reads; it says so instead. */
const RECORDED_PATH_CAP = 200;
/**
 * An object-store round trip per visible note cannot be serial here. A real
 * 596-note workspace took long enough to cross the connector transport's HTTP
 * timeout even though the move and archive both finished. Eight keeps the
 * in-flight work under the gateway's subrequest headroom while collapsing the
 * sweep to bounded waves, the same shape search uses for remote reads.
 */
const REFERENCE_READ_CONCURRENCY = 8;

export async function rewriteReferences(store, scope, rules, overrides, renames, {
  write = true,
  after,
  limit,
  paths,
  currentJobId,
} = {}) {
  if (renames.size === 0) return { notes: 0, links: 0, capped: false };

  let keys;
  try {
    keys = (await listAllNoteKeys(store))
      .map(({ key }) => key)
      .filter((key) => canSee(key, scope, rules, overrides));
  } catch {
    // `listAllKeys` throws rather than truncate. A walk that could not be
    // completed is reported as a rewrite that did not happen, never as one that
    // did — the move itself has already succeeded and must not be undone for
    // this.
    return { notes: 0, links: 0, capped: true };
  }
  keys.sort();
  const allVisibleKeys = keys;
  const activeJobs = await loadMoveJobs(store);
  const unavailable = new Set();
  for (const job of activeJobs) {
    for (const item of job.objects) {
      unavailable.add(item.source);
      if (job.id !== currentJobId) unavailable.add(item.destination);
    }
  }
  keys = keys.filter((key) => !unavailable.has(key));
  const paged = Number.isInteger(limit) && limit > 0;
  if (!paged && !paths && keys.length > LINK_SCAN_CAP) {
    return { notes: 0, links: 0, capped: true };
  }

  const visibleKeys = keys;
  if (paths) {
    const selected = new Set(paths);
    keys = keys.filter((key) => selected.has(key));
  } else if (paged) {
    keys = keys.filter((key) => !after || key > after).slice(0, limit);
  }

  const wasAt = new Map();
  for (const [from, to] of renames) wasAt.set(to, from);
  const byName = indexByName(allVisibleKeys.map((key) => wasAt.get(key) ?? key));
  // The forwarding ledger includes earlier moves whose link sweeps could not
  // run in a large workspace. Owner sweeps can repair those stale references
  // while preserving the relative style of each link.
  const forwarding = scope === "private" ? await readForwarding(store) : null;
  const forwardTarget = forwarding ? (path) => forwardPath(forwarding, path) : undefined;

  const results = await mapInBatches(keys, REFERENCE_READ_CONCURRENCY, async (key) => {
    try {
      const fromPath = wasAt.get(key) ?? key;
      const object = await getWithLegacyFallback(store, key);
      if (!object) return { notes: 0, links: 0, written: null, failed: false };
      const storedText = await object.text();
      const collaborationBase = await generatedCollaborationBase(store, key, storedText);
      const text = collaborationBase?.text ?? storedText;
      /*
        AN ENCRYPTED NOTE'S STORED BYTES ARE NEVER REWRITTEN.

        There are no links in them to rewrite — the note's links are inside the
        ciphertext — and running a link regex over base64 is a way to corrupt a
        note that nothing can then recover. Skipping is the safe direction, and
        it is checked on the marker rather than on a successful parse so that a
        *broken* envelope is skipped exactly as hard as a good one.

        **The cost, stated rather than left to be discovered: links written
        inside an encrypted note are not rewritten when their target moves,
        and they go stale.** The alternative is decrypt-rewrite-re-encrypt
        inside a walk that already runs against a 50-subrequest budget and a
        4,000-note cap, which is the trade `storage-and-credentials.md` has
        already made in the other direction for bulk moves. See
        `docs/decisions/encryption.md`, "Round-tripping without damaging
        ciphertext".
      */
      if (isEncryptedNote(text)) return { notes: 0, links: 0, written: null, failed: false };
      /*
        A LINK MAY NOT BE POINTED SOMEWHERE ITS OWN NOTE'S READERS CANNOT GO.

        This sweep edits notes OTHER than the one that moved, and each keeps
        its own visibility. `canSee` above decides which notes this caller may
        scan; it says nothing about who reads them afterwards. So an owner
        moving a team-visible note into a private folder had its new path
        written into every team-visible note that referenced it — the privacy
        engine answering `not found` for the note while a note the same reader
        may open spelled out where it went.

        The test is the destination's reach against the referrer's own, so a
        narrowing is refused and a widening is not: `private` may name
        anything, `team` may not name a group's or a private note's path, and
        two different groups resolve to `private` and refuse each other, which
        is `narrowerVisibility`'s existing rule rather than a second one here.

        The manifest this reads is the one the move already wrote through, and
        a destination narrower than `team` can only come from a source that was
        narrower than `team` — whose path the referrer was naming before this
        move and which is not this sweep's to repair.
      */
      const referrerVisibility = effectiveVisibility(key, rules, overrides);
      const allowTarget = (destination) =>
        narrowerVisibility(referrerVisibility, effectiveVisibility(destination, rules, overrides)) ===
          referrerVisibility;
      const rewritten = rewriteLinks(text, { fromPath, toPath: key, renames, byName, forwardTarget, allowTarget });
      if (rewritten === null) return { notes: 0, links: 0, written: null, failed: false };
      if (!write) return { notes: 1, links: rewritten.changed, written: null, failed: false };
      /*
        No snapshot before the overwrite, and that is the *current* rule rather
        than an omission: version history is the customer's object versioning
        (`docs/decisions/storage-and-credentials.md`), and this write path
        landed the same week the snapshots were removed from every other one.
        Restoring one here would put back the write amplification that decision
        measured, on somebody else's bill, for a rollback nothing can read.
      */
      if (collaborationBase) {
        await replaceCollaborationText(store, key, {
          documentId: collaborationBase.documentId,
          expectedEtag: collaborationBase.etag,
          text: rewritten.text,
        });
      } else {
        await store.put(key, rewritten.text);
      }
      return { notes: 1, links: rewritten.changed, written: key, failed: false };
    } catch {
      /*
        THE MOVE HAS ALREADY COMMITTED.

        A reference target can be temporarily unavailable even though the
        moved note is healthy. One concrete case is a different collaborative
        note holding an accepted Yjs update whose dependency has not arrived
        yet. Failing the whole tool here reports a move as failed after its
        source and destination already changed, so a retry can only produce a
        confusing conflict. Keep walking, report the rewrite as incomplete,
        and leave the unavailable note untouched for its normal recovery path.

        The path is deliberately not returned. A caller may be allowed to move
        the target without being allowed to infer which private note could not
        be inspected.
      */
      return { notes: 0, links: 0, written: null, failed: true };
    }
  });
  const notes = results.reduce((sum, result) => sum + result.notes, 0);
  const links = results.reduce((sum, result) => sum + result.links, 0);
  const failedPaths = results.flatMap((result, index) => result.failed ? [keys[index]] : []);
  const failed = failedPaths.length;
  const written = results.flatMap((result) => result.written === null ? [] : [result.written]);

  /*
    THE NOTES THIS REWROTE ARE NOT THE NOTES THE MOVE NAMED.

    Every caller records the move afterwards with the moved note's own two
    paths. The bodies changed here belong to other notes, and until this row
    existed nothing said so: the audit trail — the thing CLAUDE.md promises
    accounts for what happened in somebody's own bucket — described a move and
    was silent about the writes beside it.

    The half with a fixed row behind it is `announceWebsiteChange`, which fires
    only when one of the RECORDED paths is under `website/`. Move a note that
    is not published, rewrite the link to it inside a page that is, and the
    control plane was never told its route index had stopped describing the
    bytes. That is the invariant #941 was written to hold, reached by a door it
    did not know about.

    A separate row rather than more paths on the caller's: this is a different
    action by the same operation, and `rewrite_references` is deliberately not
    in the activity file's `SUBSTANCE` map, so it lands in the audit trail and
    announces the change without making the feed somebody reads any chattier.
  */
  if (written.length > 0) {
    await recordChange(store, "rewrite_references", scope, written.slice(0, RECORDED_PATH_CAP), {
      notes,
      links,
      truncated: written.length > RECORDED_PATH_CAP,
    });
  }
  return {
    notes,
    links,
    capped: failed > 0,
    failed,
    failedPaths,
    ...(paged && !paths ? {
      after: keys.at(-1) ?? after ?? null,
      done: keys.length === 0 || !visibleKeys.some((key) => key > keys.at(-1)),
      scanned: keys.length,
      total: visibleKeys.length,
    } : {}),
  };
}

/** A large workspace needs a durable background reference sweep, even for a
 * one-note move. The move has already committed; keeping its rename map in a
 * job lets the same materializer finish the link work after the request ends.
 */
export async function rewriteReferencesOrQueue(store, scope, rules, overrides, renames) {
  const result = await rewriteReferences(store, scope, rules, overrides, renames);
  // Gateway jobs currently require owner clearance. A team caller must not
  // create a job that the queue will later run with owner permissions.
  if (!result.capped || result.failed > 0 || scope !== "private") return result;
  const entries = [...renames];
  const id = `move-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const job = {
    version: MOVE_JOB_VERSION,
    id,
    status: "rewriting",
    source: entries[0][0],
    destination: entries[0][1],
    reference_scope: scope,
    created_at: now,
    updated_at: now,
    total_objects: entries.length,
    objects: entries.map(([source, destination]) => ({ source, destination })),
    reference_failed_paths: [],
  };
  await persistMoveJob(store, job);
  await writeMoveSentinel(store);
  try {
    await store.enqueueGatewayJob?.({ kind: "materialize_move", moveId: id });
  } catch {
    // The marker remains resumable if queueing is temporarily unavailable.
  }
  try {
    store.defer?.(async () => {
      const { materializeMoveInBackground } = await import("./materialize.js");
      await materializeMoveInBackground(store, scope, id);
    });
  } catch {
    // The durable job is the source of truth, not this request's lifetime.
  }
  return { notes: 0, links: 0, capped: false, pending: true, moveId: id };
}

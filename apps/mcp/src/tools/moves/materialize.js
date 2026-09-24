/**
 * Materializing a logical folder move, batch by batch — the tool, the
 * background kick, and the privacy clean-up once the source is empty.
 */

import { collaborationHead } from "../../live/collaborationHttp.js";
import { supported as collaborationSupported } from "@context/collaboration";
import {
  copyObjectForMove,
  deleteObjectForMove,
  destinationMatchesMoveSource,
  objectMatchesMoveItem,
  referencesLine,
} from "../../moves/objects.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../../storageLayout.js";
import {
  isPlumbing,
  PRIVACY_KEY,
  PrivacyOverrides,
  replacePrivacyRulesBlock,
} from "../../privacy/engine.js";
import { loadPrivacyState } from "../../privacy/state.js";
import { MOVE_MATERIALIZE_BATCH } from "../../moves/limits.js";
import {
  moveJobActive,
  moveJobKey,
  persistMoveJob,
  refreshMoveSentinel,
} from "../../moves/jobs.js";
import { pruneEmptyFolders } from "../../store/index.js";
import { recordChange } from "../../activity/record.js";
import { rewriteReferences } from "./references.js";
import { toolError, toolText } from "../results.js";

async function cleanupPrivacySourceAfterMove(store, job) {
  const removableSources = new Set((job.objects || []).map((item) => item.source).filter(Boolean));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = await loadPrivacyState(store);
    if (state.error || state.legacy) return;
    const rules = state.rules;
    const overrides = new PrivacyOverrides();
    for (const [path, visibility] of state.overrides.entries()) {
      if (!removableSources.has(path)) overrides.set(path, visibility);
    }
    const next = replacePrivacyRulesBlock(state.text, rules, overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
}

export async function materializeMoveInBackground(store, scope, id) {
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await toolMaterializeMove(store, scope, id, MOVE_MATERIALIZE_BATCH);
    const text = result?.content?.[0]?.text || "";
    if (result?.isError || text.includes("complete") || text.includes("no active work")) return;
  }
}

export async function toolMaterializeMove(store, scope, idArg, batchSizeArg) {
  const key = moveJobKey(idArg);
  if (!key) return toolError("invalid move id");
  const marker = await getWithLegacyFallback(store, key);
  if (!marker) {
    await refreshMoveSentinel(store);
    return toolError("not found");
  }

  let job;
  try {
    job = JSON.parse(await marker.text());
  } catch {
    return toolError("move marker is invalid");
  }
  if (!moveJobActive(job)) {
    await refreshMoveSentinel(store);
    return toolText(
      `move ${job?.id || idArg}: ${job?.status || "unknown"}\nphysical storage sync: no active work`
    );
  }
  const batchSize =
    Number.isInteger(batchSizeArg) && batchSizeArg > 0
      ? Math.min(batchSizeArg, MOVE_MATERIALIZE_BATCH)
      : MOVE_MATERIALIZE_BATCH;
  const sourcePrefix = `${job.source}/`;
  const sources = job.objects.filter(
    (item) =>
      typeof item.source === "string" &&
      typeof item.destination === "string" &&
      item.source.startsWith(sourcePrefix) &&
      item.destination.startsWith(`${job.destination}/`) &&
      !isPlumbing(item.source) &&
      !isPlumbing(item.destination)
  );

  let copiedThisPass = 0;
  try {
    const copied = new Set(Array.isArray(job.copied) ? job.copied : []);
    job.status = "copying";
    for (const pair of sources) {
      if (copied.has(pair.source)) continue;
      const sourceObject = await getWithLegacyFallback(store, pair.source);
      if (!sourceObject) throw new Error(`source missing during materialization: ${pair.source}`);
      if (!objectMatchesMoveItem(sourceObject, pair)) {
        throw new Error(`source changed during materialization: ${pair.source}`);
      }
      // Large moves are materialized in bounded passes. Checking every source
      // head before every pass turns a 1,200-note move into an O(n²) sequence
      // of signed storage reads. The initial logical cutover already rejects
      // existing heads; recheck the exact source immediately before this pass
      // copies it so a head created after cutover still fails closed.
      if (collaborationSupported(store) && pair.source.endsWith(".md") &&
          await collaborationHead(store, pair.source)) {
        throw new Error(
          `${pair.source} has active collaboration history; move it through the note lifecycle first`,
        );
      }
      if (await destinationMatchesMoveSource(store, pair)) {
        copied.add(pair.source);
        continue;
      }
      if ((await getWithLegacyFallback(store, pair.destination)) !== null) {
        throw new Error(`destination changed during materialization: ${pair.destination}`);
      }
      await copyObjectForMove(store, pair);
      if (!(await destinationMatchesMoveSource(store, pair))) {
        throw new Error(`destination verification failed: ${pair.destination}`);
      }
      copied.add(pair.source);
      copiedThisPass += 1;
      if (copiedThisPass >= batchSize) break;
    }

    for (const pair of sources) {
      if (copied.has(pair.source)) continue;
      if (await destinationMatchesMoveSource(store, pair)) copied.add(pair.source);
    }
    job.copied = [...copied].sort();
    job.copied_objects = copied.size;
    job.total_objects = sources.length;
    if (copied.size < sources.length) {
      await persistMoveJob(store, job);
      return toolText(
        `move ${job.id}: copying\ncopied: ${copied.size}/${sources.length}\nthis_pass: ${copiedThisPass}`
      );
    }

    job.status = "deleting";
    let deletedThisPass = 0;
    for (const pair of sources) {
      const sourceObject = await getWithLegacyFallback(store, pair.source);
      if (sourceObject === null) continue;
      if (!objectMatchesMoveItem(sourceObject, pair)) {
        throw new Error(`source changed before cleanup: ${pair.source}`);
      }
      // Recheck at retirement too: a collaborator may have promoted the raw
      // source after it was copied, and that active identity must never be
      // replaced by the move's tombstone.
      if (collaborationSupported(store) && pair.source.endsWith(".md") &&
          await collaborationHead(store, pair.source)) {
        throw new Error(
          `${pair.source} has active collaboration history; move it through the note lifecycle first`,
        );
      }
      if (!(await destinationMatchesMoveSource(store, pair))) {
        throw new Error(`destination changed before source cleanup: ${pair.destination}`);
      }
      await deleteObjectForMove(store, pair);
      deletedThisPass += 1;
      if (deletedThisPass >= batchSize) break;
    }
    const remainingSources = [];
    for (const pair of sources) {
      if ((await getWithLegacyFallback(store, pair.source)) !== null) remainingSources.push(pair.source);
    }
    job.deleted_objects = sources.length - remainingSources.length;
    if (remainingSources.length > 0) {
      job.status = "needs_cleanup";
      await persistMoveJob(store, job);
      return toolText(
        `move ${job.id}: needs_cleanup\ndeleted: ${job.deleted_objects}/${sources.length}\nthis_pass: ${deletedThisPass}`
      );
    }

    job.status = "complete";
    job.deleted_objects = sources.length;
    await persistMoveJob(store, job);
    // The folder itself, where the backend has one. Same reason as the direct
    // folder move — on Dropbox the sources go and the directory stays, so the
    // move reads as a copy until this runs.
    await pruneEmptyFolders(
      store,
      sources.map((item) => item.source),
      { roots: [job.source], keep: [job.destination] }
    );
    await cleanupPrivacySourceAfterMove(store, job).catch(() => {});
    let references = { links: 0, capped: true };
    try {
      const state = await loadPrivacyState(store);
      if (!state.error && !state.legacy) {
        references = await rewriteReferences(
          store,
          scope,
          state.rules,
          state.overrides,
          new Map(sources.map((item) => [item.source, item.destination]))
        );
      }
    } catch {
      // The storage move has completed. Reference rewrite failures are surfaced
      // in the response instead of keeping a completed move marker alive.
    }
    await deleteWithLegacyFallback(store, key);
    await refreshMoveSentinel(store);
    await recordChange(store, "materialize_move", scope, [job.source, job.destination], {
      logical_move: job.id,
      status: "complete",
      count: sources.length,
      references: references.capped ? "not-rewritten" : references.links,
    });
    return toolText(`move ${job.id}: complete\nphysical storage sync: complete` + referencesLine(references));
  } catch (error) {
    job.status = job.status === "deleting" ? "needs_cleanup" : "copying";
    job.error = error.message;
    await persistMoveJob(store, job).catch(() => {});
    return toolError(`move ${job.id} materialization paused: ${error.message}`);
  }
}

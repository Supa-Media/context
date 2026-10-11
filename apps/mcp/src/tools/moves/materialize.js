/**
 * Materializing a logical folder move, batch by batch — the tool, the
 * background kick, and the privacy clean-up once the source is empty.
 */

import { collaborationHead } from "../../live/collaborationHttp.js";
import {
  moveDocument as moveCollaborationDocument,
  readDocument as readCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import {
  copyObjectForMove,
  deleteCreatedDestination,
  deleteObjectForMove,
  destinationMatchesMoveSource,
  objectMatchesMoveItem,
} from "../../moves/objects.js";
import { deleteWithLegacyFallback, getWithLegacyFallback } from "../../storageLayout.js";
import {
  archiveRoot,
  effectiveVisibility,
  isPlumbing,
  PRIVACY_KEY,
  PrivacyOverrides,
  replacePrivacyRulesBlock,
} from "../../privacy/engine.js";
import { loadPrivacyState } from "../../privacy/state.js";
import { MOVE_AUTOMATIC_BATCH, MOVE_AUTOMATIC_REFERENCE_BATCH, MOVE_MATERIALIZE_BATCH } from "../../moves/limits.js";
import {
  moveJobActive,
  moveJobKey,
  persistMoveJob,
  refreshMoveSentinel,
} from "../../moves/jobs.js";
import { pruneEmptyFolders } from "../../store/index.js";
import { recordChange } from "../../activity/record.js";
import { onlyLinkTargetsChanged } from "../../links.js";
import { referenceCandidates, rewriteReferences } from "./references.js";
import { listAllNoteKeys } from "../../notes/visibleKeys.js";
import { listImmediateLayout } from "../../notes/storage.js";
import { loadMoveJobs } from "../../moves/jobs.js";
import { readForwarding } from "../../forwarding.js";
import { generatedCollaborationBase } from "../../notes/sealing.js";
import { toolError, toolText } from "../results.js";

// Owner-only diagnostics for a wrapped storage failure. Provider exceptions
// may echo request URLs, object keys or credentials, so return a short redacted
// fragment only in the immediate tool response; never persist it in the move
// marker, activity or gateway job status.
//
// The shape rules below cannot see an access key id: ~20 unlabelled
// alphanumerics, no scheme, no `/`, nothing beside it to key on, and under the
// 32-character run the catch-all looks for. `InvalidAccessKeyId` is also the
// provider error most likely to echo one, and `bindingView` masks that same
// value everywhere else it surfaces. So `store` is read for the id this
// request is signing with and that exact value is replaced — the argument
// `scrubProviderError` already makes in the control plane: a value we hold is
// detectable, while a shape rule broad enough to catch it would also redact
// real all-caps provider codes like REQUESTTIMETOOSKEWED. The plaintext secret
// is not compared because it is 40 characters and the catch-all has it.
export function safeMoveStorageDetail(error, store) {
  if (error?.code !== "STORAGE_WRITE_FAILED" || typeof error?.cause?.message !== "string") return "";
  let detail = error.cause.message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\b[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\b/g, "[path]")
    .replace(/\b(?:authorization|bearer|basic|api[_-]?key|token|secret|password)\b\s*[:=]?\s*\S+/gi, "[credential]")
    .replace(/\b[A-Za-z0-9+_=-]{32,}\b/g, "[long value]");
  // Before the cap, so a half-cut id cannot survive it. Split/join rather than
  // a built regex: the value is not ours to assume is regex-safe.
  const keyId = store?.accessKeyId;
  if (typeof keyId === "string" && keyId.length >= 8) detail = detail.split(keyId).join("[credential]");
  detail = detail.slice(0, 180).trim();
  return detail ? `\nprovider detail (redacted): ${detail}` : "";
}

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

async function rewriteMoveReferences(store, scope, job, key, batchSize) {
  const state = await loadPrivacyState(store);
  if (state.error || state.legacy) return toolError(`move ${job.id} reference rewrite paused: privacy state unavailable`);
  // A full inventory can take longer than one gateway request in a large
  // workspace. Persist one object-store page per pass, so link rewriting can
  // resume without starting the inventory again on every page of references.
  if (job.reference_inventory_complete !== true) {
    if ((job.reference_inventory_pages || 0) >= 100) {
      return toolError(`move ${job.id} reference inventory paused: exceeded 100 pages`);
    }
    if (!Array.isArray(job.reference_inventory_prefixes)) {
      // The tree's link table answers the whole inventory in one pass, and
      // names the few notes worth reading (`tree/links.js`).
      const fromTable = await referenceCandidates(store, new Map(job.objects.map((item) => [item.source, item.destination])));
      if (fromTable !== null) {
        job.reference_inventory_keys = fromTable.inventoryKeys;
        job.reference_candidates = [...fromTable.candidates];
        job.reference_inventory_complete = true;
        await persistMoveJob(store, job);
        return toolText(`move ${job.id}: reference inventory complete`);
      }
      const layout = await listImmediateLayout(store);
      job.reference_inventory_prefixes = layout.prefixes;
      job.reference_inventory_index = 0;
      job.reference_inventory_keys = layout.objects
        .map((object) => object.key)
        .filter((path) => path.endsWith(".md") && !isPlumbing(path));
    }
    const prefix = job.reference_inventory_prefixes[job.reference_inventory_index];
    if (!prefix) {
      job.reference_inventory_complete = true;
      await persistMoveJob(store, job);
      return toolText(`move ${job.id}: reference inventory complete`);
    }
    const page = await store.list({
      prefix,
      cursor: job.reference_inventory_cursor || undefined,
      limit: 1000,
    });
    if (page.truncated && (!page.cursor || page.cursor === job.reference_inventory_cursor)) {
      return toolError(`move ${job.id} reference inventory paused: invalid storage cursor`);
    }
    for (const object of page.objects || []) {
      if (object.key.endsWith(".md") && !isPlumbing(object.key)) {
        job.reference_inventory_keys.push(object.key);
      }
    }
    job.reference_inventory_pages = (job.reference_inventory_pages || 0) + 1;
    job.reference_inventory_cursor = page.truncated ? page.cursor : null;
    if (!page.truncated) job.reference_inventory_index += 1;
    job.reference_inventory_complete = job.reference_inventory_index >= job.reference_inventory_prefixes.length;
    if (job.reference_inventory_complete) {
      job.reference_inventory_keys = [...new Set(job.reference_inventory_keys)];
    }
    await persistMoveJob(store, job);
    return toolText(`move ${job.id}: inventorying references\npages: ${job.reference_inventory_pages}`);
  }
  const renames = new Map(job.objects.map((item) => [item.source, item.destination]));
  // A large floor made even a one-object recovery call scan 50 notes. One
  // expensive collaboration document could then outlive the gateway timeout
  // without committing the cursor. Keep the worker's requested bound.
  const referenceBatchSize = Math.max(1, batchSize);
  const pending = Array.isArray(job.reference_failed_paths) ? job.reference_failed_paths : [];
  const retrying = job.reference_scan_complete === true && pending.length > 0;
  const selected = retrying ? pending.slice(0, referenceBatchSize) : null;
  const candidates = Array.isArray(job.reference_candidates) ? new Set(job.reference_candidates) : undefined;
  const result = await rewriteReferences(store, job.reference_scope || scope, state.rules, state.overrides, renames,
    retrying ? { paths: selected, currentJobId: job.id, inventoryKeys: job.reference_inventory_keys, candidates } :
      { after: job.reference_after, limit: referenceBatchSize, currentJobId: job.id,
        inventoryKeys: job.reference_inventory_keys, candidates });
  if (!Array.isArray(result.failedPaths)) {
    return toolError(`move ${job.id} reference rewrite paused: note listing did not finish`);
  }

  job.reference_notes = (job.reference_notes || 0) + result.notes;
  job.reference_links = (job.reference_links || 0) + result.links;
  if (retrying) {
    job.reference_failed_paths = [...pending.slice(selected.length), ...result.failedPaths];
    if (result.failedPaths.length === selected.length && selected.length > 0) {
      await persistMoveJob(store, job);
      return toolError(`move ${job.id} reference rewrite paused: ${pending.length} notes could not be updated`);
    }
  } else {
    job.reference_after = result.after;
    job.reference_scanned = (job.reference_scanned || 0) + result.scanned;
    job.reference_total = result.total;
    job.reference_scan_complete = result.done;
    job.reference_failed_paths = [...pending, ...result.failedPaths];
  }
  if (!job.reference_scan_complete || job.reference_failed_paths.length > 0) {
    await persistMoveJob(store, job);
    return toolText(`move ${job.id}: rewriting\nreferences: ${job.reference_scanned || 0}/${job.reference_total || 0}`);
  }

  job.status = "complete";
  await persistMoveJob(store, job);
  await deleteWithLegacyFallback(store, key);
  await refreshMoveSentinel(store);
  await recordChange(store, "materialize_move", scope, [job.source, job.destination], {
    logical_move: job.id,
    status: "complete",
    count: job.total_objects,
    references: job.reference_links || 0,
    preserved_conflicts: Object.keys(job.conflicts || {}).length,
  }).catch(() => {});
  return toolText(`move ${job.id}: complete\nphysical storage sync: complete\nreferences rewritten: ${job.reference_links || 0}\nconflicts preserved: ${Object.keys(job.conflicts || {}).length}`);
}

export async function materializeMoveInBackground(store, scope, id) {
  for (let pass = 0; pass < 20; pass += 1) {
    const result = await toolMaterializeMove(store, scope, id, MOVE_AUTOMATIC_BATCH, { automatic: true });
    const text = result?.content?.[0]?.text || "";
    if (result?.isError || text.includes("complete") || text.includes("no active work")) return;
  }
}

async function destinationMatchesOriginalOrRetargetedLinks(store, pair) {
  if (await destinationMatchesMoveSource(store, pair)) return true;
  if (!pair.source.endsWith(".md") || await collaborationHead(store, pair.source)) return false;
  const [source, destination] = await Promise.all([
    getWithLegacyFallback(store, pair.source),
    getWithLegacyFallback(store, pair.destination),
  ]);
  if (!source || !destination || !objectMatchesMoveItem(source, pair)) return false;
  return onlyLinkTargetsChanged(await source.text(), await destination.text());
}

function generatedCommunicationSource(path, text) {
  if (!path.startsWith("2-areas/communications/") || !path.endsWith(".md")) return false;
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1] || "";
  return /^generated:\s/m.test(frontmatter) &&
    (/^role:\s*communication-contact\s*$/m.test(frontmatter) ||
      /^source:\s*imessage\s*$/m.test(frontmatter) ||
      path.startsWith("2-areas/communications/daily/"));
}

/**
 * The folder a move conflict is backed up into: this context's own archive, so
 * a backup lands where archiving lands. A context that declares none keeps
 * `4-archive`, the folder these backups have always used.
 */
function conflictArchiveRoot(privacy) {
  return archiveRoot(privacy.rules) || "4-archive";
}

async function preserveGeneratedConflict(store, job, pair, sourceObject) {
  const sourceText = await sourceObject.text();
  if (!generatedCommunicationSource(pair.source, sourceText) ||
      await collaborationHead(store, pair.source)) return false;
  const privacy = await loadPrivacyState(store);
  const backup = `${conflictArchiveRoot(privacy)}/${pair.source.slice(0, -3)}.move-conflict-${job.id}.md`;
  if (privacy.error || privacy.legacy ||
      effectiveVisibility(pair.source, privacy.rules, privacy.overrides) !==
        effectiveVisibility(backup, privacy.rules, privacy.overrides)) return false;
  let preserved = await getWithLegacyFallback(store, backup);
  if (!preserved) {
    await store.put(backup, sourceText, { onlyIf: { absent: true } });
    preserved = await getWithLegacyFallback(store, backup);
  }
  if (!preserved || await preserved.text() !== sourceText) return false;
  job.conflicts ||= {};
  job.conflicts[pair.source] = backup;
  return true;
}

async function ensureCleanupDestination(store, pair, sourceObject, setStage = () => {}) {
  let destination = await getWithLegacyFallback(store, pair.destination);
  if (!destination && collaborationSupported(store) && pair.source.endsWith(".md")) {
    setStage("checking interrupted collaboration move");
    const sourceHead = await collaborationHead(store, pair.source);
    const destinationHead = await collaborationHead(store, pair.destination);
    const recoveryPath = sourceHead?.status === "moving" ? pair.source :
      destinationHead?.status === "prepared" ? pair.destination : null;
    if (recoveryPath) {
      setStage("recovering interrupted collaboration move");
      try {
        await readCollaborationDocument(store, recoveryPath);
      } catch (error) {
        if (error?.code !== "MOVED") throw error;
      }
      sourceObject = await getWithLegacyFallback(store, pair.source);
      destination = await getWithLegacyFallback(store, pair.destination);
    }
  }
  if (!destination && sourceObject) {
    setStage("recreating cleanup destination");
    if (!objectMatchesMoveItem(sourceObject, pair)) {
      throw new Error(`source changed before destination recovery: ${pair.source}`);
    }
    await copyObjectForMove(store, pair);
    destination = await getWithLegacyFallback(store, pair.destination);
    if (!destination || !await destinationMatchesMoveSource(store, pair)) {
      throw new Error(`destination recovery failed: ${pair.destination}`);
    }
  }
  if (!destination) throw new Error(`source and destination missing during cleanup: ${pair.source}`);
  return sourceObject;
}

async function preserveCollaborativeGeneratedConflict(store, job, pair, sourceObject) {
  if (!generatedCommunicationSource(pair.source, await sourceObject.text())) return false;
  const privacy = await loadPrivacyState(store);
  const backup = `${conflictArchiveRoot(privacy)}/${pair.source.slice(0, -3)}.move-collaboration-conflict-${job.id}.md`;
  if (privacy.error || privacy.legacy ||
      effectiveVisibility(pair.source, privacy.rules, privacy.overrides) !==
        effectiveVisibility(backup, privacy.rules, privacy.overrides)) return false;
  const source = await readCollaborationDocument(store, pair.source);
  if (await getWithLegacyFallback(store, backup) || await collaborationHead(store, backup)) return false;
  await moveCollaborationDocument(store, pair.source, backup, { expectedEtag: source.etag });
  if (await getWithLegacyFallback(store, pair.source) || !await getWithLegacyFallback(store, backup)) {
    throw new Error(`collaboration conflict backup did not retire source: ${pair.source}`);
  }
  job.conflicts ||= {};
  job.conflicts[pair.source] = backup;
  return true;
}

// Each pair has its own storage key and collaboration journal. Await every
// in-flight pair before checkpointing the marker, including when one fails:
// persisting while another pair is still retiring its source would make the
// marker describe a state that has not settled yet.
async function retireMovePair(store, job, pair) {
  let stage = "checking cleanup destination";
  try {
    let sourceObject = await getWithLegacyFallback(store, pair.source);
    sourceObject = await ensureCleanupDestination(store, pair, sourceObject, (value) => { stage = value; });
    if (sourceObject === null) return { deleted: true, processed: false };
    if (!objectMatchesMoveItem(sourceObject, pair)) {
      throw new Error(`source changed before cleanup: ${pair.source}`);
    }
    stage = "reading collaboration heads";
    const sourceHead = collaborationSupported(store) && pair.source.endsWith(".md")
      ? await collaborationHead(store, pair.source) : null;
    const destinationHead = sourceHead ? await collaborationHead(store, pair.destination) : null;
    if (sourceHead && destinationHead) {
      if (sourceHead.status === "moving") {
        try {
          await readCollaborationDocument(store, pair.source);
        } catch (error) {
          if (error?.code !== "MOVED") throw error;
        }
        if (!await getWithLegacyFallback(store, pair.source) &&
            await getWithLegacyFallback(store, pair.destination)) {
          return { deleted: true, processed: true };
        }
      }
      stage = "preserving collaboration collision";
      if (!await preserveCollaborativeGeneratedConflict(store, job, pair, sourceObject)) {
        throw new Error(`destination collaboration generation exists: ${pair.destination}`);
      }
      return { deleted: true, processed: true };
    }
    stage = "verifying cleanup copy";
    if (job.conflicts?.[pair.source]) {
      stage = "verifying preserved conflict";
      const backup = await getWithLegacyFallback(store, job.conflicts[pair.source]);
      const destination = await getWithLegacyFallback(store, pair.destination);
      if (!backup || !destination || await backup.text() !== await sourceObject.text()) {
        throw new Error(`preserved conflict changed before source cleanup: ${pair.source}`);
      }
    } else if (!(await destinationMatchesOriginalOrRetargetedLinks(store, pair))) {
      stage = "preserving changed destination";
      if (!await preserveGeneratedConflict(store, job, pair, sourceObject)) {
        throw new Error(`destination changed before source cleanup: ${pair.destination}`);
      }
    }
    stage = "retiring source";
    if (sourceHead && !["active", "moving"].includes(sourceHead.status)) {
      throw new Error(`source collaboration generation changed before cleanup: ${pair.source}`);
    }
    if (sourceHead && job.conflicts?.[pair.source]) {
      throw new Error(`source collaboration generation appeared after conflict preservation: ${pair.source}`);
    }
    if (sourceHead) {
      stage = "moving collaboration history";
      const destination = await getWithLegacyFallback(store, pair.destination);
      if (!destination || !await deleteCreatedDestination(store, pair.destination, destination.etag)) {
        throw new Error(`could not prepare collaboration destination: ${pair.destination}`);
      }
      const base = await readCollaborationDocument(store, pair.source);
      await moveCollaborationDocument(store, pair.source, pair.destination, { expectedEtag: base.etag });
    } else {
      await deleteObjectForMove(store, pair);
    }
    return { deleted: (await getWithLegacyFallback(store, pair.source)) === null, processed: true };
  } catch (error) {
    if (error && typeof error === "object") error.moveStage = stage;
    throw error;
  }
}

export async function toolMaterializeMove(store, scope, idArg, batchSizeArg, options = {}) {
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
  // A zero batch is an owner-only, read-only diagnostic. In particular it must
  // not refresh the marker or start another worker while one may be running.
  if (batchSizeArg === 0) {
    const objects = Array.isArray(job.objects) ? job.objects : [];
    const completed = new Set(job.status === "copying" || job.status === "logical_active"
      ? job.copied : job.deleted);
    const next = objects.find((item) => typeof item?.source === "string" && !completed.has(item.source));
    return toolText([
      `move ${job.id || idArg}: ${job.status || "unknown"}`,
      `copied: ${job.copied_objects || 0}/${objects.length}`,
      `deleted: ${job.deleted_objects || 0}/${objects.length}`,
      `updated_at: ${job.updated_at || "unknown"}`,
      `references_scanned: ${job.reference_scanned || 0}/${job.reference_total || 0}`,
      `reference_after: ${job.reference_after || "none"}`,
      `reference_failures: ${job.reference_failed_paths?.length || 0}`,
      `reference_scan_complete: ${job.reference_scan_complete === true}`,
      `next_source: ${next?.source || "none"}`,
      `next_destination: ${next?.destination || "none"}`,
      `next_size: ${Number.isSafeInteger(next?.size) ? next.size : "unknown"}`,
    ].join("\n"));
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
  const referenceBatchSize = options.automatic === true
    ? Math.min(batchSize, MOVE_AUTOMATIC_REFERENCE_BATCH) : batchSize;
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

  if (job.status === "rewriting") {
    try {
      return await rewriteMoveReferences(store, scope, job, key, referenceBatchSize);
    } catch (error) {
      return toolError(`move ${job.id} reference rewrite paused: ${error.message}`);
    }
  }

  let copiedThisPass = 0;
  let stage = "copying";
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
      // Copy the raw body first. At retirement, a headed note is handed to the
      // collaboration lifecycle, which moves its identity and retained edits.
      // A head created between these steps is handled there too.
      if (await destinationMatchesOriginalOrRetargetedLinks(store, pair)) {
        copied.add(pair.source);
        continue;
      }
      if ((await getWithLegacyFallback(store, pair.destination)) !== null) {
        if (await preserveGeneratedConflict(store, job, pair, sourceObject)) {
          copied.add(pair.source);
          copiedThisPass += 1;
          if (copiedThisPass >= batchSize) break;
          continue;
        }
        throw new Error(`destination changed during materialization: ${pair.destination}`);
      }
      await copyObjectForMove(store, pair);
      if (!(await destinationMatchesOriginalOrRetargetedLinks(store, pair))) {
        throw new Error(`destination verification failed: ${pair.destination}`);
      }
      copied.add(pair.source);
      copiedThisPass += 1;
      if (copiedThisPass >= batchSize) break;
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
    stage = "cleaning up";
    let deletedThisPass = 0;
    const deleted = new Set(Array.isArray(job.deleted) ? job.deleted : []);
    const pending = sources.filter((pair) => !deleted.has(pair.source)).slice(0, batchSize);
    let cleanupError = null;
    for (let index = 0; index < pending.length; index += 3) {
      const group = pending.slice(index, index + 3);
      const results = await Promise.allSettled(group.map((pair) => retireMovePair(store, job, pair)));
      for (let offset = 0; offset < group.length; offset += 1) {
        const result = results[offset];
        if (result.status === "rejected") {
          cleanupError ||= result.reason;
          continue;
        }
        if (result.value.deleted) deleted.add(group[offset].source);
        if (result.value.processed) deletedThisPass += 1;
      }
      if (cleanupError) break;
    }
    job.deleted = [...deleted].sort();
    job.deleted_objects = deleted.size;
    if (cleanupError) throw cleanupError;
    // A backend may retain logical delete markers in its listing, so only a
    // real read can distinguish a retired source from one restored out of
    // band. Check the finish line in checkpointed, bounded parallel slices:
    // the old one-request sweep made a large move time out after its last
    // successful cleanup batch and then repeat that sweep forever.
    if (deleted.size === sources.length) {
      stage = "verifying retired sources";
      const start = Number.isInteger(job.cleanup_verify_index) && job.cleanup_verify_index >= 0
        ? job.cleanup_verify_index : 0;
      const end = Math.min(start + 40, sources.length);
      for (let index = start; index < end; index += 8) {
        const group = sources.slice(index, Math.min(index + 8, end));
        const present = await Promise.all(group.map((pair) => getWithLegacyFallback(store, pair.source)));
        for (let offset = 0; offset < group.length; offset += 1) {
          if (present[offset]) deleted.delete(group[offset].source);
        }
      }
      job.cleanup_verify_index = deleted.size === sources.length ? end : 0;
      if (deleted.size === sources.length && end < sources.length) {
        await persistMoveJob(store, job);
        return toolText(
          `move ${job.id}: needs_cleanup\ndeleted: ${deleted.size}/${sources.length}` +
          `\nverified: ${end}/${sources.length}\nthis_pass: ${deletedThisPass}`
        );
      }
    }
    job.cleanup_verify_index = 0;
    job.deleted = [...deleted].sort();
    job.deleted_objects = deleted.size;
    if (deleted.size < sources.length) {
      job.status = "needs_cleanup";
      await persistMoveJob(store, job);
      return toolText(
        `move ${job.id}: needs_cleanup\ndeleted: ${job.deleted_objects}/${sources.length}\nthis_pass: ${deletedThisPass}`
      );
    }

    job.status = "rewriting";
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
    return await rewriteMoveReferences(store, scope, job, key, referenceBatchSize);
  } catch (error) {
    job.status = job.status === "deleting" ? "needs_cleanup" :
      job.status === "rewriting" ? "rewriting" : "copying";
    stage = error?.moveStage || stage;
    // Collaboration wraps storage failures to avoid leaking bucket details to
    // ordinary editors. This command is owner-only maintenance, and the
    // provider's error code is needed to distinguish a retryable outage from
    // an invalid write that will pause the same job forever. Keep the message
    // itself out of the response: providers may include customer paths in it.
    const providerCode = String(error?.cause?.code ?? "");
    const causeCode = error?.code === "STORAGE_WRITE_FAILED" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(providerCode)
      ? ` (provider code: ${providerCode})` : "";
    job.error = `${stage}: ${error.message}${causeCode}`;
    await persistMoveJob(store, job).catch(() => {});
    return toolError(`move ${job.id} materialization paused: ${job.error}${safeMoveStorageDetail(error, store)}`);
  }
}

/** Owner-only, read-only timings for a stalled reference sweep. The bounded
 * probe avoids refreshing the job lease or starting a second materializer. */
export async function toolProfileMoveReferences(store, idArg) {
  const key = moveJobKey(idArg);
  if (!key) return toolError("invalid move id");
  const marker = await getWithLegacyFallback(store, key);
  if (!marker) return toolError("not found");
  let job;
  try { job = JSON.parse(await marker.text()); } catch { return toolError("move marker is invalid"); }
  if (!moveJobActive(job) || job.status !== "rewriting") return toolError("move is not rewriting references");
  const rows = [];
  async function measure(name, operation) {
    const start = Date.now();
    let timer;
    try {
      const value = await Promise.race([
        operation(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 15000); }),
      ]);
      rows.push(`${name}: ${Date.now() - start}ms`);
      return value;
    } catch (error) {
      rows.push(`${name}: ${error.message === "timeout" ? "over 15000ms" : "failed"}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  // The materializer already checkpointed this inventory. Re-listing the
  // entire bucket here made the diagnostic time out before reaching the
  // expensive stage that actually blocks the worker.
  const checkpointed = job.reference_inventory_complete === true &&
    Array.isArray(job.reference_inventory_keys);
  const keys = checkpointed
    ? job.reference_inventory_keys.map((key) => ({ key }))
    : await measure("note inventory", () => listAllNoteKeys(store));
  if (!keys) return toolText(rows.join("\n"));
  if (checkpointed) rows.push(`checkpointed inventory: ${keys.length} keys`);
  const jobs = await measure("active move markers", () => loadMoveJobs(store));
  if (!jobs) return toolText(rows.join("\n"));
  await measure("forwarding ledger", () => readForwarding(store));
  const unavailable = new Set();
  for (const active of jobs) for (const item of active.objects) {
    unavailable.add(item.source);
    if (active.id !== job.id) unavailable.add(item.destination);
  }
  const next = keys.map(({ key: path }) => path).filter((path) => path.endsWith(".md") &&
    !unavailable.has(path) && (!job.reference_after || path > job.reference_after)).sort()[0];
  if (next) await measure("next note and collaboration base", async () => {
    const object = await getWithLegacyFallback(store, next);
    if (object) await generatedCollaborationBase(store, next, await object.text());
  });
  rows.push(`inventory count: ${keys.length}`);
  return toolText(rows.join("\n"));
}

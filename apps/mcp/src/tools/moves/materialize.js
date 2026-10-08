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
  effectiveVisibility,
  isPlumbing,
  PRIVACY_KEY,
  PrivacyOverrides,
  replacePrivacyRulesBlock,
} from "../../privacy/engine.js";
import { loadPrivacyState } from "../../privacy/state.js";
import { MOVE_AUTOMATIC_BATCH, MOVE_MATERIALIZE_BATCH } from "../../moves/limits.js";
import {
  moveJobActive,
  moveJobKey,
  persistMoveJob,
  refreshMoveSentinel,
} from "../../moves/jobs.js";
import { pruneEmptyFolders } from "../../store/index.js";
import { recordChange } from "../../activity/record.js";
import { onlyLinkTargetsChanged } from "../../links.js";
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

async function rewriteMoveReferences(store, scope, job, key, batchSize) {
  const state = await loadPrivacyState(store);
  if (state.error || state.legacy) return toolError(`move ${job.id} reference rewrite paused: privacy state unavailable`);
  const renames = new Map(job.objects.map((item) => [item.source, item.destination]));
  const referenceBatchSize = Math.max(batchSize, 50);
  const pending = Array.isArray(job.reference_failed_paths) ? job.reference_failed_paths : [];
  const retrying = job.reference_scan_complete === true && pending.length > 0;
  const selected = retrying ? pending.slice(0, referenceBatchSize) : null;
  const result = await rewriteReferences(store, job.reference_scope || scope, state.rules, state.overrides, renames,
    retrying ? { paths: selected, currentJobId: job.id } :
      { after: job.reference_after, limit: referenceBatchSize, currentJobId: job.id });
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
    const result = await toolMaterializeMove(store, scope, id, MOVE_AUTOMATIC_BATCH);
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

async function preserveGeneratedConflict(store, job, pair, sourceObject) {
  const sourceText = await sourceObject.text();
  if (!generatedCommunicationSource(pair.source, sourceText) ||
      await collaborationHead(store, pair.source)) return false;
  const backup = `4-archive/${pair.source.slice(0, -3)}.move-conflict-${job.id}.md`;
  const privacy = await loadPrivacyState(store);
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

async function ensureCleanupDestination(store, pair, sourceObject) {
  let destination = await getWithLegacyFallback(store, pair.destination);
  if (!destination && collaborationSupported(store) && pair.source.endsWith(".md")) {
    const sourceHead = await collaborationHead(store, pair.source);
    const destinationHead = await collaborationHead(store, pair.destination);
    const recoveryPath = sourceHead?.status === "moving" ? pair.source :
      destinationHead?.status === "prepared" ? pair.destination : null;
    if (recoveryPath) {
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
  const backup = `4-archive/${pair.source.slice(0, -3)}.move-collaboration-conflict-${job.id}.md`;
  const privacy = await loadPrivacyState(store);
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

  if (job.status === "rewriting") {
    try {
      return await rewriteMoveReferences(store, scope, job, key, batchSize);
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
    for (const pair of sources) {
      if (deleted.has(pair.source)) continue;
      let sourceObject = await getWithLegacyFallback(store, pair.source);
      sourceObject = await ensureCleanupDestination(store, pair, sourceObject);
      if (sourceObject === null) {
        deleted.add(pair.source);
        continue;
      }
      if (!objectMatchesMoveItem(sourceObject, pair)) {
        throw new Error(`source changed before cleanup: ${pair.source}`);
      }
      const sourceHead = collaborationSupported(store) && pair.source.endsWith(".md")
        ? await collaborationHead(store, pair.source) : null;
      const destinationHead = sourceHead ? await collaborationHead(store, pair.destination) : null;
      if (sourceHead && destinationHead) {
        // An earlier structural move may only need its journal replayed.
        if (sourceHead.status === "moving") {
          try {
            await readCollaborationDocument(store, pair.source);
          } catch (error) {
            if (error?.code !== "MOVED") throw error;
          }
          if (!await getWithLegacyFallback(store, pair.source) &&
              await getWithLegacyFallback(store, pair.destination)) {
            deleted.add(pair.source);
            deletedThisPass += 1;
            if (deletedThisPass >= batchSize) break;
            continue;
          }
        }
        // A destination with its own collaboration identity cannot receive
        // the source identity. Keep the generated source and its history in
        // the private archive, leaving the destination untouched.
        if (!await preserveCollaborativeGeneratedConflict(store, job, pair, sourceObject)) {
          throw new Error(`destination collaboration generation exists: ${pair.destination}`);
        }
        deleted.add(pair.source);
        deletedThisPass += 1;
        if (deletedThisPass >= batchSize) break;
        continue;
      }
      if (job.conflicts?.[pair.source]) {
        const backup = await getWithLegacyFallback(store, job.conflicts[pair.source]);
        const destination = await getWithLegacyFallback(store, pair.destination);
        if (!backup || !destination || await backup.text() !== await sourceObject.text()) {
          throw new Error(`preserved conflict changed before source cleanup: ${pair.source}`);
        }
      } else if (!(await destinationMatchesOriginalOrRetargetedLinks(store, pair))) {
        if (!await preserveGeneratedConflict(store, job, pair, sourceObject)) {
          throw new Error(`destination changed before source cleanup: ${pair.destination}`);
        }
      }
      const head = sourceHead;
      if (head && !["active", "moving"].includes(head.status)) {
        throw new Error(`source collaboration generation changed before cleanup: ${pair.source}`);
      }
      if (head && job.conflicts?.[pair.source]) {
        throw new Error(`source collaboration generation appeared after conflict preservation: ${pair.source}`);
      }
      if (head) {
        stage = "moving collaboration history";
        const destination = await getWithLegacyFallback(store, pair.destination);
        if (!destination || !await deleteCreatedDestination(store, pair.destination, destination.etag)) {
          throw new Error(`could not prepare collaboration destination: ${pair.destination}`);
        }
        const base = await readCollaborationDocument(store, pair.source);
        await moveCollaborationDocument(store, pair.source, pair.destination, { expectedEtag: base.etag });
        stage = "cleaning up";
      } else {
        await deleteObjectForMove(store, pair);
      }
      if ((await getWithLegacyFallback(store, pair.source)) === null) {
        deleted.add(pair.source);
      }
      deletedThisPass += 1;
      if (deletedThisPass >= batchSize) break;
    }
    // Recheck once at the finish line, including entries restored after an
    // earlier pass. Ordinary passes stay bounded by the work left to do.
    if (deleted.size === sources.length) {
      for (const pair of sources) {
        if ((await getWithLegacyFallback(store, pair.source)) !== null) {
          deleted.delete(pair.source);
        }
      }
    }
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
    return await rewriteMoveReferences(store, scope, job, key, batchSize);
  } catch (error) {
    job.status = job.status === "deleting" ? "needs_cleanup" :
      job.status === "rewriting" ? "rewriting" : "copying";
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
    return toolError(`move ${job.id} materialization paused: ${job.error}`);
  }
}

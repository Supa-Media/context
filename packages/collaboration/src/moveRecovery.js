/** Resuming, or rolling back, a journaled move. */

import { MAX_RETRIES, SCHEMA_VERSION, fail, headKey, put, readObject } from "./storage.js";
import {
  identityHead,
  putHead,
  readHead,
  readState,
  readStructural,
  updateStructural,
  validateState,
} from "./records.js";
import { scrubStructural } from "./purge.js";

export async function recoverMove(store, operationId, attempt = 0) {
  if (attempt >= MAX_RETRIES) throw fail("CONCURRENT_WRITE", "move recovery exceeded its retry budget");
  const retry = () => recoverMove(store, operationId, attempt + 1);
  let opRecord = await readStructural(store, operationId);
  let op = opRecord.value;
  if (op.phase === "aborted") return finishAbortedMove(store, opRecord);
  if (op.phase === "complete") return op;
  const sourceHead = await readHead(store, op.from);
  const destinationHead = await readHead(store, op.to);
  const sourceStateRecord = await readState(store, {
    stateKey: op.stateKey,
    documentId: op.documentId,
    generation: op.generation,
  });
  if (!sourceStateRecord) throw fail("CORRUPT_STATE", "moved document state is missing");
  let state = validateState(sourceStateRecord.value, { documentId: op.documentId, generation: op.generation }, sourceStateRecord.value.path);

  if (sourceHead?.status === "active") {
    const moving = await putHead(store, op.from, identityHead(sourceHead, "moving", { operationId, destination: op.to }), sourceHead.etag);
    if (!moving) return retry();
  } else if (sourceHead && sourceHead.status !== "moving" && sourceHead.status !== "moved") {
    throw fail("STRUCTURAL_CONFLICT", "source path changed during the move");
  }

  const returning = destinationHead?.status === "moved" && destinationHead.documentId === op.documentId && destinationHead.destination === op.from;
  if (!destinationHead || returning) {
    const prepared = {
      schemaVersion: SCHEMA_VERSION,
      path: op.to,
      documentId: op.documentId,
      generation: op.generation,
      stateKey: op.stateKey,
      status: "prepared",
      operationId,
      source: op.from,
    };
    const created = await put(store, await headKey(op.to), JSON.stringify(prepared), returning ? { etagMatches: destinationHead.etag } : { absent: true });
    if (!created) return retry();
  } else if (destinationHead.documentId !== op.documentId || destinationHead.status !== "prepared" && destinationHead.status !== "active") {
    return abortMove(store, opRecord, "destination path is already owned by another document");
  }

  const sourceObject = await readObject(store, op.from);
  let destinationObject = await readObject(store, op.to);
  if (!destinationObject) {
    if (!sourceObject) {
      if (state.path !== op.to) throw fail("STRUCTURAL_CONFLICT", "source Markdown disappeared before the move completed");
    } else {
      if (sourceObject.etag !== op.sourceRawEtag || sourceObject.text !== op.sourceText) {
        return abortMove(store, opRecord, "source Markdown changed during the move");
      }
      const copied = await put(store, op.to, op.sourceText, { absent: true });
      if (!copied) return retry();
      destinationObject = await readObject(store, op.to);
      const journaled = await updateStructural(store, { ...op, destinationRawEtag: copied.etag }, opRecord.etag);
      if (journaled.value.phase === "aborted") return finishAbortedMove(store, journaled);
      if (journaled.value.phase === "complete") return journaled.value;
      opRecord = journaled;
      op = opRecord.value;
      if (!destinationObject || destinationObject.etag !== copied.etag || destinationObject.text !== op.sourceText) {
        return abortMove(store, opRecord, "destination path changed during the move");
      }
    }
  } else if (destinationObject.text !== op.sourceText) {
    return abortMove(store, opRecord, "destination path changed during the move");
  }

  const latestSource = await readObject(store, op.from);
  if (latestSource) {
    if (latestSource.etag !== op.sourceRawEtag || latestSource.text !== op.sourceText) {
      return abortMove(store, opRecord, "source Markdown changed during the move");
    }
    const removed = await store.delete(op.from, { onlyIf: { etagMatches: op.sourceRawEtag } });
    if (removed === null) return retry();
    if (await readObject(store, op.from)) return retry();
  }
  if (!destinationObject) destinationObject = await readObject(store, op.to);
  if (!destinationObject) return abortMove(store, opRecord, "move destination was not materialized");

  if (state.path === op.from && state.structural?.operationId === operationId) {
    const nextState = { ...state, path: op.to, rawMarkdownEtag: destinationObject.etag, structural: null };
    const written = await put(store, op.stateKey, JSON.stringify(nextState), { etagMatches: sourceStateRecord.etag });
    if (!written) return retry();
    state = nextState;
  } else if (state.path !== op.to || state.structural !== null) {
    throw fail("STRUCTURAL_CONFLICT", "document state changed during the move");
  }

  const activeDestination = identityHead({
    path: op.to,
    documentId: op.documentId,
    generation: op.generation,
    stateKey: op.stateKey,
  }, "active");
  const currentDestination = await readHead(store, op.to);
  if (currentDestination?.status === "prepared") {
    const activated = await putHead(store, op.to, activeDestination, currentDestination.etag);
    if (!activated) return retry();
  }
  const currentSource = await readHead(store, op.from);
  if (currentSource?.status === "moving") {
    const moved = await putHead(store, op.from, identityHead(currentSource, "moved", { destination: op.to, operationId }), currentSource.etag);
    if (!moved) return retry();
  }
  const completed = await updateStructural(store, { ...op, phase: "complete" }, opRecord.etag);
  if (completed.value.phase === "aborted") return finishAbortedMove(store, completed);
  if (completed.value.phase !== "complete") return retry();
  await scrubStructural(store, operationId);
  return state;
}

function ownsPreparedMoveHead(head, op) {
  return head?.status === "prepared" && head.operationId === op.operationId &&
    head.documentId === op.documentId && head.generation === op.generation;
}

/** Remove only a move's proven copy before releasing its prepared destination head. */
async function cleanupAbortedMoveDestination(store, op) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let destinationHead = await readHead(store, op.to);
    if (!ownsPreparedMoveHead(destinationHead, op)) return;

    // The body is deleted first so a reader cannot observe a free destination,
    // initialize a new generation, and then lose its object to rollback.
    if (typeof op.destinationRawEtag === "string") {
      const destinationObject = await readObject(store, op.to);
      if (destinationObject?.etag === op.destinationRawEtag) {
        const removed = await store.delete(op.to, { onlyIf: { etagMatches: op.destinationRawEtag } });
        if (removed === null) {
          const latest = await readObject(store, op.to);
          if (latest?.etag === op.destinationRawEtag) continue;
        }
      }
    }

    destinationHead = await readHead(store, op.to);
    if (!ownsPreparedMoveHead(destinationHead, op)) return;
    const removedHead = await store.delete(await headKey(op.to), { onlyIf: { etagMatches: destinationHead.etag } });
    if (removedHead !== null) return;
  }
  throw fail("CONCURRENT_WRITE", "move abort cleanup could not settle the destination");
}

/** Finish a durably aborted move after its journal has fenced further forward recovery. */
export async function finishAbortedMove(store, opRecord) {
  const op = opRecord.value;
  await cleanupAbortedMoveDestination(store, op);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const stateRecord = await readState(store, { stateKey: op.stateKey, documentId: op.documentId, generation: op.generation });
    if (stateRecord?.value?.structural?.operationId === op.operationId) {
      const cleared = { ...stateRecord.value, structural: null };
      const written = await put(store, op.stateKey, JSON.stringify(cleared), { etagMatches: stateRecord.etag });
      if (!written) continue;
    }
    const sourceHead = await readHead(store, op.from);
    if (sourceHead?.status === "moving" && sourceHead.operationId === op.operationId &&
        sourceHead.documentId === op.documentId && sourceHead.generation === op.generation) {
      const restored = await putHead(store, op.from, identityHead(sourceHead, "active"), sourceHead.etag);
      if (!restored) continue;
    }
    return { aborted: true, reason: op.abortedReason };
  }
  throw fail("CONCURRENT_WRITE", "move abort cleanup could not settle the source");
}

/** Roll back a move that was frozen but could not claim its destination. */
async function abortMove(store, opRecord, reason) {
  let current = opRecord;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const op = current.value;
    if (op.phase === "complete") return op;
    if (op.phase === "aborted") return finishAbortedMove(store, current);
    const marked = await updateStructural(store, { ...op, phase: "aborted", abortedReason: reason }, current.etag);
    if (marked.value.phase === "complete") return marked.value;
    if (marked.value.phase === "aborted") return finishAbortedMove(store, marked);
    current = marked;
  }
  throw fail("CONCURRENT_WRITE", "move abort could not record its terminal journal state");
}

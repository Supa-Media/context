/**
 * The operations a move from one context into another runs through the
 * credential barrier, one store at a time (`functions/contextMoves.ts`).
 *
 * Two shapes of batch. Without the gateway's mover, each batch is exported
 * from the source with its bytes, imported into the destination and deleted
 * from the source here. With it (`lib/contextMoveMover.ts`), this deployment
 * plans the batch by name, writes the destination's narrowing exceptions, and
 * afterwards records what arrived and what left; the files go bucket to bucket
 * in the mover and never through here.
 */

import type { Clearance } from "../clearance";
import {
  type FileStore,
  clearMovedSourceRules,
  deleteMovedSources,
  exportContextMoveBatch,
  forgetMovedSources,
  importContextMoveBatch,
  planContextMoveBatch,
  prepareContextMoveLanding,
} from "../fileOps";
import type { FileOperation, OperationResult } from "./operationTypes";

export type ContextMoveOperation = Extract<
  FileOperation,
  {
    kind:
      | "contextMoveExport"
      | "contextMoveImport"
      | "contextMoveDelete"
      | "contextMoveFinish"
      | "contextMovePlan"
      | "contextMovePrepare"
      | "contextMoveArrived"
      | "contextMoveForget";
  }
>;

const KINDS = new Set<string>([
  "contextMoveExport",
  "contextMoveImport",
  "contextMoveDelete",
  "contextMoveFinish",
  "contextMovePlan",
  "contextMovePrepare",
  "contextMoveArrived",
  "contextMoveForget",
]);

export function isContextMoveOperation(operation: FileOperation): operation is ContextMoveOperation {
  return KINDS.has(operation.kind);
}

export async function executeContextMoveOperation(
  store: FileStore,
  clearance: Clearance,
  operation: ContextMoveOperation,
): Promise<OperationResult> {
  switch (operation.kind) {
    case "contextMoveExport": {
      const exported = await exportContextMoveBatch(store, {
        from: operation.from,
        to: operation.to,
        clearance,
        skip: operation.skip,
      });
      return { kind: "contextMoveExported", ...exported };
    }
    case "contextMoveImport": {
      const landed = await importContextMoveBatch(store, {
        objects: operation.objects,
        clearance,
        ...(operation.root === undefined ? {} : { root: operation.root }),
      });
      return { kind: "contextMoveLanded", ...landed };
    }
    case "contextMoveDelete": {
      const removed = await deleteMovedSources(store, { sources: operation.sources, clearance });
      return { kind: "contextMoveRemoved", ...removed };
    }
    case "contextMoveFinish": {
      await clearMovedSourceRules(store, {
        from: operation.from,
        survivors: operation.survivors,
        clearance,
      });
      return { kind: "contextMoveFinished" };
    }
    case "contextMovePlan": {
      const planned = await planContextMoveBatch(store, {
        from: operation.from,
        to: operation.to,
        clearance,
        skip: operation.skip,
        maxObjectBytes: operation.maxObjectBytes,
      });
      return { kind: "contextMovePlanned", ...planned };
    }
    case "contextMovePrepare": {
      await prepareContextMoveLanding(store, {
        objects: operation.objects,
        clearance,
        ...(operation.root === undefined ? {} : { root: operation.root }),
      });
      return { kind: "contextMoveSettled" };
    }
    case "contextMoveArrived":
      // Nothing to do in the bucket: the mover already landed these. The
      // barrier announces them to the tree (`treeChangeOf`).
      return { kind: "contextMoveSettled" };
    case "contextMoveForget":
      await forgetMovedSources(store, { paths: operation.paths });
      return { kind: "contextMoveSettled" };
  }
}

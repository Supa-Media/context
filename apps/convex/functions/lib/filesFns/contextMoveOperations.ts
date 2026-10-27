/**
 * The operations a move from one context into another runs through the
 * credential barrier, one store at a time (`functions/contextMoves.ts`).
 *
 * Each batch is exported from the source with its bytes, imported into the
 * destination and its rows trashed in the source here (`lib/contextMoveBatches.ts`).
 */

import type { Clearance } from "../clearance";
import {
  type FileStore,
  clearMovedSourceRules,
  deleteMovedSources,
  exportContextMoveBatch,
  importContextMoveBatch,
} from "../fileOps";
import type { FileOperation, OperationResult } from "./operationTypes";

export type ContextMoveOperation = Extract<
  FileOperation,
  {
    kind:
      | "contextMoveExport"
      | "contextMoveImport"
      | "contextMoveDelete"
      | "contextMoveFinish";
  }
>;

const KINDS = new Set<string>([
  "contextMoveExport",
  "contextMoveImport",
  "contextMoveDelete",
  "contextMoveFinish",
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
  }
}

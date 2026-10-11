/** Which successful console operations touched `routines/`, and where. */

import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { isUnderRoutines } from "./model";

/**
 * The paths under `routines/` an operation changed, either side of a move,
 * or an empty list. A false positive costs one scan of a small folder; a
 * false negative leaves a routine on its old schedule until the six-hourly
 * sweep, so the moved shapes are read off the result as well as the request.
 */
export function routinePathsTouched(operation: FileOperation, result: OperationResult): string[] {
  const candidates: string[] = [];
  if (result.kind === "moved") {
    const moved = result as { from?: unknown; to?: unknown };
    if (typeof moved.from === "string") candidates.push(moved.from);
    if (typeof moved.to === "string") candidates.push(moved.to);
  }
  switch (operation.kind) {
    case "write":
    case "removeEncryption":
    case "delete":
    case "archive":
    case "trash":
    case "duplicate":
      candidates.push(operation.path);
      break;
    case "move":
    case "copy":
    case "restoreTrash":
      candidates.push(operation.from, operation.to);
      break;
    case "importVault":
      for (const file of operation.files) candidates.push(file.path);
      break;
    case "contextMoveImport":
      if (operation.root !== undefined) candidates.push(operation.root);
      for (const object of operation.objects) candidates.push(object.destination);
      break;
    case "contextMoveDelete":
      for (const source of operation.sources) candidates.push(source.path);
      break;
    case "contextMoveFinish":
      candidates.push(operation.from);
      break;
    default:
      break;
  }
  return [...new Set(candidates.filter(isUnderRoutines))];
}

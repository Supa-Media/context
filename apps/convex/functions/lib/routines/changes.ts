/** Which successful console operations touched a routine root, and where. */

import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { TEX_FOLDER } from "@context/shared/src/folderRoles.cjs";
import { asTexPath, isUnderRoutines } from "./model";

/**
 * The paths under a routine root (`routines/`, `tex/routines/`, or the `tex`
 * folder that holds one) an operation changed, either side of a move,
 * or an empty list. A false positive costs one scan of a small folder; a
 * false negative leaves a routine on its old schedule until the six-hourly
 * sweep, so the moved shapes are read off the result as well as the request.
 */
export function routinePathsTouched(operation: FileOperation, result: OperationResult, texPath: string | null = null): string[] {
  const candidates = pathsTouched(operation, result).flatMap((path) => {
    // A folder above Tex's folder moved or trashed takes Tex's routines with it.
    const holdsTex = typeof texPath === "string" && texPath !== "" && texPath !== TEX_FOLDER && texPath.startsWith(`${path}/`);
    return holdsTex ? [TEX_FOLDER] : [asTexPath(path, texPath)];
  });
  return [...new Set(candidates.filter(isUnderRoutines))];
}

/**
 * Whether the operation moves or removes something, so a folder that holds a
 * routine root (or Tex's folder) may have left. The caller reads where Tex's
 * folder is before the operation runs, because a trashed one is no longer
 * anywhere afterwards.
 */
export function mayRelocateRoutines(operation: FileOperation): boolean {
  switch (operation.kind) {
    case "move":
    case "trash":
    case "delete":
    case "archive":
    case "restoreTrash":
      return true;
    default:
      return false;
  }
}

/**
 * Whether the operation touched a path with a `routines` folder below the
 * top: a routine in a Tex folder nested somewhere else, so the caller should
 * ask where Tex's folder is and call `routinePathsTouched` with it. Cheap and
 * loose: a false positive costs one read.
 */
export function mayTouchNestedRoutines(operation: FileOperation, result: OperationResult): boolean {
  return pathsTouched(operation, result).some((path) => path.toLowerCase().split("/").slice(1).includes("routines"));
}

function pathsTouched(operation: FileOperation, result: OperationResult): string[] {
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
  return candidates;
}

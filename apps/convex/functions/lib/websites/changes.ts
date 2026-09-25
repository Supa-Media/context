/** Which successful bucket operations can change website route ownership. */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import type {
  FileOperation,
  OperationResult,
} from "../filesFns/operationTypes";

function isWebsitePath(path: string): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  return (
    normalized === DEFAULT_WEBSITE_ROOT ||
    normalized.startsWith(`${DEFAULT_WEBSITE_ROOT}/`)
  );
}

/**
 * True only after an operation has succeeded. False positives cost a rebuild;
 * false negatives can leave a new collision or audience change briefly live.
 */
export function operationTouchesWebsite(
  operation: FileOperation,
  result: OperationResult,
): boolean {
  if (result.kind === "moved") {
    return isWebsitePath(result.from) || isWebsitePath(result.to);
  }
  switch (operation.kind) {
    case "write":
    case "removeEncryption":
    case "delete":
    case "pluginDelete":
      return isWebsitePath(operation.path);
    case "move":
    case "copy":
    case "pluginRename":
      return isWebsitePath(operation.from) || isWebsitePath(operation.to);
    case "restoreTrash":
      return isWebsitePath(operation.from) || isWebsitePath(operation.to);
    case "importVault":
      return operation.files.some((file) => isWebsitePath(file.path));
    case "clearVault":
      return !operation.countOnly;
    case "contextMoveImport":
      return (
        (operation.root !== undefined && isWebsitePath(operation.root)) ||
        operation.objects.some((object) => isWebsitePath(object.destination))
      );
    case "contextMoveDelete":
      return operation.sources.some((source) => isWebsitePath(source.path));
    case "contextMoveFinish":
      return isWebsitePath(operation.from);
    case "archive":
    case "trash":
    case "duplicate":
      // Their destinations are result-driven and handled by `moved` above.
      return isWebsitePath(operation.path);
    case "form":
      // The response note is named inside the form block and is not repeated
      // in the operation shape. Rebuilding is the safe bounded answer.
      return true;
    default:
      return false;
  }
}

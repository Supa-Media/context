/** Which successful bucket operations can change website route ownership. */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { PRIVACY_KEY, foldPath } from "../privacy";
import { websiteTextRestricts } from "../../../../mcp/src/tree/siteFlags.js";
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
      // `privacy.md` decides what a website may publish, so an edit to it is
      // an edit to every page.
      return (
        isWebsitePath(operation.path) ||
        foldPath(operation.path.replace(/^\/+/, "")) === PRIVACY_KEY
      );
    case "setVisibility":
    case "setNoteGroup":
    case "setFolderVisibility":
    case "setFolderGroup":
      return isWebsitePath(operation.path);
    case "resetPrivacy":
    case "ensurePrivacy":
      return true;
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

/**
 * The paths of a successful operation that may narrow a site from outside
 * `website/`: a privacy change, a move or a delete there can take away a note
 * a page publishes through `folder:`. Path arithmetic cannot say whether one
 * does, so the control plane asks its route index (`./routeChangeAt.ts`).
 * Empty for everything else, and for an operation `operationTouchesWebsite`
 * already answers.
 */
export function websiteNarrowingPaths(
  operation: FileOperation,
  result: OperationResult,
): string[] {
  if (operationTouchesWebsite(operation, result)) return [];
  if (result.kind === "moved") return [result.from, result.to];
  switch (operation.kind) {
    case "setVisibility":
    case "setNoteGroup":
    case "setFolderVisibility":
    case "setFolderGroup":
    case "delete":
    case "pluginDelete":
    case "archive":
    case "trash":
      return [operation.path];
    case "move":
    case "pluginRename":
      return [operation.from, operation.to];
    case "contextMoveDelete":
      return operation.sources.map((source) => source.path);
    case "contextMoveFinish":
      return [operation.from];
    default:
      return [];
  }
}

/**
 * Whether these bytes ask for anything narrower than "serve this to anyone":
 * the gateway's check, the same one the tree's facts carry as `site.restricts`
 * (`apps/mcp/src/tree/siteFlags.js`), so a live read and the facts agree.
 */
export { websiteTextRestricts };

function textExplicitlyRestricts(path: string, text: string): boolean {
  return isWebsitePath(path) && websiteTextRestricts(text);
}

/** Whether a successful operation may have explicitly narrowed a live route. */
export function operationMayRestrictWebsite(
  operation: FileOperation,
  result: OperationResult,
): boolean {
  if (!operationTouchesWebsite(operation, result)) return false;
  if (operation.kind === "write" || operation.kind === "removeEncryption") {
    if (!isWebsitePath(operation.path)) return true; // `privacy.md` itself
    return textExplicitlyRestricts(operation.path, operation.text);
  }
  if (operation.kind === "importVault") {
    return operation.files.some(
      (file) =>
        isWebsitePath(file.path) &&
        textExplicitlyRestricts(
          file.path,
          new TextDecoder().decode(new Uint8Array(file.bytes)),
        ),
    );
  }
  // A form response does not rewrite the page that contains the form. Its
  // conservative rebuild is not evidence that any public route narrowed.
  if (operation.kind === "form") return false;
  return true;
}

/** Which successful bucket operations can change website route ownership. */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { PRIVACY_KEY, foldPath } from "../privacy";
import { websiteTextRestricts } from "../../../../mcp/src/tree/siteFlags.js";
import type {
  FileOperation,
  OperationResult,
} from "../filesFns/operationTypes";

/**
 * Under the website's folder: `root` is where it is now (`./siteRoot.ts`), and
 * its default name counts too, as a write by that name lands in the folder.
 */
function isUnder(path: string, root: string): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  return [DEFAULT_WEBSITE_ROOT, root].some(
    (folder) => normalized === folder || normalized.startsWith(`${folder}/`),
  );
}

/**
 * True only after an operation has succeeded. False positives cost a rebuild;
 * false negatives can leave a new collision or audience change briefly live.
 */
export function operationTouchesWebsite(
  operation: FileOperation,
  result: OperationResult,
  root: string = DEFAULT_WEBSITE_ROOT,
): boolean {
  return touches(operation, result, (path) => isUnder(path, root));
}

/**
 * Whether a successful operation changed anything at all that a website
 * folder could hold: `operationTouchesWebsite` with every path counted. A
 * read, and everything else that changes no note, is false.
 */
export function operationNamesPaths(operation: FileOperation, result: OperationResult): boolean {
  return touches(operation, result, () => true);
}

function touches(
  operation: FileOperation,
  result: OperationResult,
  isWebsitePath: (path: string) => boolean,
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
  root: string = DEFAULT_WEBSITE_ROOT,
): string[] {
  if (operationTouchesWebsite(operation, result, root)) return [];
  if (result.kind === "moved") return [result.from, result.to];
  switch (operation.kind) {
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

function textExplicitlyRestricts(path: string, text: string, root: string): boolean {
  return isUnder(path, root) && websiteTextRestricts(text);
}

/** Whether a successful operation may have explicitly narrowed a live route. */
export function operationMayRestrictWebsite(
  operation: FileOperation,
  result: OperationResult,
  root: string = DEFAULT_WEBSITE_ROOT,
): boolean {
  if (!operationTouchesWebsite(operation, result, root)) return false;
  const isWebsitePath = (path: string) => isUnder(path, root);
  if (operation.kind === "write" || operation.kind === "removeEncryption") {
    if (!isWebsitePath(operation.path)) return true; // `privacy.md` itself
    return textExplicitlyRestricts(operation.path, operation.text, root);
  }
  if (operation.kind === "importVault") {
    return operation.files.some(
      (file) =>
        isWebsitePath(file.path) &&
        textExplicitlyRestricts(
          file.path,
          new TextDecoder().decode(new Uint8Array(file.bytes)),
          root,
        ),
    );
  }
  // A form response does not rewrite the page that contains the form. Its
  // conservative rebuild is not evidence that any public route narrowed.
  if (operation.kind === "form") return false;
  return true;
}

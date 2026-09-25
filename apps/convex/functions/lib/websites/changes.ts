/** Which successful bucket operations can change website route ownership. */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { isEncryptedNote } from "../noteEncryption";
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

/**
 * Whether these bytes ask for anything narrower than "serve this to anyone".
 *
 * Read the two controls that mean "stop publishing this" — `audience` and
 * `draft` — rather than the composed route status, because the status cannot
 * carry them: any other flaw in the page (a missing title, an emptied body, a
 * route clash) makes the status `problem`, and `problem` outranks both. Taking
 * a page private and clearing it to rewrite it is one save, and that save is
 * exactly a restriction the status hides. The last good release is a public
 * copy of the very page being restricted, so this must not miss one.
 *
 * Scan the frontmatter the parser would have read, whether or not it is
 * closed: a half-typed `audience:` lives in an unclosed block. Only `public`
 * and `false` are permissive, and only exactly — a value the parser rejects is
 * an instruction we failed to read, never consent to keep serving.
 */
export function websiteTextRestricts(text: string): boolean {
  if (isEncryptedNote(text)) return true;
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return false;
  const lines = normalized.split("\n");
  const closing = lines.indexOf("---", 1);
  return lines.slice(1, closing < 0 ? undefined : closing).some((line) => {
    const match = /^\s*(audience|draft)\b[ \t]*:?[ \t]*(.*)$/.exec(line);
    if (match === null) return false;
    const value = (match[2] ?? "").trim();
    return match[1] === "audience" ? value !== "public" : value !== "false";
  });
}

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

/**
 * File operations against a customer's bucket.
 *
 * Everything the console's editor can do — list, read, write, create, move,
 * duplicate, copy, archive, delete, change visibility — expressed against a
 * `ContextStore` and nothing else. No Convex, no credential, no database.
 *
 * ## Why that separation is the point
 *
 * The credential is opened in exactly one place (`functions/files.ts`'s
 * `runFileOperation`), and this module is what it hands the resulting store to.
 * So every rule below — who may see what, what a stale etag does, whether a
 * delete is recoverable — is testable against an in-memory bucket with no
 * decryption, no auth, and no fixtures, and the security-critical module above
 * stays small enough to read in one sitting.
 *
 * ## The three rules that are not negotiable
 *
 *  1. **Note content passes through; it is never persisted here or above.**
 *     Nothing in this file writes to a database, and no error it throws
 *     interpolates a note body. Paths are metadata and may appear; content may
 *     not. `__tests__/fileContent.test.ts` asserts this behaviourally over
 *     every operation.
 *
 *  2. **A caller who may not see a note gets the same answer as for a note
 *     that does not exist.** `FILE_NOT_FOUND`, identical payload, identical
 *     wording. Anything else is an existence oracle: a team-scoped colleague
 *     could enumerate the names of your private notes by watching which paths
 *     answer "forbidden" instead of "missing".
 *
 *  3. **`privacy.md` is generated, never typed into.** It is the access map,
 *     and hand-editing it through a UI that also *writes* it is how a person
 *     loses every rule they had. `setVisibility` / `setFolderVisibility` are
 *     the only way to change a rule, and a write to that key through
 *     `writeFile` is refused.
 *
 *     `resetPrivacyManifest` is the one other function that puts to that key,
 *     and it is not an exception to the rule so much as the floor beneath it:
 *     it takes no content, replaces only a manifest that does not parse, and
 *     writes every folder `private`. There is no argument to it by which a note
 *     could change hands.
 *
 * ## Where the code lives
 *
 * This file is the module's public face and nothing else: every operation
 * lives in `lib/fileOps/<subject>.ts` and is re-exported here under the
 * name it always had, so callers and tests import from `lib/fileOps` as
 * before. The rules above hold across all of them.
 */

export { MAX_NOTE_BYTES, FOLDER_OPERATION_CAP } from "./fileOps/store";
export type { FileStore } from "./fileOps/store";
export {
  VAULT_CLEAR_BATCH_OBJECTS,
  clearVaultBatch,
  MAX_VAULT_IMPORT_FILE_BYTES,
  importVaultFiles,
} from "./fileOps/vaultImport";
export type { VaultImportFile, VaultImportResult } from "./fileOps/vaultImport";
export { FileOpError } from "./fileOps/errors";
export type { FileErrorCode } from "./fileOps/errors";
export {
  normalizePath,
  parentOf,
  baseName,
  joinPath,
  timestampSlug,
} from "./fileOps/paths";
export { loadPrivacyState } from "./fileOps/privacyState";
export type { PrivacyState } from "./fileOps/privacyState";
export { listFolder } from "./fileOps/listing";
export type { FileEntry, FolderListing } from "./fileOps/listing";
export {
  MANIFEST_PAGE_ENTRIES,
  MANIFEST_PAGE_FOLDERS,
  syncManifest,
} from "./fileOps/syncManifest";
export type {
  ManifestEntry,
  ManifestFolder,
  SyncManifest,
} from "./fileOps/syncManifest";
export {
  readFile,
  READ_BATCH_PATHS,
  READ_BATCH_BYTES,
  readFiles,
} from "./fileOps/reading";
export type { FileContents, BatchRead } from "./fileOps/reading";
export { writeFile, removeNoteEncryption } from "./fileOps/writing";
export type { WriteResult } from "./fileOps/writing";
export {
  renderFolderPlaceholder,
  createFolder,
  duplicateName,
} from "./fileOps/folders";
export { movePath } from "./fileOps/moving";
export type { MoveResult } from "./fileOps/moving";
export {
  CONTEXT_MOVE_BATCH_OBJECTS,
  CONTEXT_MOVE_BATCH_BYTES,
  CONTEXT_MOVE_SKIP_CAP,
  landingVisibility,
  FOLDER_PATH_CAP,
  listFolderPaths,
  exportContextMoveBatch,
} from "./fileOps/contextMoveExport";
export type {
  ContextMoveObject,
  ContextMoveSkip,
  ContextMoveExport,
} from "./fileOps/contextMoveExport";
export {
  importContextMoveBatch,
  deleteMovedSources,
  clearMovedSourceRules,
} from "./fileOps/contextMoveImport";
export type { ContextMoveImport } from "./fileOps/contextMoveImport";
export type { ReferenceRewrite } from "./fileOps/references";
export { copyPath, duplicatePath } from "./fileOps/copying";
export {
  archivePath,
  trashPath,
  restoreTrashedPath,
  DELETE_CONFIRMATION,
  deletePath,
} from "./fileOps/deleting";
export type { DeleteResult } from "./fileOps/deleting";
export { resetPrivacyManifest } from "./fileOps/privacyReset";
export type { PrivacyResetResult } from "./fileOps/privacyReset";
export {
  setExactVisibility,
  setVisibility,
  setFolderVisibility,
} from "./fileOps/visibility";
export type { VisibilityResult } from "./fileOps/visibility";
export {
  MAX_STORED_IMAGE_BYTES,
  IMAGE_PREFIX,
  STORABLE_IMAGE_EXTENSIONS,
  writeImage,
  readImage,
  pasteImageLeaf,
  workspaceIconLeaf,
} from "./fileOps/images";
export {
  notePathIndex,
  searchNotes,
  maintainSearchIndex,
} from "./fileOps/search";
export type {
  SearchHit,
  SearchResults,
  ProjectionClient,
} from "./fileOps/search";
export { projectSearchIndex } from "./fileOps/projection";
export type { ProjectionPass } from "./fileOps/projection";

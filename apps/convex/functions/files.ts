/**
 * The file editor's data path.
 *
 * This is what lets a person actually *edit their context* from the console —
 * create, rename, move, duplicate, copy, archive, delete, and change what a
 * note is visible to — instead of opening Obsidian to do it.
 *
 * ## Where the bytes live, and where they do not
 *
 * Note content lives in the customer's bucket and nowhere else. It travels
 * through an action and is returned to the caller; it is **never** written to
 * a table, an audit `details` field, a log line, or an error message. That is
 * CLAUDE.md non-negotiable #1, and `__tests__/fileContent.test.ts` asserts it
 * behaviourally across every operation rather than trusting this paragraph.
 *
 * What *is* recorded is the audit trail: which identity did what, to which
 * paths. Paths are metadata. Content is not.
 *
 * ## The credential barrier
 *
 * There is exactly one new function in this codebase that can obtain a
 * decrypted bucket credential: `runFileOperation`. It is an `internalAction`,
 * so no client can reach it. It opens the credential, builds one `S3Store`,
 * hands that store to `lib/fileOps.ts`, and returns a **result** — a listing, a
 * note, an etag. It never returns the credential, never puts it in an error,
 * and never stores it.
 *
 * The public actions below call it. That is a real change to the property
 * `__tests__/structure.test.ts` enforces — previously *no* public function
 * could transitively reach the decrypt path at all — and it is made
 * deliberately, with the guard strengthened rather than loosened around it:
 *
 *  - the set of "barrier" functions is enumerated and pinned in that test, so
 *    adding a second one is a visible, reviewed change, not an accident;
 *  - a public function may reach the decrypt path **only** through a barrier.
 *    Calling `getBindingForGateway` directly is still a hard failure, which is
 *    exactly the attack that test was written around;
 *  - the analyzer now also treats a module-level `internal.…` reference as
 *    tainting the whole module, closing the "hide the call in a helper above
 *    the first export" hole that would otherwise make the barrier optional.
 *
 * Read the block comment in `structure.test.ts` before adding a barrier.
 *
 * ## Authorization
 *
 * Every operation resolves the caller's membership through the same
 * `requireWorkspaceAccess` / `requireWorkspaceRole` the rest of the control
 * plane uses. Reading needs `member`; writing needs `editor` or `owner`. A
 * non-member gets `WORKSPACE_NOT_FOUND` — the same error as for a workspace
 * that never existed.
 *
 * ## Visibility
 *
 * The caller's *scope* comes from their role, and it is deliberately strict:
 *
 *   owner  → `private` scope — sees everything, including private notes
 *   editor → `team` scope
 *   member → `team` scope
 *
 * `private` means "only you" (CLAUDE.md #5). Anyone who is in your workspace
 * because you put them there is, by definition, "named people you granted
 * access to" — which is `team`. Being able to *write* is a separate grant from
 * being able to see what you marked private, and conflating them is how an
 * editor invited to help with one project ends up reading a private folder.
 *
 * This is a product decision as much as a technical one; it is called out in
 * the build report.
 */

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  DELETE_CONFIRMATION,
} from "./lib/fileOps";
import {
  type ActivityEntry,
} from "./lib/activity";
import {
  activityEntryValidator,
  deletedValidator,
  durableMoveValidator,
  fileValidator,
  folderCreatedValidator,
  folderPathsValidator,
  listingValidator,
  manifestValidator,
  movedValidator,
  notesValidator,
  privacyResetValidator,
  storageMigrationResultValidator,
  vaultImportJobStatusValidator,
  vaultImportResultValidator,
  visibilityResultValidator,
  visibilityValidator,
  writtenValidator,
} from "./lib/filesFns/validators";
import {
  pluginInventoryValidator,
  pluginManagedInstallsValidator,
} from "./lib/filesFns/pluginValidators";
import {
  blendedResultsValidator,
  notePathsValidator,
  searchResultsValidator,
} from "./lib/filesFns/searchValidators";
import { operationResultValidator, operationValidator } from "./lib/filesFns/operationValidators";
import {
  type OperationResult,
} from "./lib/filesFns/operationTypes";
import { resolveFileAccess } from "./lib/filesFns/access";
import {
  type BlendedAnswer,
} from "./lib/filesFns/searchDeadline";
import {
  type VaultImportJobStatus,
} from "./lib/filesFns/vaultImportPlan";
import {
  latestVaultImportJobHandler,
  pauseVaultImportHandler,
  recordVaultClearBatchHandler,
  recordVaultImportBatchHandler,
  startVaultImportHandler,
} from "./lib/filesFns/vaultImportJobs";
import { listDurableMovesHandler } from "./lib/filesFns/durableMoves";
import { namedAudienceHandler } from "./lib/filesFns/namedAudience";
import {
  activityLastSeenHandler,
  markActivitySeenHandler,
  markWorkspaceActivityHandler,
} from "./lib/filesFns/activityMarks";
import {
  archiveEntryHandler,
  copyEntryHandler,
  createDirectoryHandler,
  deleteEntryHandler,
  duplicateEntryHandler,
  moveEntryHandler,
  restoreTrashEntryHandler,
  trashEntryHandler,
} from "./lib/filesFns/entries";
import {
  resetPrivacyHandler,
  setDirectoryVisibilityHandler,
  setFolderGroupHandler,
  setNoteGroupHandler,
  setNoteVisibilityHandler,
} from "./lib/filesFns/visibility";
import {
  readNoteImageHandler,
  setWorkspaceIconPhotoHandler,
  storeNoteImageHandler,
  workspaceIconPhotoHandler,
} from "./lib/filesFns/images";
import {
  listActivityHandler,
  listFilesHandler,
  readNoteHandler,
  readNotesHandler,
  syncManifestHandler,
} from "./lib/filesFns/noteReads";
import {
  listManagedPluginsHandler,
  listObsidianPluginsHandler,
} from "./lib/filesFns/pluginReads";
import {
  removeNoteEncryptionHandler,
  writeNoteHandler,
} from "./lib/filesFns/noteWrites";
import {
  clearVaultImportBatchHandler,
  importVaultBatchHandler,
  importVaultJobBatchHandler,
} from "./lib/filesFns/vaultImportBatches";
import {
  runStorageLayoutMigrationHandler,
  updateStorageLayoutHandler,
} from "./lib/filesFns/storageLayout";
import {
  folderPathsHandler,
  notePathsHandler,
  searchContextHandler,
  searchContextsHandler,
} from "./lib/filesFns/search";
import {
  runFileOperationHandler,
} from "./lib/filesFns/fileOperationBarrier";
export { scopeForRole, resolveFileAccess, callerId } from "./lib/filesFns/access";
export { executeOperation } from "./lib/filesFns/executeOperation";

export { DELETE_CONFIRMATION };

/* -------------------------------------------------------------------------- */
/*                               authorization                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve membership and clearance.
 *
 * INTERNAL. `actorUserId` is supplied by the calling public action, which read
 * it from the session — the same arrangement `storage.applyBinding` uses, and
 * safe for the same reason: an internal function is unreachable from any
 * client, so there is nobody who could pass a forged one.
 *
 * ## Where the pinned context gets in, and why it is only here
 *
 * `@context-lc` is readable by every account without a membership row
 * (`lib/pinnedContext.ts`). This function is the one door into the bucket for
 * the console, so it is the one place that needs to know — and the whole of the
 * grant is the `minimum === "member"` branch below.
 *
 * **The `minimum` is what makes this safe, and it is worth being explicit about
 * why.** Every caller states the least role its operation needs, and the ones
 * that ask for `member` are exactly the reads: `listFiles`, `readNote`,
 * `syncManifest`, `readNotes`, `searchContext`, `folderPaths`, `notePaths`,
 * and the per-context leg of `searchContexts`.
 * Everything that changes a byte asks for `editor` or `owner` and therefore
 * goes to `requireWorkspaceRole`, which knows nothing about the pin and throws
 * `WORKSPACE_NOT_FOUND` for somebody with no row — so a pinned reader is
 * refused a write here by the same code that refuses a stranger, rather than by
 * a second check that could be forgotten.
 *
 * The scope is `team`, from `scopeForRole("member")` like any other member, so
 * the pin cannot surface a note held private in that workspace.
 *
 * **What this does not open.** `requireWorkspaceAccess` itself is untouched, so
 * the member list, audit, billing, the storage binding, grants, shares, groups
 * and invitations all still refuse a pinned reader. Blended search is untouched
 * too: `searchContexts` only ever authorizes contexts `searchableContextsFor`
 * already returned, and that is driven off real memberships, so the pinned
 * context is not swept into everybody's cross-context search — which would have
 * pointed every account's search at one bucket.
 */
export const authorizeFileAccess = internalQuery({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    minimum: v.union(v.literal("member"), v.literal("editor"), v.literal("owner")),
  },
  returns: v.object({
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    scope: v.union(v.literal("private"), v.literal("team")),
    /**
     * The `@name` rules this caller reaches, from live membership.
     *
     * Beside `scope` rather than folded into it, because a name is not a tier:
     * `Scope` stays two-valued in both engines and in every grant, and a name
     * widens what a `team` caller may reach one rule at a time. See
     * `lib/clearance.ts`.
     */
    grantedNames: v.array(v.string()),
    /**
     * The caller's own `@name` — their personal workspace's slug — for the
     * line `activity.md` writes about what they did.
     *
     * Display text and nothing else: every authorization decision above reads
     * the membership row. `null` for an account with no personal context,
     * which is not a state the product produces but is one a self-hosted
     * deployment can, and a line reading "Someone revised" is better than one
     * naming an id.
     */
    actorName: v.union(v.string(), v.null()),
  }),
  handler: (ctx, args) => resolveFileAccess(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                            the credential barrier                          */
/* -------------------------------------------------------------------------- */

/**
 * THE CREDENTIAL BARRIER. Read the module comment before changing this.
 *
 * The only function added by the file editor that opens a bucket credential.
 * It builds one store, performs one operation, and returns a result that by
 * construction contains no credential: `operationResultValidator` has no field
 * that could hold one, and Convex enforces that validator on the way out.
 *
 * INTERNAL ACTION, so no client can call it. Its callers are the public
 * actions below, each of which has already established that the caller is a
 * member of this workspace with a sufficient role.
 */
export const runFileOperation = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    scope: v.union(v.literal("private"), v.literal("team")),
    /**
     * The `@name` rules this caller answers to, resolved by
     * `authorizeFileAccess` from live membership.
     *
     * Optional because a scheduled pass — a projection link, an index sweep —
     * re-enters this action with no caller at all, and the honest clearance
     * for nobody is no names. Every such pass runs `scope`-blind or at the
     * owner's `private`, so none of them loses anything by it.
     */
    grantedNames: v.optional(v.array(v.string())),
    /**
     * Who to name in `activity.md`, from `authorizeFileAccess`.
     *
     * Optional because a scheduled pass has no caller, and those record
     * nothing anyway — see `executeOperation`'s `actor` parameter.
     */
    actorName: v.optional(v.union(v.string(), v.null())),
    operation: operationValidator,
  },
  returns: operationResultValidator,
  // Annotated rather than inferred: this action calls another function in the
  // same deployment, which is the inference cycle `bindStorage` has.
  handler: async (ctx, args): Promise<OperationResult> => await runFileOperationHandler(ctx, args),
});

/** See `runStorageLayoutMigrationHandler` in `lib/filesFns/storageLayout.ts`. */
export const runStorageLayoutMigration = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
  },
  returns: storageMigrationResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> => await runStorageLayoutMigrationHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                              the public surface                            */
/* -------------------------------------------------------------------------- */

/** See `listDurableMovesHandler` in `lib/filesFns/durableMoves.ts`. */
export const listDurableMoves = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(durableMoveValidator),
  handler: async (ctx, args) => await listDurableMovesHandler(ctx, args),
});

/** One folder's contents. Any member may read. */
export const listFiles = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: listingValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "listing" }>> => await listFilesHandler(ctx, args),
});

/** See `listObsidianPluginsHandler` in `lib/filesFns/pluginReads.ts`. */
export const listObsidianPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginInventoryValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "pluginInventory" }>> => await listObsidianPluginsHandler(ctx, args),
});

/** See `listManagedPluginsHandler` in `lib/filesFns/pluginReads.ts`. */
export const listManagedPlugins = action({
  args: { workspaceId: v.id("workspaces") },
  returns: pluginManagedInstallsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "pluginManagedInstalls" }>> => await listManagedPluginsHandler(ctx, args),
});

/** One note's markdown. Any member may read what their scope can see. */
export const readNote = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: fileValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "file" }>> => await readNoteHandler(ctx, args),
});

/** See `syncManifestHandler` in `lib/filesFns/noteReads.ts`. */
export const syncManifest = action({
  args: { workspaceId: v.id("workspaces"), cursor: v.optional(v.string()) },
  returns: manifestValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "manifest" }>> => await syncManifestHandler(ctx, args),
});

/** See `readNotesHandler` in `lib/filesFns/noteReads.ts`. */
export const readNotes = action({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: notesValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "notes" }>> => await readNotesHandler(ctx, args),
});

/** See `searchContextHandler` in `lib/filesFns/search.ts`. */
export const searchContext = action({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    prefix: v.optional(v.string()),
  },
  returns: searchResultsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "searchResults" }>> => await searchContextHandler(ctx, args),
});

/** See `folderPathsHandler` in `lib/filesFns/search.ts`. */
export const folderPaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: folderPathsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "folderPaths" }>> => await folderPathsHandler(ctx, args),
});

/** See `notePathsHandler` in `lib/filesFns/search.ts`. */
export const notePaths = action({
  args: { workspaceId: v.id("workspaces") },
  returns: notePathsValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "notePaths" }>> => await notePathsHandler(ctx, args),
});

/** See `searchContextsHandler` in `lib/filesFns/search.ts`. */
export const searchContexts = action({
  args: {
    query: v.string(),
    /**
     * The scope, as workspace ids. Absent or empty means every context this
     * caller can search. An id this caller may not search is **dropped**, identically to
     * one that never existed — see `resolveScope`.
     */
    contexts: v.optional(v.array(v.id("workspaces"))),
    /** A cursor from a previous page of this same query, or nothing. */
    cursor: v.optional(v.string()),
  },
  returns: blendedResultsValidator,
  handler: async (ctx, args): Promise<BlendedAnswer> => await searchContextsHandler(ctx, args),
});

/** See `writeNoteHandler` in `lib/filesFns/noteWrites.ts`. */
export const writeNote = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "written" }>> => await writeNoteHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                    a pasted image, in and back out again                    */
/* -------------------------------------------------------------------------- */

/** See `storeNoteImageHandler` in `lib/filesFns/images.ts`. */
export const storeNoteImage = action({
  args: {
    workspaceId: v.id("workspaces"),
    bytes: v.bytes(),
    contentType: v.string(),
  },
  returns: v.object({ leaf: v.string() }),
  handler: async (ctx, args): Promise<{ leaf: string }> => await storeNoteImageHandler(ctx, args),
});

/** See `readNoteImageHandler` in `lib/filesFns/images.ts`. */
export const readNoteImage = action({
  args: {
    workspaceId: v.id("workspaces"),
    notePath: v.string(),
    leaf: v.string(),
  },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => await readNoteImageHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                      a workspace's icon, in and back out                    */
/* -------------------------------------------------------------------------- */

/** See `setWorkspaceIconPhotoHandler` in `lib/filesFns/images.ts`. */
export const setWorkspaceIconPhoto = action({
  args: {
    workspaceId: v.id("workspaces"),
    bytes: v.bytes(),
    contentType: v.string(),
  },
  returns: v.object({ leaf: v.string() }),
  handler: async (ctx, args): Promise<{ leaf: string }> => await setWorkspaceIconPhotoHandler(ctx, args),
});

/** See `workspaceIconPhotoHandler` in `lib/filesFns/images.ts`. */
export const workspaceIconPhoto = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => await workspaceIconPhotoHandler(ctx, args),
});

/** See `startVaultImportHandler` in `lib/filesFns/vaultImportJobs.ts`. */
export const startVaultImport = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    strategy: v.union(v.literal("merge"), v.literal("folder"), v.literal("replace")),
    confirmation: v.optional(v.string()),
    sourceFingerprint: v.string(),
    totalFiles: v.number(),
    totalBytes: v.number(),
    totalBatches: v.number(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => await startVaultImportHandler(ctx, args),
});

export const recordVaultClearBatch = internalMutation({
  args: {
    jobId: v.id("vaultImportJobs"),
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    sourceFingerprint: v.string(),
    mode: v.union(v.literal("counted"), v.literal("deleted")),
    objects: v.number(),
    complete: v.boolean(),
  },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await recordVaultClearBatchHandler(ctx, args),
});

/** Count, then remove, one retryable page of every object in a replacement bucket. */
export const clearVaultImportBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => await clearVaultImportBatchHandler(ctx, args),
});

/** The latest unfinished import for this owner and workspace, without paths or content. */
export const latestVaultImportJob = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await latestVaultImportJobHandler(ctx, args),
});

/** Record the local uploader stopping while keeping every completed batch resumable. */
export const pauseVaultImport = mutation({
  args: { workspaceId: v.id("workspaces"), jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await pauseVaultImportHandler(ctx, args),
});

export const vaultImportJobForBatch = internalQuery({
  args: { jobId: v.id("vaultImportJobs") },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, args): Promise<Doc<"vaultImportJobs"> | null> => await ctx.db.get(args.jobId),
});

export const recordVaultImportBatch = internalMutation({
  args: {
    jobId: v.id("vaultImportJobs"),
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    filesProcessed: v.number(),
    filesCreated: v.number(),
    filesSkipped: v.number(),
  },
  returns: v.union(v.null(), vaultImportJobStatusValidator),
  handler: async (ctx, args): Promise<VaultImportJobStatus | null> => await recordVaultImportBatchHandler(ctx, args),
});

/** See `importVaultJobBatchHandler` in `lib/filesFns/vaultImportBatches.ts`. */
export const importVaultJobBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    jobId: v.id("vaultImportJobs"),
    sourceFingerprint: v.string(),
    batchIndex: v.number(),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportJobStatusValidator,
  handler: async (ctx, args): Promise<VaultImportJobStatus> => await importVaultJobBatchHandler(ctx, args),
});

/** See `importVaultBatchHandler` in `lib/filesFns/vaultImportBatches.ts`. */
export const importVaultBatch = action({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(v.object({ path: v.string(), bytes: v.bytes(), contentType: v.string() })),
  },
  returns: vaultImportResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "vaultImported" }>> => await importVaultBatchHandler(ctx, args),
});

/** See `removeNoteEncryptionHandler` in `lib/filesFns/noteWrites.ts`. */
export const removeNoteEncryption = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "written" }>> => await removeNoteEncryptionHandler(ctx, args),
});

/** Create a folder. Requires `editor`. */
export const createDirectory = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: folderCreatedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "folderCreated" }>> => await createDirectoryHandler(ctx, args),
});

/** Move or rename a file or folder. Requires `editor`. */
export const moveEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.string(),
    to: v.string(),
    /**
     * The version of the note this move was asked about. The offline queue
     * sends it, so a rename typed on a train is refused with `CONFLICT` if the
     * note changed meanwhile rather than carrying somebody's newer text under
     * a name chosen for something else. See `movePath`.
     */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await moveEntryHandler(ctx, args),
});

/** Paste a copy at an explicit destination. Requires `editor`. */
export const copyEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await copyEntryHandler(ctx, args),
});

/** Copy beside itself under a free "… copy" name. Requires `editor`. */
export const duplicateEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await duplicateEntryHandler(ctx, args),
});

/** See `archiveEntryHandler` in `lib/filesFns/entries.ts`. */
export const archiveEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The version this archive was asked about. See `moveEntry`. */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await archiveEntryHandler(ctx, args),
});

/** Move an entry into hidden, recoverable trash. Requires `editor`. */
export const trashEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The version this delete was asked about. See `moveEntry`. */
    expectedEtag: v.optional(v.string()),
  },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await trashEntryHandler(ctx, args),
});

/** Restore the exact entry returned by `trashEntry`. Requires `editor`. */
export const restoreTrashEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "moved" }>> => await restoreTrashEntryHandler(ctx, args),
});

/** See `deleteEntryHandler` in `lib/filesFns/entries.ts`. */
export const deleteEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    confirmation: v.string(),
  },
  returns: deletedValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "deleted" }>> => await deleteEntryHandler(ctx, args),
});

/** See `setNoteVisibilityHandler` in `lib/filesFns/visibility.ts`. */
export const setNoteVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setNoteVisibilityHandler(ctx, args),
});

/** See `setNoteGroupHandler` in `lib/filesFns/visibility.ts`. */
export const setNoteGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The group's full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setNoteGroupHandler(ctx, args),
});

/** See `namedAudienceHandler` in `lib/filesFns/namedAudience.ts`. */
export const namedAudience = internalQuery({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => await namedAudienceHandler(ctx, args),
});

/** See `setFolderGroupHandler` in `lib/filesFns/visibility.ts`. */
export const setFolderGroup = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    /** The full name, with or without its leading `@`. */
    group: v.string(),
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setFolderGroupHandler(ctx, args),
});

/** See `setDirectoryVisibilityHandler` in `lib/filesFns/visibility.ts`. */
export const setDirectoryVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "visibility" }>> => await setDirectoryVisibilityHandler(ctx, args),
});

/** See `resetPrivacyHandler` in `lib/filesFns/visibility.ts`. */
export const resetPrivacy = action({
  args: { workspaceId: v.id("workspaces") },
  returns: privacyResetValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "privacyReset" }>> => await resetPrivacyHandler(ctx, args),
});

/** See `updateStorageLayoutHandler` in `lib/filesFns/storageLayout.ts`. */
export const updateStorageLayout = action({
  args: { workspaceId: v.id("workspaces") },
  returns: storageMigrationResultValidator,
  handler: async (ctx, args): Promise<Extract<OperationResult, { kind: "storageMigrated" }>> => await updateStorageLayoutHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                                  activity                                  */
/* -------------------------------------------------------------------------- */

/**
 * `activity.md`, read and marked as read.
 *
 * Here rather than in a `functions/activity.ts` of its own, for a reason worth
 * writing down because it will come up again: the generated `api` type is at
 * TypeScript's instantiation limit, and adding one more top-level function
 * module pushes every inference in the repository's tests over it — 8
 * pre-existing `implicitly any` errors become 151, none of them near the
 * change. The feature is a view over a file, this is the file surface, and a
 * section is cheaper than the alternative.
 *
 * The writing half is `lib/activity.ts`, called from `executeOperation`.
 */
/** See `markWorkspaceActivityHandler` in `lib/filesFns/activityMarks.ts`. */
export const markWorkspaceActivity = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    at: v.number(),
    /**
     * Whether the line that landed was written at `team` tier.
     *
     * Only a `team` line moves `activityTeamAt`, which is the stamp every
     * member who is not the owner is served. Absent is the safe reading —
     * private — so an older caller can only ever under-report.
     */
    teamVisible: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => await markWorkspaceActivityHandler(ctx, args),
});

/** See `activityLastSeenHandler` in `lib/filesFns/activityMarks.ts`. */
export const activityLastSeen = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => await activityLastSeenHandler(ctx, args),
});

/** See `markActivitySeenHandler` in `lib/filesFns/activityMarks.ts`. */
export const markActivitySeen = mutation({
  args: { workspaceId: v.id("workspaces"), at: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => await markActivitySeenHandler(ctx, args),
});

/** See `listActivityHandler` in `lib/filesFns/noteReads.ts`. */
export const listActivity = action({
  args: { workspaceId: v.id("workspaces"), limit: v.optional(v.number()) },
  returns: v.array(activityEntryValidator),
  // Annotated rather than inferred, for the reason `runFileOperation` gives:
  // this action calls another function in the same deployment, and leaving the
  // return to inference makes the generated `api` type recurse through itself.
  // Unannotated, it costs 143 `implicitly any` errors across tests that have
  // nothing to do with it — the whole repository's inference, not this file's.
  handler: async (ctx, args): Promise<ActivityEntry[]> => await listActivityHandler(ctx, args),
});

/**
 * What `runFileOperation` accepts and returns: the operation union and the
 * result union.
 *
 * Split out of `functions/files.ts`, which registers the barrier that uses
 * them; that file's header holds the rules they keep.
 */

import { v } from "convex/values";
import {
  activityValidator,
  contextMoveExportedValidator,
  contextMoveFinishedValidator,
  contextMoveLandedValidator,
  contextMoveRemovedValidator,
  deletedValidator,
  fileValidator,
  folderCreatedValidator,
  folderPathsValidator,
  imageValidator,
  imageWrittenValidator,
  emojiImageValidator,
  emojiListValidator,
  emojiRemovedValidator,
  emojiStoredValidator,
  listingValidator,
  manifestValidator,
  movedValidator,
  notesValidator,
  privacyResetValidator,
  storageLayoutReadValidator,
  storageMigrationResultValidator,
  vaultClearResultValidator,
  vaultImportResultValidator,
  visibilityResultValidator,
  visibilityValidator,
  writtenValidator,
} from "./validators";
import {
  contextPluginsValidator,
  pluginBundleValidator,
  pluginInventoryValidator,
  pluginManagedInstallsValidator,
  pluginManagedValidator,
  pluginSettingsValidator,
} from "./pluginValidators";
import {
  formAnswerValidator,
  formNotifyReadValidator,
  formResultValidator,
  googleForwardSyncValidator,
  googleSyncRunValidator,
} from "./syncAndFormValidators";
import {
  forwardedValidator,
  indexMaintainedValidator,
  indexProjectedValidator,
  notePathsValidator,
  searchResultsValidator,
} from "./searchValidators";

export const operationResultValidator = v.union(
  v.object({ kind: v.literal("websiteReleaseWritten"), pages: v.number() }),
  v.object({
    kind: v.literal("websiteReleasePages"),
    results: v.array(
      v.union(
        v.object({
          path: v.string(),
          outcome: v.literal("read"),
          text: v.string(),
        }),
        v.object({ path: v.string(), outcome: v.literal("missing") }),
      ),
    ),
  }),
  v.object({ kind: v.literal("websiteReleaseDeleted"), objects: v.number() }),
  v.object({ kind: v.literal("organizerResult"), output: v.string() }),
  listingValidator,
  fileValidator,
  manifestValidator,
  notesValidator,
  writtenValidator,
  movedValidator,
  deletedValidator,
  folderPathsValidator,
  contextMoveExportedValidator,
  contextMoveLandedValidator,
  contextMoveRemovedValidator,
  contextMoveFinishedValidator,
  visibilityResultValidator,
  folderCreatedValidator,
  privacyResetValidator,
  storageMigrationResultValidator,
  storageLayoutReadValidator,
  imageWrittenValidator,
  imageValidator,
  emojiListValidator,
  emojiImageValidator,
  emojiStoredValidator,
  emojiRemovedValidator,
  pluginInventoryValidator,
  pluginManagedInstallsValidator,
  contextPluginsValidator,
  pluginSettingsValidator,
  pluginManagedValidator,
  pluginBundleValidator,
  formNotifyReadValidator,
  vaultImportResultValidator,
  vaultClearResultValidator,
  searchResultsValidator,
  notePathsValidator,
  forwardedValidator,
  indexMaintainedValidator,
  indexProjectedValidator,
  googleSyncRunValidator,
  googleForwardSyncValidator,
  formResultValidator,
  activityValidator,
);

export const operationValidator = v.union(
  v.object({ kind: v.literal("list"), path: v.string() }),
  v.object({
    kind: v.literal("read"),
    path: v.string(),
    /**
     * Whether a path that has moved is followed to where it went.
     *
     * Absent is `never`, which is every caller that predates the forwarding
     * ledger. `onMiss` is for an address somebody is holding — a deep link, a
     * remembered path. A share needs the opposite order and resolves through
     * the `forward` operation instead; `readFile` carries the argument for why
     * those two orders cannot be one.
     */
    forward: v.optional(v.union(v.literal("never"), v.literal("onMiss"))),
  }),
  /**
   * Where these paths are now, according to the bucket's forwarding ledger.
   *
   * A read can forward itself (`forward`, above). A share cannot: its bound is
   * decided in `shares.ts` *before* any bucket access — `withinSharedFolder`
   * refuses a path outside the shared folder without spending a GET — and a
   * bound checked against a stale prefix while the read forwards to a live one
   * would be two different answers to the same question. So the share resolves
   * both paths first, in one operation, and everything after it works in live
   * paths.
   */
  v.object({ kind: v.literal("forward"), paths: v.array(v.string()) }),
  /** The offline mirror's manifest, one page of it. See `syncManifest`. */
  v.object({ kind: v.literal("manifest"), cursor: v.optional(v.string()) }),
  /** Several `read`s against one load of `privacy.md`. See `readFiles`. */
  v.object({ kind: v.literal("readMany"), paths: v.array(v.string()) }),
  v.object({
    kind: v.literal("writeWebsiteRelease"),
    releaseId: v.string(),
    pages: v.array(
      v.object({
        pageId: v.string(),
        path: v.string(),
        expectedEtag: v.string(),
      }),
    ),
  }),
  v.object({
    kind: v.literal("readWebsiteRelease"),
    pages: v.array(
      v.object({ releaseId: v.string(), pageId: v.string(), path: v.string() }),
    ),
  }),
  v.object({
    kind: v.literal("deleteWebsiteRelease"),
    releaseId: v.string(),
    pageIds: v.optional(v.array(v.string())),
  }),
  v.object({
    kind: v.literal("search"),
    query: v.string(),
    prefix: v.optional(v.string()),
    /**
     * How far down the ranked list this answer reads. Absent is ten, the
     * palette's depth; the search page's later pages ask for more. Clamped by
     * `pageDepth` below this, at `MAX_RESULTS` — the rank the ranker stops at.
     */
    limit: v.optional(v.number()),
    /**
     * Whether a miss may buy one bucket listing and ask again. Absent is true,
     * which is what a single-context search has always done. The fan-out sets
     * it false; `searchNotes` carries the arithmetic for why.
     */
    refreshOnMiss: v.optional(v.boolean()),
  }),
  /**
   * Every note path this scope may see, for the editor's link resolution.
   * See `notePathIndex` in `lib/fileOps.ts` and "L1" in
   * `docs/decisions/app-and-console.md`.
   */
  v.object({ kind: v.literal("notePaths") }),
  /**
   * Bring the search index a pass further. Scheduled, never called by a client
   * — there is no public action that reaches this variant.
   *
   * `passes` is how many *more* passes may be chained behind this one when it
   * makes progress and does not finish. A cold workspace needs several, and
   * requiring a person to search repeatedly to finish their own backfill is
   * the acceptance criterion this closes; the bound is what stops a bucket
   * that never converges from scheduling itself forever.
   */
  v.object({ kind: v.literal("maintainIndex"), passes: v.optional(v.number()) }),
  /**
   * Copy a pass's worth of this context's notes into its search database.
   * Scheduled, never called by a client — there is no public action that
   * reaches this variant either.
   *
   * `passes` is the same bound `maintainIndex` carries and the same backstop:
   * what actually ends the chain is a pass that moved nothing, a row that
   * stopped being `backfilling`, or a projection that reached `ready`.
   */
  v.object({ kind: v.literal("projectIndex"), passes: v.optional(v.number()) }),
  v.object({ kind: v.literal("googleGmailBackfill"), runId: v.id("googleSyncRuns") }),
  /**
   * Advance one connected Google account from its own cursor. Scheduled by
   * `googleSync.sweepDueGoogleSyncs` and by nothing else — there is no public
   * action that reaches this variant, and no argument on it a caller could use
   * to name a context: the workspace comes from the connection row.
   */
  v.object({ kind: v.literal("googleForwardSync"), connectionId: v.id("googleConnections") }),
  v.object({
    kind: v.literal("write"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("importVault"),
    files: v.array(v.object({
      path: v.string(),
      bytes: v.bytes(),
      contentType: v.string(),
    })),
  }),
  v.object({ kind: v.literal("clearVault"), countOnly: v.boolean() }),
  v.object({ kind: v.literal("ensurePrivacy") }),
  v.object({
    kind: v.literal("removeEncryption"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("createFolder"), path: v.string() }),
  /**
   * Bytes into the opaque store, and back out again.
   *
   * Deliberately not `write`/`read` with a flag. Those carry a path and consult
   * `privacy.md`; these carry a *leaf* and must not, because an object under
   * `.context/assets/images/` has no visibility of its own — it borrows the visibility of
   * whatever note references it. Sharing the variant would mean sharing the
   * question, and the manifest has no answer for a key it does not describe.
   */
  v.object({
    kind: v.literal("writeImage"),
    leaf: v.string(),
    bytes: v.bytes(),
    contentType: v.string(),
  }),
  v.object({ kind: v.literal("readImage"), leaf: v.string() }),
  v.object({ kind: v.literal("emojiList") }),
  v.object({ kind: v.literal("emojiRead"), name: v.string() }),
  v.object({
    kind: v.literal("emojiStore"),
    name: v.string(),
    bytes: v.bytes(),
    replace: v.boolean(),
  }),
  v.object({ kind: v.literal("emojiRemove"), name: v.string() }),
  v.object({ kind: v.literal("emojiRename"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("pluginInventory") }),
  v.object({ kind: v.literal("pluginManagedList") }),
  v.object({ kind: v.literal("contextPlugins") }),
  v.object({
    kind: v.literal("contextPluginSet"),
    pluginId: v.string(),
    enabled: v.boolean(),
  }),
  v.object({
    kind: v.literal("pluginManagedInstall"),
    pluginId: v.string(),
    version: v.string(),
    repository: v.string(),
    manifestJson: v.string(),
    mainJs: v.string(),
    stylesCss: v.union(v.string(), v.null()),
    lifecycleGeneration: v.number(),
  }),
  v.object({
    kind: v.literal("pluginManagedUninstall"),
    pluginId: v.string(),
    expectedVersion: v.string(),
    lifecycleGeneration: v.number(),
  }),
  v.object({
    kind: v.literal("pluginManagedFence"),
    pluginId: v.string(),
    lifecycleGeneration: v.number(),
  }),
  v.object({
    kind: v.literal("pluginBundleRead"),
    pluginId: v.string(),
    bundleFingerprint: v.string(),
  }),
  v.object({
    kind: v.literal("pluginRename"),
    from: v.string(),
    to: v.string(),
    expectedEtag: v.string(),
  }),
  v.object({ kind: v.literal("pluginDelete"), path: v.string(), expectedEtag: v.string() }),
  v.object({ kind: v.literal("pluginSettingsRead"), pluginId: v.string() }),
  v.object({
    kind: v.literal("pluginSettingsWrite"),
    pluginId: v.string(),
    json: v.string(),
    expectedEtag: v.union(v.string(), v.null()),
  }),
  /*
    `expectedEtag` on these three is the version a queued rename, move or
    delete was asked about — see `movePath`. Optional, and absent is the online
    press it always was.
  */
  v.object({
    kind: v.literal("move"),
    from: v.string(),
    to: v.string(),
    expectedEtag: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("copy"), from: v.string(), to: v.string() }),
  /*
    THE THREE HALVES OF A MOVE INTO ANOTHER CONTEXT.

    Three operations rather than one because they run against three different
    buckets' worth of credential — export and delete against the source, import
    against the destination — and `runFileOperation` opens exactly one. See the
    section header in `lib/fileOps.ts`: keeping them apart is what stops a
    cross-context move from needing a second credential barrier that holds two
    customers' plaintext secrets at once.
  */
  /**
   * Every folder this caller can see, for the "move into another context"
   * picker. Read-only, `member` and above, and its own operation rather than a
   * shape of `list` because it walks the whole bucket rather than one folder.
   */
  v.object({ kind: v.literal("folderPaths") }),
  v.object({
    kind: v.literal("contextMoveExport"),
    from: v.string(),
    to: v.string(),
    skip: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("contextMoveImport"),
    /** Set on the first batch only — see `importContextMoveBatch`. */
    root: v.optional(v.string()),
    objects: v.array(v.object({
      source: v.string(),
      destination: v.string(),
      bytes: v.bytes(),
      etag: v.string(),
      collaborationEtag: v.optional(v.string()),
      sourceVisibility: v.union(v.literal("private"), v.literal("team")),
    })),
  }),
  v.object({
    kind: v.literal("contextMoveDelete"),
    sources: v.array(v.object({
      path: v.string(),
      etag: v.string(),
      collaborationEtag: v.optional(v.string()),
    })),
  }),
  v.object({
    kind: v.literal("contextMoveFinish"),
    from: v.string(),
    survivors: v.array(v.string()),
  }),
  v.object({ kind: v.literal("duplicate"), path: v.string() }),
  v.object({ kind: v.literal("archive"), path: v.string(), expectedEtag: v.optional(v.string()) }),
  v.object({ kind: v.literal("trash"), path: v.string(), expectedEtag: v.optional(v.string()) }),
  v.object({ kind: v.literal("restoreTrash"), from: v.string(), to: v.string() }),
  v.object({
    kind: v.literal("delete"),
    path: v.string(),
    confirmation: v.string(),
  }),
  v.object({
    kind: v.literal("setVisibility"),
    path: v.string(),
    visibility: visibilityValidator,
  }),
  v.object({
    kind: v.literal("setNoteGroup"),
    path: v.string(),
    /**
     * The group's full name WITHOUT the `@`, already proven to belong to this
     * workspace by `setNoteGroup` before the operation is dispatched. A plain
     * string here rather than a group id: this is the value that lands in
     * `privacy.md`, and the manifest holds names, not ids.
     */
    group: v.string(),
  }),
  v.object({
    kind: v.literal("setFolderGroup"),
    path: v.string(),
    /**
     * The name WITHOUT the `@`, already proven to belong to this workspace by
     * `setFolderGroup` before the operation is dispatched. A plain string
     * rather than an id for the same reason its note-shaped sibling is one:
     * this is the value that lands in `privacy.md`, and the manifest holds
     * names, not ids — which is what lets it stay legible on export and mean
     * nothing without the control plane.
     */
    group: v.string(),
  }),
  v.object({
    kind: v.literal("setFolderVisibility"),
    path: v.string(),
    visibility: visibilityValidator,
    onlyIfUnset: v.optional(v.boolean()),
  }),
  v.object({
    /**
     * One markdown form action. See `lib/formOps.ts` for why this is a file
     * operation rather than a second place that opens a bucket credential.
     */
    kind: v.literal("form"),
    path: v.string(),
    formId: v.optional(v.string()),
    actorName: v.string(),
    actorRole: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    action: v.union(
      v.object({ kind: v.literal("submit"), values: v.array(formAnswerValidator) }),
      v.object({
        kind: v.literal("update"),
        responseId: v.string(),
        values: v.array(formAnswerValidator),
      }),
      v.object({ kind: v.literal("retract"), responseId: v.string() }),
      v.object({
        kind: v.literal("vote"),
        responseId: v.string(),
        vote: v.union(v.literal("up"), v.literal("none")),
      }),
    ),
  }),
  /**
   * Read the one response a pending notification is about, as its recipient.
   *
   * Narrow on purpose, and named for its one caller. It re-enters this action
   * with the **recipient's** `scope` and `grantedNames` rather than the
   * submitter's, because the question is whether *they* may read the answers
   * that are about to be mailed to them — asked against the live manifest, at
   * delivery. See `readResponseForNotification`.
   *
   * It is not a general "read any note as any clearance" primitive and must
   * not become one. Every argument is an identifier that came out of the
   * submission this notification is for, and the clearance comes out of a
   * membership row; a caller that could compose the two freely would be a read
   * of any note as any member, with no session and no audit line.
   */
  v.object({
    kind: v.literal("formNotifyRead"),
    notePath: v.string(),
    formId: v.string(),
    responsesPath: v.string(),
    responseId: v.string(),
    to: v.string(),
  }),
  v.object({ kind: v.literal("resetPrivacy") }),
  v.object({
    kind: v.literal("migrateStorage"),
    cleanup: v.boolean(),
  }),
  /**
   * Ask the bucket where the storage-layout migration got to, and run nothing.
   *
   * The counterpart to `migrateStorage`, and the reason it had to exist: until
   * it did, the only way to learn whether a bucket had been migrated was to
   * migrate it, so every context migrated before the control plane started
   * recording outcomes looked exactly like one that had never run it. See
   * `lib/storageLayout.ts`.
   */
  v.object({ kind: v.literal("readStorageLayout") }),
  /** `activity.md`, filtered to what this caller may see. See `activity.ts`. */
  v.object({ kind: v.literal("readActivity") }),
  /**
   * Auto-organize's trips through the barrier. See `lib/organizer/sweepOps.ts`.
   * JSON in and out: the suggestions are the engine's shape, and the engine
   * checks them when it reads them back.
   */
  v.object({
    kind: v.literal("organizer"),
    action: v.union(
      v.literal("gather"),
      v.literal("record"),
      v.literal("read"),
      v.literal("resolve"),
      v.literal("clear"),
      v.literal("autopilot"),
      v.literal("undo"),
    ),
    input: v.string(),
    autopilot: v.optional(v.boolean()),
  }),
);

/**
 * The TypeScript shapes of a file operation and its result, mirroring
 * `operationValidators.ts`.
 *
 * Split out of `functions/files.ts`; that file's header holds the rules they
 * keep.
 */

import type { FolderNotesResult } from "./folderNotes";
import type { ChaosScoreResult } from "./chaosOps";
import type { ActivityEntry } from "../activity";
import type {
  ContextMoveExport,
  ContextMoveImport,
  ContextMoveObject,
  FileContents,
  ProjectionPass,
  SearchResults,
  ManifestEntry,
  ManifestFolder,
  SyncManifest,
} from "../fileOps";
import type { FormAction, FormAnswer, FormResult, FormSeedResult } from "../formOps";
import type { Id } from "../../../_generated/dataModel";
import type { StorageLayoutState } from "../storageLayout";
import type { WorkspaceGraphResult } from "../fileOps/graph";
import type { Visibility } from "../privacy";
import type { WorkspaceRole } from "../workspaceAuth";
import type { HidePass, OldCopyText } from "../oldCopies/hiding";
import type { LinkRepairResult } from "../nodes/linkRepair";
import type { ContextPluginRow, ManagedInstalls, PluginInventory } from "./pluginValidators";

/**
 * What a projection link answers when there is nothing for it to do.
 *
 * A row that stopped being `backfilling`, an owner who opted out, a deployment
 * with no D1 credential. Zeros and `moved: false`, which is what ends the
 * chain — and `report: false`, because writing these onto a row would say a
 * backfill found no notes rather than that no backfill ran.
 */
export const IDLE_PROJECTION = {
  kind: "indexProjected",
  projected: 0,
  deleted: 0,
  notesIndexed: 0,
  notesPending: 0,
  ready: false,
  moved: false,
  report: false,
} as const;

/** What a pruning pass answers when there is no `ready` database to prune. */
export const IDLE_PRUNE = { kind: "indexPruned", deleted: 0, checked: false } as const;

/** What a bucket-index pass answers for a context whose search database replaces that index. */
export const IDLE_INDEX_PASS = {
  kind: "indexMaintained",
  pending: 0,
  changed: false,
  complete: true,
  shed: 0,
  oversizedShards: 0,
} as const;

/** What a meaning pass answers when its index is not there to fill. */
export const IDLE_MEANING = {
  kind: "meaningProjected",
  embedded: 0,
  deleted: 0,
  notesIndexed: 0,
  notesPending: 0,
  ready: false,
  moved: false,
} as const;

export type FileOperation =
  | { kind: "readActivity" }
  /** A routine's recent runs, for a caller who can see the routine note. See `fileOps/routineRuns.ts`. */
  | { kind: "routineRuns"; path: string }
  | { kind: "list"; path: string }
  | { kind: "read"; path: string; forward?: "never" | "onMiss" }
  | { kind: "manifest"; cursor?: string; folder?: string; source?: "tree" }
  | { kind: "readMany"; paths: string[]; plain?: boolean }
  | {
      kind: "writeWebsiteRelease";
      releaseId: string;
      pages: Array<{ pageId: string; path: string; expectedEtag: string }>;
    }
  | {
      kind: "readWebsiteRelease";
      pages: Array<{ releaseId: string; pageId: string; path: string }>;
    }
  | {
      kind: "deleteWebsiteRelease";
      releaseId: string;
      /** Only these pages; absent deletes the whole release. */
      pageIds?: string[];
    }
  | {
      kind: "search";
      query: string;
      prefix?: string;
      limit?: number;
      refreshOnMiss?: boolean;
    }
  | { kind: "notePaths" }
  | { kind: "workspaceGraph"; compact?: boolean }
  | { kind: "visiblePaths"; paths: string[] }
  | { kind: "maintainIndex"; passes?: number }
  /**
   * Re-index the notes one file operation changed, without listing the bucket.
   * Scheduled by the barrier behind that operation; never sent by a client.
   */
  /**
   * `shardIndex: false` is set by the barrier, never by a caller, for a
   * context whose search database replaces the bucket's index.
   */
  | { kind: "indexNotes"; written: string[]; gone: string[]; moved?: string[][]; queued?: boolean; shardIndex?: false }
  | { kind: "projectIndex"; passes?: number }
  /** Remove a `ready` database's rows for notes that are gone. See `prunePass.ts`. */
  | { kind: "pruneIndex"; passes?: number }
  /** A catch-up pass of search by meaning. See `meaningPass.ts`. */
  | { kind: "projectMeaning"; passes?: number }
  /** The Convex tree's facts fill (`lib/nodes/run.ts`): scheduled only, never sent by a client. */
  | { kind: "nodesFactFill"; passes?: number }
  /** A queued folder move (`lib/nodes/moveStart.ts`, `moveWork.ts`): started for the gateway, worked by the scheduler. */
  | { kind: "nodesMoveStart"; from: string; to: string; expectedEtag?: string }
  /** A batch of note moves in a keyed workspace, made whole or not at all (`lib/nodes/rowMoveBatch.ts`). */
  | { kind: "nodesMoveBatch"; moves: { from: string; to: string; expectedEtag?: string }[] }
  /** Write `privacy.md` from the rules held as the authority (`nodesPrivacy.ts`). */
  /** Import the icons, emoji and forwarding files once, then write them from Convex (`lib/smallData/sync.ts`). */
  | { kind: "nodesSmallData" }
  /** A folder List's notes from the Convex tree's facts. See `folderNotes.ts`. */
  | { kind: "folderNotes"; folder: string; subfolders: boolean; cursor?: string }
  /** The chaos score for this reader, and one folder's own. See `chaosOps.ts`. */
  | { kind: "chaosScore"; folder?: string }
  | { kind: "write"; path: string; text: string; expectedEtag?: string }
  | {
      kind: "importVault";
      files: Array<{ path: string; bytes: ArrayBuffer; contentType: string }>;
    }
  | { kind: "clearVault"; countOnly: boolean }
  /**
   * Replace an encrypted note's content with plaintext. A separate operation
   * from `write` rather than one more of its shapes — `writeFile` never
   * accepts plaintext over an encrypted note, and this is the one narrow,
   * explicit door that does. See `removeNoteEncryption` in `lib/fileOps.ts`.
   */
  | { kind: "removeEncryption"; path: string; text: string; expectedEtag?: string }
  | { kind: "createFolder"; path: string }
  /** Undo of a new folder, only while it holds nothing but its placeholder (`removeNewFolder`). */
  | { kind: "removeNewFolder"; path: string }
  | { kind: "move"; from: string; to: string; expectedEtag?: string; followHeading?: boolean }
  | { kind: "copy"; from: string; to: string }
  | { kind: "folderPaths" }
  | { kind: "contextMoveExport"; from: string; to: string; skip: string[] }
  | { kind: "contextMoveImport"; objects: ContextMoveObject[]; root?: string }
  | { kind: "contextMoveDelete"; sources: Array<{ path: string; etag: string }> }
  | { kind: "contextMoveFinish"; from: string; survivors: string[] }
  | { kind: "duplicate"; path: string }
  | { kind: "archive"; path: string; expectedEtag?: string }
  /** The one-time tidy of Archive's date folders into its matching places (`fileOps/archiving.ts`); owner only. */
  | { kind: "archiveTidy" }
  | { kind: "trash"; path: string; expectedEtag?: string }
  | { kind: "restoreTrash"; from: string; to: string }
  /** A trashed note's text, read-only, at the key its trail names (`fileOps/trashedReading.ts`); run by the barrier. */
  | { kind: "readTrashed"; path: string; trash: string }
  /** One pass hiding the copies Context made of mail and the rest (`lib/oldCopies/hiding.ts`); run by the barrier. */
  | { kind: "hideOldCopies"; cursor?: string }
  /** Hidden old copies' text for the owner's Download as folders (`lib/oldCopies/hiding.ts`); run by the barrier. */
  | { kind: "readOldCopies"; paths: string[] }
  /** A queued move's links followed (`lib/nodes/linkRepair.ts`); run by the barrier. */
  | { kind: "repairLinks"; pairs: { from: string; to: string }[] }
  | { kind: "delete"; path: string; confirmation: string }
  /**
   * Rows mode: the activity line a tier change records on the file path, for a change written to the rows
   * (`visibility.ts`). Not a privacy write: it touches `activity.md` only.
   */
  | {
      kind: "visibilityLine";
      action: "visibility.note" | "visibility.folder";
      path: string;
      to: string;
      teamVisible: boolean;
    }
  | { kind: "writeImage"; leaf: string; bytes: ArrayBuffer; contentType: string }
  | { kind: "readImage"; leaf: string }
  | { kind: "addBuiltInFolder"; role: string }
  /** An emoji's picture, by the leaf Convex holds for its name (`functions/emoji.ts`). */
  | { kind: "emojiRead"; name: string; leaf: string }
  | { kind: "emojiStore"; name: string; bytes: ArrayBuffer; previous: string | null }
  | { kind: "emojiRemove"; name: string; leaf: string }
  | { kind: "emojiRename"; from: string; to: string; leaf: string }
  | { kind: "pluginInventory" }
  | { kind: "pluginManagedList" }
  | { kind: "contextPlugins" }
  | { kind: "contextPluginSet"; pluginId: string; enabled: boolean }
  | {
      kind: "pluginManagedInstall";
      pluginId: string;
      version: string;
      repository: string;
      manifestJson: string;
      mainJs: string;
      stylesCss: string | null;
      lifecycleGeneration: number;
    }
  | {
      kind: "pluginManagedUninstall";
      pluginId: string;
      expectedVersion: string;
      lifecycleGeneration: number;
    }
  | { kind: "pluginManagedFence"; pluginId: string; lifecycleGeneration: number }
  | { kind: "pluginBundleRead"; pluginId: string; bundleFingerprint: string }
  | { kind: "pluginRename"; from: string; to: string; expectedEtag: string }
  | { kind: "pluginDelete"; path: string; expectedEtag: string }
  | { kind: "pluginSettingsRead"; pluginId: string }
  | { kind: "pluginSettingsWrite"; pluginId: string; json: string; expectedEtag: string | null }
  | {
      kind: "form";
      path: string;
      formId?: string;
      actorName: string;
      actorRole: WorkspaceRole;
      action: FormAction;
    }
  | {
      kind: "formNotifyRead";
      notePath: string;
      formId: string;
      responsesPath: string;
      responseId: string;
      to: string;
    }
  | { kind: "migrateStorage"; cleanup: boolean }
  | { kind: "readStorageLayout" };

/**
 * What a file operation hands back to the console.
 *
 * `visibility`, `inherited` and `folderDefault` are `Visibility` rather than
 * the two literals they used to be: a rule may name a group, and typing these
 * narrowly meant the control plane silently re-tiered one on the way out —
 * which is the same class of bug as the gateway writing `"private"` over a
 * group rule on a move. The console renders the extra case explicitly; see
 * `features/console/privacy/words.ts`.
 */
export type OperationResult =
  | { kind: "activity"; entries: ActivityEntry[] }
  | { kind: "routineRuns"; runs: Array<{ at: number; outcome: string; text: string }> }
  | { kind: "websiteReleaseWritten"; pages: number }
  | {
      kind: "websiteReleasePages";
      results: Array<
        | { path: string; outcome: "read"; text: string }
        | { path: string; outcome: "missing" }
      >;
    }
  | { kind: "websiteReleaseDeleted"; objects: number }
  | ({ kind: "formApplied" } & Omit<FormResult, "notify">)
  | {
      kind: "formNotifyRead";
      response: { by: string; at: string; answers: FormAnswer[] } | null;
    }
  | {
      /**
       * What the bucket's own migration state says, having run nothing.
       *
       * `observed` is whether it answered at all; `state` is what it said, and
       * `null` means it genuinely has never run this. The two are separate
       * because collapsing them records a false absence — which is exactly the
       * nag this operation exists to end.
       */
      kind: "storageLayoutRead";
      observed: boolean;
      state: StorageLayoutState | null;
    }
  | {
      kind: "storageMigrated";
      state: "copying" | "copied" | "cleaning" | "conflict" | "unsupported" | "complete";
      objectsCopied: number;
      objectsVerified: number;
      objectsDeleted: number;
      conflicts: number;
      error?: string;
    }
  | ({ kind: "searchResults" } & SearchResults)
  | ({ kind: "pluginInventory" } & PluginInventory)
  | ({ kind: "pluginManagedInstalls" } & ManagedInstalls)
  | { kind: "contextPlugins"; plugins: ContextPluginRow[]; settingsError: string | null }
  | { kind: "pluginSettings"; json: string; etag: string | null }
  | { kind: "pluginManaged"; pluginId: string; version: string }
  | {
      kind: "pluginBundle";
      pluginId: string;
      version: string;
      bundleFingerprint: string;
      manifestJson: string;
      mainJs: string;
      stylesCss: string | null;
    }
  | { kind: "notePaths"; paths: string[] | null; pathChunks?: string[][] }
  | ({ kind: "workspaceGraph" } & WorkspaceGraphResult)
  | { kind: "visiblePaths"; paths: string[] }
  | {
      kind: "indexMaintained";
      pending: number;
      changed: boolean;
      complete: boolean;
      shed: number;
      oversizedShards: number;
    }
  | ({ kind: "indexProjected" } & Omit<ProjectionPass, "failure"> & { failure?: string })
  | {
      kind: "meaningProjected";
      embedded: number;
      repathed?: number;
      deleted: number;
      notesIndexed: number;
      notesPending: number;
      ready: boolean;
      moved: boolean;
      failure?: string;
    }
  | {
      kind: "googleSyncRun";
      runId: Id<"googleSyncRuns">;
      status: "running" | "complete" | "failed";
      totalUnits: number;
      completedUnits: number;
      itemsFound: number;
      daysWithMail: number;
      bytesWritten: number;
      continue: boolean;
    }
  | {
      kind: "googleForwardSync";
      connectionId: Id<"googleConnections">;
      status: "synced" | "skipped" | "failed";
      daysTouched: number;
      bytesWritten: number;
      cursorAdvanced: boolean;
      gapDetected: boolean;
      truncated: boolean;
      errorCode?: string;
    }
  | { kind: "vaultImported"; created: string[]; skipped: string[]; bytesCreated: number }
  | { kind: "vaultCleared"; mode: "counted" | "deleted"; objects: number; complete: boolean }
  | {
      kind: "listing";
      path: string;
      folderDefault: Visibility;
      entries: Array<{
        kind: "file" | "folder";
        path: string;
        name: string;
        visibility: Visibility;
        inherited: Visibility;
        exception: boolean;
        readOnly: boolean;
        size?: number;
        updatedAt?: number;
      }>;
      truncated: boolean;
      manifestUsable: boolean;
    }
  | {
      kind: "file";
      path: string;
      text: string;
      etag: string;
      visibility: Visibility;
      inherited: Visibility;
      exception: boolean;
      readOnly: boolean;
      /** Stored encrypted; `text` is the ciphertext and the note is not editable here. */
      encrypted: boolean;
    }
  | ({
      kind: "manifest";
      source?: "tree" | "nodes";
      /** Where a catch-up after this walk starts, by the table's clock. First page of a table walk only. */
      since?: number;
      /** The `privacy.md` version the walk was judged by, read before it started. */
      privacy?: string | null;
    } & SyncManifest)
  | { kind: "nodesKept"; complete: boolean }
  /** `pruneIndex`: rows removed, and whether the bucket and database were both reached. */
  | { kind: "indexPruned"; deleted: number; checked: boolean }
  /** `readTrashed`: the note's text where the trash holds it, never anything to save over. */
  | { kind: "trashedText"; path: string; text: string; encrypted: boolean }
  | HidePass
  | LinkRepairResult
  | { kind: "oldCopyTexts"; results: OldCopyText[] }
  /** `nodesMoveStart`: whether the move was queued; `false` with no `error` sends the caller the old way. */
  | { kind: "moveQueued"; queued: boolean; count?: number; rowed?: boolean; historyCarried?: boolean; moved?: { from: string; to: string }[]; error?: string; message?: string }
  /** `nodesMoveBatch`: every move made (`ok`, with each old and new name), or none (`error` and `message`). */
  | { kind: "moveBatch"; ok: boolean; moves?: { from: string; to: string }[]; error?: string; message?: string }
  | TreeChangesResult
  | FolderNotesResult
  | ChaosScoreResult
  | {
      kind: "notes";
      results: Array<
        | { path: string; outcome: "read"; note: { kind: "file" } & FileContents }
        | { path: string; outcome: "error"; code: string; message: string }
        | { path: string; outcome: "deferred" }
      >;
    }
  | {
      kind: "written";
      path: string;
      etag: string;
      /** What was stored, in bytes. See `WriteResult` — it is for `activity.md`. */
      bytes: number;
      conflictCheck: "conditional" | "read-compare";
      /**
       * Response files this write created for form blocks on the note, and
       * forms whose `responses:` points somewhere unusable.
       *
       * Reported to the author rather than kept quiet, for the reason
       * `ensureFormResponseFiles` gives: a `responses:` aimed at an existing
       * note is a form that will never collect anything, and the only person
       * who can fix it is the one who just saved the block.
       */
      forms: FormSeedResult;
    }
  | { kind: "moved"; from: string; to: string; paths: string[]; etag?: string }
  | { kind: "folderPaths"; folders: string[]; truncated: boolean }
  | ({ kind: "contextMoveExported" } & ContextMoveExport)
  | ({ kind: "contextMoveLanded" } & ContextMoveImport)
  | { kind: "contextMoveRemoved"; deleted: string[]; conflicts: string[] }
  | { kind: "contextMoveFinished" }
  | { kind: "deleted"; paths: string[] }
  | { kind: "activityRecorded" }
  | {
      kind: "visibility";
      path: string;
      visibility: Visibility;
      inherited: Visibility;
      exception: boolean;
    }
  | { kind: "folderCreated"; path: string; readme: string }
  | { kind: "imageWritten"; key: string; etag: string }
  | { kind: "image"; bytes: ArrayBuffer }
  | { kind: "emojiImage"; bytes: ArrayBuffer; contentType: string }
  | { kind: "emojiStored"; name: string; leaf: string }
  | { kind: "emojiRemoved" };

/**
 * One page of what changed since a device's last sync (`treeChanges.ts`).
 * `full` means it cannot be answered that way: walk the manifest instead.
 */
export interface TreeChangesResult {
  kind: "treeChanges";
  full: boolean;
  /** Keys this caller may see that appeared or changed version. */
  entries: ManifestEntry[];
  /** Folders those keys live under, and folders still held that a removal touched. */
  folders: ManifestFolder[];
  /** Keys that left, of those this caller could see before they left. */
  gone: string[];
  /** Folders of those keys that nothing is under any more. */
  goneFolders: string[];
  /** Ask again from here. */
  since: number;
  after: string;
  /** This page was full: there is more after `since`/`after`. */
  more: boolean;
  /** The `privacy.md` version this page was judged by. */
  privacy: string | null;
  manifestUsable: boolean;
}

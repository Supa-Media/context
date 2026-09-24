/**
 * The TypeScript shapes of a file operation and its result, mirroring
 * `operationValidators.ts`.
 *
 * Split out of `functions/files.ts`; that file's header holds the rules they
 * keep.
 */

import type { ActivityEntry } from "../activity";
import type {
  ContextMoveExport,
  ContextMoveImport,
  ContextMoveObject,
  FileContents,
  ProjectionPass,
  SearchResults,
  SyncManifest,
} from "../fileOps";
import type { FormAction, FormAnswer, FormResult, FormSeedResult } from "../formOps";
import type { Id } from "../../../_generated/dataModel";
import type { StorageLayoutState } from "../storageLayout";
import type { Visibility } from "../privacy";
import type { WorkspaceRole } from "../workspaceAuth";
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

export type FileOperation =
  | { kind: "readActivity" }
  | { kind: "list"; path: string }
  | { kind: "read"; path: string; forward?: "never" | "onMiss" }
  | { kind: "forward"; paths: string[] }
  | { kind: "manifest"; cursor?: string }
  | { kind: "readMany"; paths: string[] }
  | {
      kind: "search";
      query: string;
      prefix?: string;
      limit?: number;
      refreshOnMiss?: boolean;
    }
  | { kind: "notePaths" }
  | { kind: "maintainIndex"; passes?: number }
  | { kind: "projectIndex"; passes?: number }
  | { kind: "write"; path: string; text: string; expectedEtag?: string }
  | {
      kind: "importVault";
      files: Array<{ path: string; bytes: ArrayBuffer; contentType: string }>;
    }
  | { kind: "clearVault"; countOnly: boolean }
  | { kind: "ensurePrivacy" }
  /**
   * Replace an encrypted note's content with plaintext. A separate operation
   * from `write` rather than one more of its shapes — `writeFile` never
   * accepts plaintext over an encrypted note, and this is the one narrow,
   * explicit door that does. See `removeNoteEncryption` in `lib/fileOps.ts`.
   */
  | { kind: "removeEncryption"; path: string; text: string; expectedEtag?: string }
  | { kind: "createFolder"; path: string }
  | { kind: "move"; from: string; to: string; expectedEtag?: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "folderPaths" }
  | { kind: "contextMoveExport"; from: string; to: string; skip: string[] }
  | { kind: "contextMoveImport"; objects: ContextMoveObject[]; root?: string }
  | {
      kind: "contextMoveDelete";
      sources: Array<{ path: string; etag: string; collaborationEtag?: string }>;
    }
  | { kind: "contextMoveFinish"; from: string; survivors: string[] }
  | { kind: "duplicate"; path: string }
  | { kind: "archive"; path: string; expectedEtag?: string }
  | { kind: "trash"; path: string; expectedEtag?: string }
  | { kind: "restoreTrash"; from: string; to: string }
  | { kind: "delete"; path: string; confirmation: string }
  | { kind: "setVisibility"; path: string; visibility: "private" | "team" }
  | { kind: "setNoteGroup"; path: string; group: string }
  | { kind: "setFolderGroup"; path: string; group: string }
  | { kind: "setFolderVisibility"; path: string; visibility: "private" | "team" }
  | { kind: "writeImage"; leaf: string; bytes: ArrayBuffer; contentType: string }
  | { kind: "readImage"; leaf: string }
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
  | { kind: "resetPrivacy" }
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
  | { kind: "notePaths"; paths: string[] | null }
  | { kind: "forwarded"; paths: string[] }
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
  | ({ kind: "manifest" } & SyncManifest)
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
  | {
      kind: "visibility";
      path: string;
      visibility: Visibility;
      inherited: Visibility;
      exception: boolean;
    }
  | { kind: "folderCreated"; path: string; readme: string }
  | {
      kind: "privacyReset";
      path: string;
      folders: string[];
      backedUpTo: string | null;
      partial: boolean;
    }
  | { kind: "imageWritten"; key: string; etag: string }
  | { kind: "image"; bytes: ArrayBuffer };

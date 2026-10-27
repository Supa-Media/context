/**
 * Every file operation, dispatched against a store the barrier already built.
 *
 * Split out of `functions/files.ts`, whose `runFileOperation` is the only
 * production caller and holds the credential; this module never sees one.
 */

import { followHeading } from "../fileOps/followHeading";
import { type ActivityActor, readActivity, recordActivity } from "../activity";
import type { Clearance } from "../clearance";
import {
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  type ProjectionClient,
  archivePath,
  clearVaultBatch,
  copyPath,
  createFolder,
  removeNewFolder,
  deletePath,
  duplicatePath,
  importVaultFiles,
  listFolder,
  listFolderPaths,
  indexChangedNotes,
  maintainSearchIndex,
  movePath,
  notePathIndex,
  notePathsAnswer,
  workspaceGraph,
  projectSearchIndex,
  readFile,
  readFiles,
  readImage,
  readCustomEmoji,
  removeCustomEmoji,
  renameCustomEmoji,
  storeCustomEmoji,
  removeNoteEncryption as removeNoteEncryptionOp,
  restoreTrashedPath,
  searchNotes,
  syncManifest as syncManifestOp,
  trashKeyedRows,
  trashPath,
  writeFile,
  writeImage,
} from "../fileOps";
import { visiblePathsOf } from "../fileOps/visiblePaths";
import { readRoutineRuns } from "../fileOps/routineRuns";
import { addBuiltInFolder } from "../fileOps/builtInFolders";
import { tidyArchive } from "../fileOps/archiving";
import {
  type FormNotifyMaterial,
  ensureFormResponseFiles,
  readResponseForNotification,
  runFormAction,
} from "../formOps";
import { PRIVACY_KEY, type Visibility } from "../privacy";
import { inventoryPlugins, listManagedInstalls } from "../../../../mcp/src/plugins/inventory.js";
import {
  migrateStorageLayout as migrateStorageLayoutOp,
  readStorageLayoutState as readStorageLayoutStateOp,
} from "../../../../mcp/src/storageLayout.js";
import { resolveContextPlugins, setPluginEnabled } from "../../../../mcp/src/plugins/enablement.js";
import { type FileOperation, IDLE_MEANING, IDLE_PROJECTION, type OperationResult } from "./operationTypes";
import {
  deleteWebsiteRelease,
  deleteWebsiteReleasePages,
  readWebsiteRelease,
  writeWebsiteRelease,
} from "../fileOps/websiteReleases";
import type { ManagedInstalls, PluginInventory } from "./pluginValidators";
import {
  contextPluginsResult,
  managedPluginRoot,
  managedPluginSegment,
  managedPointerGeneration,
  pluginSettingsKey,
  putImmutablePluginObject,
  requireContextPlugin,
} from "./plugins";
import { toConvexError } from "./operationErrors";
import { executeContextMoveOperation, isContextMoveOperation } from "./contextMoveOperations";
import { executePluginOperation } from "./executePluginOperation";


/**
 * Dispatch, and turn a `FileOpError` into a `ConvexError` the console can
 * branch on.
 *
 * Exported so `__tests__/fileOps.test.ts` can drive every operation against an
 * in-memory bucket without a credential, a workspace, or a session — which is
 * what keeps the barrier above small enough to audit.
 */
export async function executeOperation(
  store: FileStore,
  /**
   * What this caller is cleared for: their tier, and the `@name` rules they
   * answer to. One value rather than a `Scope` plus a name set, because a site
   * that was not updated must not compile — see `lib/clearance.ts`.
   */
  clearance: Clearance,
  operation: FileOperation,
  now: number = Date.now(),
  /**
   * This context's search database, for a `projectIndex` pass and for a
   * `search` to read.
   *
   * Passed in rather than built here for the same reason the store is: the
   * credential it is made from belongs to the barrier above, and this function
   * exists so that every operation is drivable from a test with no credential,
   * no workspace and no session. `null` for every other operation, and for a
   * projection whose row said there was nothing to do.
   */
  projection: ProjectionClient | null = null,
  /**
   * Who is doing this, for `activity.md`.
   *
   * Optional, and absent for every scheduled pass — a projection link, an
   * index sweep, a sync job. Those write nothing to the activity file anyway:
   * the actions they perform are not in the substance table, and an entry with
   * nobody's name on it would be the feed reporting the product to itself.
   */
  actor: ActivityActor | null = null,
  /**
   * Called when a line actually landed in `activity.md`.
   *
   * A callback rather than a field on the result, because every operation's
   * result shape is a contract with the console and none of them is about
   * this. The caller uses it to stamp the workspace row, which is what lights
   * the dot on another context's mark — see `schema.ts`, `activityAt`.
   *
   * It is handed the line's tier, because the stamp a non-owner member reads
   * only moves for a `team` line: `activityAt` alone would tell them the exact
   * time of a private change the rest of the product refuses them.
   */
  onActivity?: (landed: { teamVisible: boolean; reprivate: boolean }) => void,
  /**
   * Called when a submission landed on a form that names somebody to tell.
   *
   * A callback for `onActivity`'s reason and one of its own. The reason: a
   * result shape is a contract with the console, and the material a
   * notification needs is the answers themselves — which is precisely what the
   * submitter's return value must not carry.
   *
   * Its own reason: this function is drivable from a test with no workspace,
   * no credential and no scheduler, and it stays that way. It reports that a
   * notification is due; whether one is *sent* belongs to the caller that has
   * a `ctx` — see `runFileOperation`, and `functions/formNotify.ts` for what
   * happens next.
   */
  onFormNotify?: (material: FormNotifyMaterial & { responseId: string }) => void,
  /** Diagnostic identifier for scheduled search projection logs only. */
  workspaceId?: string,
): Promise<OperationResult> {
  /**
   * One change, in the activity file, if it is one worth mentioning.
   *
   * Awaited rather than fired and forgotten, because a Convex action that
   * returns with work in flight has no guarantee the work runs — and never
   * raising, because the footnote must not fail the save. The cost of the
   * common case is one small `GET`; see `lib/activity.ts`.
   */
  const noteActivity = async (
    action: string,
    paths: string[],
    details: Record<string, string | number | boolean | null | undefined> = {},
  ): Promise<void> => {
    const landed = await recordActivity(store, { action, paths, details, actor });
    if (landed !== null) onActivity?.(landed);
  };
  try {
    if (isContextMoveOperation(operation)) return await executeContextMoveOperation(store, clearance, operation);
    switch (operation.kind) {
      /*
        The plugin operations live in `executePluginOperation.ts`, which was
        split out of this file for its size. Listed here so this switch stays
        exhaustive over `FileOperation`.
      */
      case "pluginInventory":
      case "pluginManagedList":
      case "contextPlugins":
      case "contextPluginSet":
      case "pluginManagedInstall":
      case "pluginManagedUninstall":
      case "pluginManagedFence":
      case "pluginBundleRead":
      case "pluginSettingsRead":
      case "pluginSettingsWrite":
      case "pluginRename":
      case "pluginDelete":
        return await executePluginOperation(store, clearance, operation, now);
      case "list": {
        const listing = await listFolder(store, { path: operation.path, clearance });
        return { kind: "listing", ...listing };
      }
      case "read": {
        const file = await readFile(store, {
          path: operation.path,
          clearance,
          ...(operation.forward === undefined ? {} : { forward: operation.forward }),
        });
        return { kind: "file", ...file };
      }
      case "manifest": {
        const manifest = await syncManifestOp(store, {
          clearance,
          ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
          ...(operation.folder === undefined ? {} : { folder: operation.folder }),
        });
        return { kind: "manifest", ...manifest };
      }
      case "readMany": {
        const results = await readFiles(store, { paths: operation.paths, clearance, plain: operation.plain === true });
        return {
          kind: "notes",
          results: results.map((result) =>
            result.outcome === "read"
              ? { ...result, note: { kind: "file" as const, ...result.note } }
              : result,
          ),
        };
      }
      case "writeWebsiteRelease": {
        return {
          kind: "websiteReleaseWritten",
          pages: await writeWebsiteRelease(store, clearance, operation),
        };
      }
      case "readWebsiteRelease": {
        return {
          kind: "websiteReleasePages",
          results: await readWebsiteRelease(store, operation.pages),
        };
      }
      case "deleteWebsiteRelease": {
        return {
          kind: "websiteReleaseDeleted",
          objects:
            operation.pageIds === undefined
              ? await deleteWebsiteRelease(store, operation.releaseId)
              : await deleteWebsiteReleasePages(
                  store,
                  operation.releaseId,
                  operation.pageIds,
                ),
        };
      }
      case "clearVault": {
        const cleared = await clearVaultBatch(store, operation.countOnly);
        return { kind: "vaultCleared", ...cleared };
      }
      case "search": {
        const results = await searchNotes(
          store,
          {
            query: operation.query,
            prefix: operation.prefix,
            clearance,
            limit: operation.limit,
            refreshOnMiss: operation.refreshOnMiss,
            half: operation.half,
          },
          projection,
        );
        return { kind: "searchResults", ...results };
      }
      case "notePaths": {
        const found = await notePathIndex(store, clearance);
        return { kind: "notePaths", ...notePathsAnswer(found?.paths ?? null) };
      }
      case "workspaceGraph":
        return { kind: "workspaceGraph", ...(await workspaceGraph(store, clearance, { compact: operation.compact === true })) };
      case "visiblePaths":
        return { kind: "visiblePaths", paths: await visiblePathsOf(store, clearance, operation.paths) };
      case "projectIndex": {
        // Scope-blind, exactly like `maintainIndex` below: the tier a note is
        // copied at comes from `privacy.md` per note, never from whoever
        // scheduled the pass. A projection built per caller would be one
        // database per membership.
        if (projection === null) return IDLE_PROJECTION;
        const pass = await projectSearchIndex(store, projection, { workspaceId });
        return {
          kind: "indexProjected",
          projected: pass.projected,
          deleted: pass.deleted,
          notesIndexed: pass.notesIndexed,
          notesPending: pass.notesPending,
          ready: pass.ready,
          moved: pass.moved,
          report: pass.report,
          failure: pass.failure ?? undefined,
          failureDetail: pass.failureDetail ?? null,
        };
      }
      case "projectMeaning": case "pruneIndex": case "folderNotes": case "chaosScore": case "nodesFactFill": case "nodesMoveStart": case "nodesMoveBatch": case "nodesSmallData": case "readTrashed": case "hideOldCopies": case "readOldCopies": case "readMessagesLog": case "eraseMessagesBackup": case "readMessagesReads": case "repairLinks": // run by the barrier (`meaningPass.ts`, `treeOps.ts`, `lib/nodes/run.ts`, `fileOps/trashedReading.ts`)
        return IDLE_MEANING;
      case "maintainIndex": {
        // Scope-blind on purpose: an index describes the bucket, and building
        // it per caller would mean one index per membership. What is scoped is
        // every path, snippet and count that leaves a *search* — `isVisible`
        // in `searchNotes`, never here.
        const pass = await maintainSearchIndex(store);
        return { kind: "indexMaintained", ...pass };
      }
      case "indexNotes": {
        // Scope-blind, like `maintainIndex` above, and for the same reason.
        // And the search database, where it is `ready` (`fileOps/search.ts`).
        const pass = await indexChangedNotes(store, operation, projection);
        return { kind: "indexMaintained", ...pass };
      }
      case "write": {
        const written = await writeFile(store, {
          path: operation.path,
          text: operation.text,
          expectedEtag: operation.expectedEtag,
          clearance,
          now,
        });
        /*
          A note carrying a form block gets that form's response file created
          here, on the **author's** write, because the author holds write access
          and the submitter may not — see `ensureFormResponseFiles`.

          After the note's own write and never before it, and its failures are
          swallowed rather than raised: the note is the customer's content and
          is already in the bucket. A response file that could not be seeded is
          a form that is not collecting yet, and re-raising here would report a
          save that succeeded as a save that failed.
        */
        const forms = await ensureFormResponseFiles(store, {
          text: operation.text,
          notePath: written.path,
        }).catch(() => ({ created: [], occupied: [] }));
        await noteActivity(
          operation.expectedEtag === undefined ? "file.create" : "file.write",
          [written.path],
          { content_bytes: written.bytes },
        );
        return { kind: "written", ...written, forms };
      }
      case "form": {
        /*
          The same switch the gateway applies to `submit_form`, applied to the
          console's own path into the same file.

          Both, or the promise beside the switch is false. The gateway refuses
          the four form tools when the Markdown forms plugin is off; a console
          that went on writing rows into the same response file would make
          "forms are off in this context" a statement about connected AI
          clients only, which is not what the row says and not what an owner
          pressing it meant.
        */
        await requireContextPlugin(store, "context-forms", "Markdown forms");
        const applied = await runFormAction(store, {
          clearance,
          path: operation.path,
          formId: operation.formId,
          actor: { name: operation.actorName, role: operation.actorRole },
          action: operation.action,
        });
        /*
          TELLING SOMEBODY IS SCHEDULED, NEVER AWAITED, AND THE REASON IS THE
          SAME ONE `functions/invitationEmail.ts` GIVES.

          A submission through a collect link comes from a stranger with no
          account. If this branch resolved a recipient, read a manifest and
          made an HTTPS call before returning, then the time a submission takes
          would depend on whether the form notifies anybody and on whether
          their address accepted the mail — an oracle you can read with a
          stopwatch and no API at all. `runAfter(0, …)` is enqueued in a
          separate transaction whose return value the scheduler discards, so
          there is no channel back and nothing here varies.

          It is also why a failed notification cannot fail a submission. The
          answer is already in the customer's bucket; mail is a derivative of
          it, and a derivative never rolls back the canonical write.
        */
        const { notify, ...result } = applied;
        if (notify !== undefined) {
          onFormNotify?.({ ...notify, responseId: result.responseId });
        }
        // `notify` is destructured off rather than left for the validator to
        // reject, and the validator would reject it — see
        // `formNotifyVisibleValidator`. Two guards, because the one that
        // matters is that the answers never reach the submitter's return
        // value, and a validator is a guard nobody reads until it fires.
        return { kind: "formApplied", ...result };
      }
      case "formNotifyRead": {
        /*
          No plugin gate, deliberately. Turning the Markdown forms plugin off
          stops a form being *used*; it does not un-send the answer that landed
          a moment before the switch, and a notification that silently stopped
          at that boundary would leave an owner waiting for mail about an
          answer they already have. What still applies is `canSee`, which is
          the check that decides anything here.
        */
        return {
          kind: "formNotifyRead",
          response: await readResponseForNotification(store, clearance, {
            notePath: operation.notePath,
            formId: operation.formId,
            responsesPath: operation.responsesPath,
            responseId: operation.responseId,
            to: operation.to,
          }),
        };
      }
      case "removeEncryption": {
        const written = await removeNoteEncryptionOp(store, {
          path: operation.path,
          text: operation.text,
          expectedEtag: operation.expectedEtag,
          clearance,
        });
        /*
          No form seeding on this path, and that is not an omission. Removing a
          note's encryption replaces ciphertext with the plaintext its owner
          just decrypted on their device; the response file for any form inside
          it was seeded when the form was written, and re-running the seed here
          would create one for a form that has been collecting for months.
        */
        return { kind: "written", ...written, forms: { created: [], occupied: [] } };
      }
      case "createFolder": {
        const created = await createFolder(store, { path: operation.path, clearance, now });
        return { kind: "folderCreated", ...created };
      }
      case "addBuiltInFolder":
        return { kind: "folderCreated", ...(await addBuiltInFolder(store, { role: operation.role, clearance, now })) };
      case "removeNewFolder":
        return { kind: "deleted", ...(await removeNewFolder(store, { path: operation.path, clearance })) };
      case "move": {
        const moved = await movePath(store, {
          from: operation.from,
          to: operation.to,
          clearance,
          now,
          ...(operation.expectedEtag === undefined ? {} : { expectedEtag: operation.expectedEtag }),
        });
        // The heading follows the new name inside the rename (`followHeading.ts`).
        const headed = operation.followHeading === true ? await followHeading(store, moved, { clearance, now }) : undefined;
        await noteActivity("file.move", [moved.from, moved.to], {
          count: moved.queued ?? moved.paths.length,
        });
        return { kind: "moved", ...moved, ...(headed === undefined ? {} : { etag: headed }) };
      }
      case "folderPaths": {
        const found = await listFolderPaths(store, { clearance });
        return { kind: "folderPaths", ...found };
      }
      case "routineRuns":
        return { kind: "routineRuns", runs: await readRoutineRuns(store, { path: operation.path, clearance }) };
      case "readActivity": {
        // The filter is `readActivity`'s, and it takes the caller's clearance
        // rather than deciding anything here: one viewing layer, used by the
        // console and the gateway alike.
        const entries = await readActivity(store, {
          scope: clearance.scope,
          names: [...clearance.names],
        });
        return { kind: "activity", entries };
      }
      case "copy": {
        const copied = await copyPath(store, {
          from: operation.from,
          to: operation.to,
          clearance,
        });
        return { kind: "moved", ...copied };
      }
      case "duplicate": {
        const copied = await duplicatePath(store, { path: operation.path, clearance });
        return { kind: "moved", ...copied };
      }
      case "archive": {
        const moved = await archivePath(store, {
          path: operation.path,
          clearance,
          now,
          ...(operation.expectedEtag === undefined ? {} : { expectedEtag: operation.expectedEtag }),
        });
        await noteActivity("file.archive", [moved.from, moved.to], {
          count: moved.queued ?? moved.paths.length,
        });
        return { kind: "moved", ...moved };
      }
      case "archiveTidy": {
        // The workspace's own housekeeping, at the owner's clearance only: it moves things a member may not see.
        if (clearance.scope !== "private") throw new FileOpError("PATH_INVALID", "Only an owner can tidy the archive.");
        const tidied = await tidyArchive(store, { clearance, now });
        return {
          kind: "moved",
          from: tidied.archive ?? "",
          to: tidied.archive ?? "",
          paths: tidied.moved.map((move) => move.to),
          ...(tidied.left ? { queued: tidied.moved.length } : {}),
        };
      }
      case "trash": {
        const moved = await trashPath(store, {
          path: operation.path,
          clearance,
          now,
          ...(operation.expectedEtag === undefined ? {} : { expectedEtag: operation.expectedEtag }),
        });
        return { kind: "moved", ...moved };
      }
      case "restoreTrash": {
        const moved = await restoreTrashedPath(store, {
          from: operation.from,
          to: operation.to,
          clearance,
        });
        return { kind: "moved", ...moved };
      }
      case "delete": {
        const deleted = await deletePath(store, {
          path: operation.path,
          confirmation: operation.confirmation,
          clearance,
        });
        return { kind: "deleted", ...deleted };
      }
      case "visibilityLine": {
        // Rows mode: the change went to the rows (`visibility.ts`), and this is the activity line the file path
        // records for the same change. The team flag is the rows' answer, not the rules'.
        const landed = await recordActivity(store, {
          action: operation.action,
          paths: [operation.path],
          details: { to: operation.to },
          actor,
          teamVisible: operation.teamVisible,
        });
        if (landed !== null) onActivity?.(landed);
        return { kind: "activityRecorded" };
      }
      case "writeImage": {
        /*
          Deliberately NOT gated on the Images plugin, and the reason is worth
          keeping: the only caller is `shareCard`, which renders the picture an
          unfurl shows. Nothing a person would call "uploading an image" reaches
          here. Gating it would have made an owner turning off an agent's
          `read_image` silently break their own share links — a switch reaching
          past what its own row promises, which is the failure `plugins.md`
          spends a section on.
        */
        const written = await writeImage(store, {
          leaf: operation.leaf,
          bytes: new Uint8Array(operation.bytes),
          contentType: operation.contentType,
        });
        return { kind: "imageWritten", ...written };
      }
      case "importVault": {
        const imported = await importVaultFiles(store, {
          clearance,
          files: operation.files.map((file) => ({
            ...file,
            bytes: new Uint8Array(file.bytes),
          })),
        });
        return { kind: "vaultImported", ...imported };
      }
      case "readImage": {
        const bytes = await readImage(store, operation.leaf);
        return { kind: "image", bytes };
      }
      // An emoji by the leaf Convex holds for its name (`functions/emoji.ts`): no listing of the image store.
      case "emojiRead":
        return { kind: "emojiImage", ...(await readCustomEmoji(store, operation)) };
      case "emojiStore": {
        const stored = await storeCustomEmoji(store, {
          name: operation.name,
          bytes: new Uint8Array(operation.bytes),
          previous: operation.previous,
        });
        return { kind: "emojiStored", ...stored };
      }
      case "emojiRemove":
        await removeCustomEmoji(store, operation);
        return { kind: "emojiRemoved" };
      case "emojiRename":
        return { kind: "emojiStored", ...(await renameCustomEmoji(store, operation)) };
      case "migrateStorage": {
        const result = await migrateStorageLayoutOp(store, {
          cleanup: operation.cleanup,
          batchSize: 8,
          now: new Date(now),
        });
        return {
          kind: "storageMigrated",
          state: result.state,
          objectsCopied: result.objectsCopied,
          objectsVerified: result.objectsVerified,
          objectsDeleted: result.objectsDeleted,
          conflicts: result.conflicts.length,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      }
      case "readStorageLayout": {
        // One `get` against a single JSON key, plus — only where there is no
        // state file to read — one `list` per legacy prefix capped at a single
        // object, because "no state file" is also what a bucket we scaffolded
        // ourselves looks like and that one has nothing to migrate at all.
        // Still read-only, and it deliberately does not take the
        // conditional-write capabilities `migrateStorage` requires: a bucket
        // that can never run the migration can still say whether it needs one,
        // and `unsupported` is the migration's refusal, recorded where the
        // refusal happens.
        const observation = await readStorageLayoutStateOp(store);
        return {
          kind: "storageLayoutRead",
          observed: observation.observed,
          state: observation.state,
        };
      }
    }
  } catch (error) {
    throw toConvexError(error, workspaceId);
  }
}

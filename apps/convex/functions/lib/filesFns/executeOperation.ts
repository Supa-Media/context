/**
 * Every file operation, dispatched against a store the barrier already built.
 *
 * Split out of `functions/files.ts`, whose `runFileOperation` is the only
 * production caller and holds the credential; this module never sees one.
 */

import { type ActivityActor, readActivity, recordActivity } from "../activity";
import type { Clearance } from "../clearance";
import {
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  type ProjectionClient,
  archivePath,
  clearMovedSourceRules,
  clearVaultBatch,
  copyPath,
  createFolder,
  deleteMovedSources,
  deletePath,
  duplicatePath,
  exportContextMoveBatch,
  importContextMoveBatch,
  importVaultFiles,
  listFolder,
  listFolderPaths,
  maintainSearchIndex,
  movePath,
  notePathIndex,
  projectSearchIndex,
  readFile,
  readFiles,
  readImage,
  removeNoteEncryption as removeNoteEncryptionOp,
  resetPrivacyManifest,
  restoreTrashedPath,
  searchNotes,
  setFolderVisibility,
  setVisibility,
  syncManifest as syncManifestOp,
  trashPath,
  writeFile,
  writeImage,
} from "../fileOps";
import { ensureFolderVisibility } from "../fileOps/visibility";
import {
  type FormNotifyMaterial,
  ensureFormResponseFiles,
  readResponseForNotification,
  runFormAction,
} from "../formOps";
import { PRIVACY_KEY, type Visibility } from "../privacy";
import { forwardPath, readForwarding } from "../../../../mcp/src/forwarding.js";
import { inventoryPlugins, listManagedInstalls } from "../../../../mcp/src/plugins/inventory.js";
import {
  migrateStorageLayout as migrateStorageLayoutOp,
  readStorageLayoutState as readStorageLayoutStateOp,
} from "../../../../mcp/src/storageLayout.js";
import { resolveContextPlugins, setPluginEnabled } from "../../../../mcp/src/plugins/enablement.js";
import { type FileOperation, IDLE_PROJECTION, type OperationResult } from "./operationTypes";
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

const MAX_PLUGIN_BUNDLE_BYTES = 10 * 1024 * 1024;

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
  onActivity?: (landed: { teamVisible: boolean }) => void,
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
    switch (operation.kind) {
      case "pluginInventory": {
        const inventory = await inventoryPlugins(store) as PluginInventory;
        return { kind: "pluginInventory", ...inventory };
      }
      /*
        The cheap half, and the one the console may run without being asked.

        `pluginInventory` opens every bundle in `.obsidian/plugins/`, which is
        why it waits for a press. This reads one small pointer per plugin
        Context installed and writes nothing, so the screen that manages
        installs can arrive knowing what is installed — which, until this
        existed, it did not.
      */
      case "pluginManagedList": {
        const managed = await listManagedInstalls(store) as ManagedInstalls;
        return { kind: "pluginManagedInstalls", ...managed };
      }
      /*
        The built-in plugins, resolved against this bucket's settings file.

        The catalogue and the resolver are the gateway's — imported here, never
        reimplemented — for the reason `lib/formOps.ts` gives about the form
        format: two copies of "which plugins exist and which are on" would let
        a console and a connected client disagree about the same context, and
        the disagreement would be invisible until somebody's tool went missing
        from one of the two.
      */
      case "contextPlugins": {
        return contextPluginsResult(await resolveContextPlugins(store));
      }
      case "contextPluginSet": {
        try {
          await setPluginEnabled(store, operation.pluginId, operation.enabled);
        } catch (error) {
          // A lost conditional write is a conflict, which is what the console
          // knows how to show; anything else is this bucket refusing, and is
          // reported as a storage failure rather than as a bad request.
          const message = error instanceof Error ? error.message : "That could not be saved.";
          throw new FileOpError(
            /changed while/.test(message) ? "CONFLICT" : "STORAGE_UNSAFE",
            message,
          );
        }
        // Re-read rather than assume. The write is the request; the answer is
        // what the bucket now says, which is the only thing the console should
        // draw a switch from.
        return contextPluginsResult(await resolveContextPlugins(store));
      }
      case "pluginManagedInstall": {
        if (
          store.capabilities?.conditionalWrite !== true ||
          store.capabilities?.conditionalCreate !== true
        ) {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely install plugins.");
        }
        const root = managedPluginRoot(operation.pluginId);
        const release = `${root}/releases/${managedPluginSegment(operation.version, "version")}`;
        await putImmutablePluginObject(store, `${release}/manifest.json`, operation.manifestJson);
        await putImmutablePluginObject(store, `${release}/main.js`, operation.mainJs);
        const existingStyles = await store.get(`${release}/styles.css`);
        if (operation.stylesCss === null && existingStyles) {
          throw new FileOpError("CONFLICT", "That plugin release has unexpected stylesheet bytes.");
        }
        if (operation.stylesCss !== null) {
          await putImmutablePluginObject(store, `${release}/styles.css`, operation.stylesCss);
        }
        const pointerKey = `${root}/current.json`;
        const existing = await store.get(pointerKey);
        if (existing) {
          try {
            const current = JSON.parse(await existing.text()) as Record<string, unknown>;
            const currentGeneration = managedPointerGeneration(current);
            if (currentGeneration > operation.lifecycleGeneration) {
              throw new FileOpError("CONFLICT", "A newer plugin operation already completed.");
            }
            if (
              current.state === "uninstalling" &&
              currentGeneration === operation.lifecycleGeneration
            ) {
              throw new FileOpError("CONFLICT", "That plugin is currently being uninstalled.");
            }
          } catch (error) {
            if (error instanceof FileOpError) throw error;
          }
        }
        const pointer = JSON.stringify({
          id: operation.pluginId,
          version: operation.version,
          repository: operation.repository,
          lifecycleGeneration: operation.lifecycleGeneration,
        });
        const written = await store.put(pointerKey, pointer, {
          onlyIf: existing ? { etagMatches: existing.etag } : { absent: true },
        });
        if (written === null) {
          throw new FileOpError("CONFLICT", "The installed plugin changed during installation.");
        }
        return { kind: "pluginManaged", pluginId: operation.pluginId, version: operation.version };
      }
      case "pluginManagedUninstall": {
        const root = managedPluginRoot(operation.pluginId);
        const pointerKey = `${root}/current.json`;
        const pointer = await store.get(pointerKey);
        if (!pointer) throw new FileOpError("FILE_NOT_FOUND", "That managed plugin is not installed.");
        let current: Record<string, unknown>;
        try {
          current = JSON.parse(await pointer.text()) as { id?: unknown; version?: unknown };
        } catch {
          throw new FileOpError("CONFLICT", "That managed plugin pointer is invalid.");
        }
        if (current.id !== operation.pluginId || current.version !== operation.expectedVersion) {
          throw new FileOpError("CONFLICT", "That managed plugin changed before uninstall.");
        }
        if (managedPointerGeneration(current) > operation.lifecycleGeneration) {
          throw new FileOpError("CONFLICT", "A newer plugin operation already completed.");
        }
        if (store.capabilities?.conditionalDelete !== true) {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely uninstall plugins.");
        }
        const deleted = await store.delete(pointerKey, { onlyIf: { etagMatches: pointer.etag } });
        if (deleted === null) {
          throw new FileOpError("CONFLICT", "That managed plugin changed before uninstall.");
        }
        return { kind: "pluginManaged", pluginId: operation.pluginId, version: operation.expectedVersion };
      }
      case "pluginManagedFence": {
        if (
          store.capabilities?.conditionalWrite !== true ||
          store.capabilities?.conditionalCreate !== true
        ) {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely recover plugins.");
        }
        const pointerKey = `${managedPluginRoot(operation.pluginId)}/current.json`;
        const existing = await store.get(pointerKey);
        if (existing) {
          try {
            const current = JSON.parse(await existing.text()) as Record<string, unknown>;
            if (managedPointerGeneration(current) > operation.lifecycleGeneration) {
              throw new FileOpError("CONFLICT", "A newer plugin operation already completed.");
            }
          } catch (error) {
            if (error instanceof FileOpError) throw error;
          }
        }
        const fence = JSON.stringify({
          id: operation.pluginId,
          state: "recovering",
          lifecycleGeneration: operation.lifecycleGeneration,
        });
        const written = await store.put(pointerKey, fence, {
          onlyIf: existing ? { etagMatches: existing.etag } : { absent: true },
        });
        if (written === null) {
          const raced = await store.get(pointerKey);
          if (!raced || await raced.text() !== fence) {
            throw new FileOpError("CONFLICT", "Plugin recovery lost a concurrent storage change.");
          }
        }
        return { kind: "pluginManaged", pluginId: operation.pluginId, version: "" };
      }
      case "pluginBundleRead": {
        const inventory = await inventoryPlugins(store) as PluginInventory;
        const plugin = inventory.plugins.find((entry) =>
          entry.id === operation.pluginId && entry.bundleFingerprint === operation.bundleFingerprint
        );
        if (!plugin || !plugin.bundleFingerprint) {
          throw new FileOpError("CONFLICT", "That plugin bundle changed before it could be loaded.");
        }
        const base = plugin.source === "context"
          ? `${managedPluginRoot(plugin.id)}/releases/${managedPluginSegment(plugin.version, "version")}`
          : `.obsidian/plugins/${plugin.folder}`;
        const manifest = await store.get(`${base}/manifest.json`);
        const main = await store.get(`${base}/main.js`);
        if (!manifest || !main) {
          throw new FileOpError("FILE_NOT_FOUND", "That plugin bundle is incomplete.");
        }
        const styles = await store.get(`${base}/styles.css`);
        const styleIdentity = styles ? `present:${styles.etag}` : "absent";
        const currentFingerprint = `v2:${[manifest.etag, main.etag, styleIdentity]
          .map((etag) => encodeURIComponent(etag)).join(":")}`;
        if (currentFingerprint !== operation.bundleFingerprint) {
          throw new FileOpError("CONFLICT", "That plugin bundle changed before it could be loaded.");
        }
        const manifestJson = await manifest.text();
        const mainJs = await main.text();
        const stylesCss = styles ? await styles.text() : null;
        if (manifestJson.length + mainJs.length + (stylesCss?.length ?? 0) > MAX_PLUGIN_BUNDLE_BYTES) {
          throw new FileOpError("PLUGIN_TOO_LARGE", "That plugin bundle is too large to load.");
        }
        return {
          kind: "pluginBundle",
          pluginId: plugin.id,
          version: plugin.version,
          bundleFingerprint: operation.bundleFingerprint,
          manifestJson,
          mainJs,
          stylesCss,
        };
      }
      case "pluginSettingsRead": {
        const object = await store.get(pluginSettingsKey(operation.pluginId));
        if (!object) return { kind: "pluginSettings", json: "{}", etag: null };
        return { kind: "pluginSettings", json: await object.text(), etag: object.etag };
      }
      case "pluginSettingsWrite": {
        const key = pluginSettingsKey(operation.pluginId);
        const existing = await store.get(key);
        if (operation.expectedEtag === null ? existing !== null : existing?.etag !== operation.expectedEtag) {
          throw new FileOpError(
            "CONFLICT",
            "Plugin settings changed while they were being edited.",
            existing?.etag,
          );
        }
        const onlyIf: { etagMatches?: string; absent?: true } = existing
          ? { etagMatches: existing.etag }
          : { absent: true as const };
        const written = (existing || store.capabilities?.conditionalCreate === true)
          ? await store.put(key, operation.json, { onlyIf })
          : await store.put(key, operation.json);
        if (written === null) {
          const current = await store.get(key);
          throw new FileOpError(
            "CONFLICT",
            "Plugin settings changed while they were being edited.",
            current?.etag,
          );
        }
        return { kind: "pluginSettings", json: operation.json, etag: written.etag };
      }
      case "pluginRename": {
        const current = await readFile(store, { path: operation.from, clearance });
        if (current.etag !== operation.expectedEtag) {
          throw new FileOpError(
            "CONFLICT",
            "That file changed somewhere else while the plugin was using it.",
            current.etag,
          );
        }
        const moved = await movePath(store, {
          from: operation.from,
          to: operation.to,
          clearance,
          now,
          expectedEtag: operation.expectedEtag,
          requireAtomic: true,
        });
        return { kind: "moved", ...moved };
      }
      case "pluginDelete": {
        const current = await readFile(store, { path: operation.path, clearance });
        if (current.etag !== operation.expectedEtag) {
          throw new FileOpError(
            "CONFLICT",
            "That file changed somewhere else while the plugin was using it.",
            current.etag,
          );
        }
        const deleted = await deletePath(store, {
          path: operation.path,
          confirmation: DELETE_CONFIRMATION,
          clearance,
          expectedEtag: operation.expectedEtag,
        });
        return { kind: "deleted", ...deleted };
      }
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
      case "forward": {
        /*
          DELIBERATELY UNFILTERED, AND SAFE ONLY BECAUSE OF WHERE IT GOES.

          This answers "where did this path go" without asking `canSee` about
          either end, which would be wrong if the answer were ever handed to a
          caller: a forwarded path is a fact about a note, and where a private
          note went is not a team reader's business.

          It is never handed to one. `runFileOperation` is internal, the single
          caller is `readSharedNote`, and everything it does with the answer —
          the folder bound, then a read at `team` scope through the live
          `privacy.md` — decides afresh. A path that forwards somewhere the
          reader may not see comes back as the same `SHARE_UNAVAILABLE` as one
          that never existed. **Any new caller has to re-argue that**, or ask
          `canSee` here.
        */
        const ledger = await readForwarding(store);
        return {
          kind: "forwarded" as const,
          paths: operation.paths.map((path) => forwardPath(ledger, path)),
        };
      }
      case "manifest": {
        const manifest = await syncManifestOp(store, {
          clearance,
          ...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
        });
        return { kind: "manifest", ...manifest };
      }
      case "readMany": {
        const results = await readFiles(store, { paths: operation.paths, clearance });
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
      case "ensurePrivacy": {
        try {
          const reset = await resetPrivacyManifest(store, { clearance, now });
          return { kind: "privacyReset", ...reset };
        } catch (error) {
          if (error instanceof FileOpError && error.code === "PRIVACY_MANIFEST_USABLE") {
            return {
              kind: "privacyReset",
              path: PRIVACY_KEY,
              folders: [],
              backedUpTo: null,
              partial: false,
            };
          }
          throw error;
        }
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
          },
          projection,
        );
        return { kind: "searchResults", ...results };
      }
      case "notePaths": {
        const found = await notePathIndex(store, clearance);
        return { kind: "notePaths", paths: found?.paths ?? null };
      }
      case "projectIndex": {
        // Scope-blind, exactly like `maintainIndex` below: the tier a note is
        // copied at comes from `privacy.md` per note, never from whoever
        // scheduled the pass. A projection built per caller would be one
        // database per membership.
        if (projection === null) return IDLE_PROJECTION;
        const pass = await projectSearchIndex(store, projection);
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
        };
      }
      case "maintainIndex": {
        // Scope-blind on purpose: an index describes the bucket, and building
        // it per caller would mean one index per membership. What is scoped is
        // every path, snippet and count that leaves a *search* — `isVisible`
        // in `searchNotes`, never here.
        const pass = await maintainSearchIndex(store);
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
      case "move": {
        const moved = await movePath(store, {
          from: operation.from,
          to: operation.to,
          clearance,
          now,
          ...(operation.expectedEtag === undefined ? {} : { expectedEtag: operation.expectedEtag }),
        });
        await noteActivity("file.move", [moved.from, moved.to], {
          count: moved.paths.length,
        });
        return { kind: "moved", ...moved };
      }
      case "folderPaths": {
        const found = await listFolderPaths(store, { clearance });
        return { kind: "folderPaths", ...found };
      }
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
      case "contextMoveExport": {
        const exported = await exportContextMoveBatch(store, {
          from: operation.from,
          to: operation.to,
          clearance,
          skip: operation.skip,
        });
        return { kind: "contextMoveExported", ...exported };
      }
      case "contextMoveImport": {
        const landed = await importContextMoveBatch(store, {
          objects: operation.objects,
          clearance,
          ...(operation.root === undefined ? {} : { root: operation.root }),
        });
        return { kind: "contextMoveLanded", ...landed };
      }
      case "contextMoveDelete": {
        const removed = await deleteMovedSources(store, { sources: operation.sources });
        return { kind: "contextMoveRemoved", ...removed };
      }
      case "contextMoveFinish": {
        await clearMovedSourceRules(store, {
          from: operation.from,
          survivors: operation.survivors,
        });
        return { kind: "contextMoveFinished" };
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
          count: moved.paths.length,
        });
        return { kind: "moved", ...moved };
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
      case "setNoteGroup": {
        // The same writer as `setVisibility`, with a group in place of a tier:
        // `fileOps.setVisibility` has taken a `Visibility` since #418 and a
        // group is one. A separate operation rather than a widened
        // `setVisibility` because the ARGUMENT validator must stay two-valued —
        // widening it would make every path that takes a visibility a way to
        // mint a rule, which is exactly what the gateway refuses AI clients.
        const result = await setVisibility(store, {
          path: operation.path,
          visibility: `@${operation.group}` as Visibility,
          clearance,
        });
        return { kind: "visibility" as const, ...result };
      }
      case "setFolderGroup": {
        // The same writer as `setFolderVisibility`, with a name in place of a
        // tier: that function has taken a `Visibility` since the group
        // namespace existed and a name is one, so nothing in the engine was
        // ever in the way. A separate operation rather than a widened
        // `setFolderVisibility` for the reason `setNoteGroup` is separate —
        // the ARGUMENT validator must stay two-valued, or every path that
        // takes a visibility becomes a way to mint a rule.
        const result = await setFolderVisibility(store, {
          path: operation.path,
          visibility: `@${operation.group}` as Visibility,
          clearance,
        });
        return { kind: "visibility" as const, ...result };
      }
      case "setVisibility": {
        const result = await setVisibility(store, {
          path: operation.path,
          visibility: operation.visibility,
          clearance,
        });
        // The widening only. `recordActivity` re-derives the flag from the
        // manifest it has just changed, and the shared substance table drops
        // the other direction: a line saying a note went private would be the
        // disclosure the change was undoing.
        await noteActivity("visibility.note", [operation.path], {
          to: operation.visibility,
        });
        return { kind: "visibility", ...result };
      }
      case "setFolderVisibility": {
        const { result, changed } = operation.onlyIfUnset === true
          ? await ensureFolderVisibility(store, {
              path: operation.path,
              visibility: operation.visibility,
              clearance,
            })
          : {
              result: await setFolderVisibility(store, {
                path: operation.path,
                visibility: operation.visibility,
                clearance,
              }),
              changed: true,
            };
        if (changed) {
          await noteActivity("visibility.folder", [operation.path], {
            to: operation.visibility,
          });
        }
        return { kind: "visibility", ...result };
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
      case "resetPrivacy": {
        const result = await resetPrivacyManifest(store, { clearance, now });
        return { kind: "privacyReset", ...result };
      }
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
    throw toConvexError(error);
  }
}

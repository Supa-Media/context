/**
 * The plugin operations: inventory, managed installs, bundles, settings and
 * the rename and delete of a plugin's own files.
 *
 * Moved verbatim out of `executeOperation.ts`, which was over the size line.
 * Dispatched from `executeOperation`'s switch; the bodies are unchanged.
 */

import { FileOpError, type FileStore, movePath, readFile, trashKeyedRows } from "../fileOps";
import { inventoryPlugins, listManagedInstalls } from "../../../../mcp/src/plugins/inventory.js";
import { resolveContextPlugins, setPluginEnabled } from "../../../../mcp/src/plugins/enablement.js";
import type { Clearance } from "../clearance";
import type { FileOperation, OperationResult } from "./operationTypes";
import type { ManagedInstalls, PluginInventory } from "./pluginValidators";
import {
  contextPluginsResult,
  managedPluginRoot,
  managedPluginSegment,
  managedPointerGeneration,
  pluginSettingsKey,
  putImmutablePluginObject,
} from "./plugins";

const MAX_PLUGIN_BUNDLE_BYTES = 10 * 1024 * 1024;

/** The plugin operations, against a store the barrier already built. */
export async function executePluginOperation(
  store: FileStore,
  clearance: Clearance,
  operation: FileOperation,
  now: number,
): Promise<OperationResult> {
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
        // A keyed workspace's row move checks the row's version, which is the note's bytes' etag. A collaborative
        // note reads back its revision instead (what the plugin was handed by `vault.modify`), so the row is asked
        // for the version it holds: the one `readFile` took beside that revision. The revision check above already
        // proved the note is the one the plugin saw; the row move re-checks the row atomically.
        const moved = await movePath(store, {
          from: operation.from,
          to: operation.to,
          clearance,
          now,
          expectedEtag: current.rawEtag ?? current.etag,
          requireAtomic: true,
        });
        return { kind: "moved", ...moved };
      }
      case "pluginDelete": {
        // A keyed workspace's file is at its id key, which this store's reads do not reach: the version is
        // checked by the row move, and the file is trashed as its row (restorable), not deleted.
        // The row is asked for the version it holds, as the rename below does (see `pluginRename`).
        const current = await readFile(store, { path: operation.path, clearance });
        // Either version names the note as it is now: the revision a read handed out, or the row's own.
        if (current.etag !== operation.expectedEtag && current.rawEtag !== operation.expectedEtag) {
          throw new FileOpError(
            "CONFLICT",
            "That file changed somewhere else while the plugin was using it.",
            current.etag,
          );
        }
        return { kind: "deleted", ...(await trashKeyedRows(store, { path: operation.path, clearance, now, expectedEtag: current.rawEtag ?? current.etag })) };
      }
      default:
        throw new Error(`not a plugin operation: ${operation.kind}`);
  }
}

/**
 * The Context plugins' storage helpers: the enablement gate, the settings key,
 * and the immutable managed-install objects.
 *
 * Split out of `functions/files.ts`; the operations that use them run inside
 * `executeOperation`, against the store the barrier built.
 */

import { FileOpError, type FileStore } from "../fileOps";
import { resolveContextPlugins } from "../../../../mcp/src/plugins/enablement.js";
import type { OperationResult } from "./operationTypes";

/** Product-owned shadow settings; `.obsidian/` remains read-only. */
/**
 * The gateway's resolved built-ins, flattened onto the wire shape.
 *
 * One function for both operations, so a read and a write cannot come back
 * describing the same context differently — the switch the console draws after
 * saving is the same shape it drew before.
 */
/**
 * Refuse an operation whose Context plugin is switched off.
 *
 * One read of one small object, on the write paths only — the console's reads
 * are never gated, for the reason on `readImage`: a switch removes a capability
 * and must never start hiding content that is already there.
 *
 * The refusal names the plugin and where to undo it, like the gateway's, because
 * "that could not be saved" for a setting the reader themself chose is the
 * refusal with no next step that `report.js` rules out.
 */
export async function requireContextPlugin(
  store: FileStore,
  pluginId: string,
  pluginName: string,
): Promise<void> {
  const resolved = await resolveContextPlugins(store);
  const entry = resolved.plugins.find((plugin: { manifest: { id: string } }) =>
    plugin.manifest.id === pluginId,
  );
  if (entry && !entry.enabled) {
    throw new FileOpError(
      "PLUGIN_OFF",
      `${pluginName} is turned off in this context. An owner can turn it back on under Settings → Plugins.`,
    );
  }
}

export function contextPluginsResult(
  resolved: {
    plugins: Array<{ manifest: Record<string, any>; enabled: boolean }>;
    error: string | null;
  },
): Extract<OperationResult, { kind: "contextPlugins" }> {
  return {
    kind: "contextPlugins",
    plugins: resolved.plugins.map(({ manifest, enabled }) => ({
      id: String(manifest.id),
      name: String(manifest.name),
      description: String(manifest.description),
      version: String(manifest.version),
      author: String(manifest.author),
      enabled,
      defaultEnabled: manifest.context?.defaultEnabled !== false,
      tools: [...(manifest.context?.tools ?? [])].map(String),
      surfaces: [...(manifest.context?.surfaces ?? [])].map(String),
      offMeans: String(manifest.context?.offMeans ?? ""),
    })),
    settingsError: resolved.error ?? null,
  };
}

export function pluginSettingsKey(pluginId: string): string {
  if (
    pluginId.length === 0 ||
    pluginId.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(pluginId)
  ) {
    throw new FileOpError("PATH_INVALID", "That plugin id is not valid.");
  }
  return `.context/plugins/${encodeURIComponent(pluginId)}/data.json`;
}

export function managedPluginSegment(value: string, label: string): string {
  if (value.length === 0 || value.length > 300 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FileOpError("PATH_INVALID", `That plugin ${label} is not valid.`);
  }
  return encodeURIComponent(value);
}

export function managedPluginRoot(pluginId: string): string {
  return `.context/plugins/${managedPluginSegment(pluginId, "id")}`;
}

export function managedPointerGeneration(pointer: Record<string, unknown>): number {
  const generation = pointer.lifecycleGeneration;
  return Number.isSafeInteger(generation) && (generation as number) >= 0
    ? generation as number
    : 0;
}

export async function putImmutablePluginObject(store: FileStore, key: string, text: string): Promise<void> {
  const existing = await store.get(key);
  if (existing) {
    if (await existing.text() !== text) {
      throw new FileOpError("CONFLICT", "That plugin release already exists with different bytes.");
    }
    return;
  }
  if (store.capabilities?.conditionalCreate !== true) {
    throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely install plugins.");
  }
  const written = await store.put(key, text, { onlyIf: { absent: true } });
  if (written === null) {
    const raced = await store.get(key);
    if (!raced || await raced.text() !== text) {
      throw new FileOpError("CONFLICT", "That plugin release changed during installation.");
    }
  }
}

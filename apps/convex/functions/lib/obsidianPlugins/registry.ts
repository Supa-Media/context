/**
 * The community registry and the plugin releases it points at: bounded
 * fetches, identifier checks, capability and host normalisation, and the
 * grant summary a console is shown.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function; this module registers none.
 */

import type { Id } from "../../../_generated/dataModel";
import { pluginError } from "./access";
import {
  COMMUNITY_REGISTRY_URL,
  MAX_CAPABILITIES,
  MAX_NETWORK_HOSTS,
  MAX_REGISTRY_BYTES,
  NETWORK_REQUEST_TIMEOUT_MS,
} from "./limits";
import type { CommunityPlugin, GrantSummary, PluginCapability } from "./shapes";

export function normalizeCapabilities(values: PluginCapability[]): PluginCapability[] {
  if (values.length === 0 || values.length > MAX_CAPABILITIES) {
    throw pluginError("INVALID_CAPABILITIES", "Choose at least one valid capability");
  }
  return [...new Set(values)].sort();
}

export function normalizeHosts(values: string[]): string[] {
  if (values.length > MAX_NETWORK_HOSTS) {
    throw pluginError("INVALID_NETWORK_HOST", "Too many network hosts");
  }
  const hosts = values.map((value) => value.trim().toLowerCase());
  for (const host of hosts) {
    if (
      host.length === 0 ||
      host.length > 253 ||
      host.endsWith(".") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    ) {
      throw pluginError("INVALID_NETWORK_HOST", "Network grants require exact DNS hostnames");
    }
  }
  return [...new Set(hosts)].sort();
}

export function summary(row: {
  pluginId: string;
  bundleFingerprint: string;
  capabilities: PluginCapability[];
  networkHosts: string[];
  status: "active" | "revoked";
  grantedBy: Id<"users">;
  grantedAt: number;
  updatedAt: number;
  revokedAt?: number;
}): GrantSummary {
  return {
    pluginId: row.pluginId,
    bundleFingerprint: row.bundleFingerprint,
    capabilities: row.capabilities,
    networkHosts: row.networkHosts,
    status: row.status,
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  };
}

export function safeRuntimeText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, maximum) || undefined;
}

export function safePluginId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value)) {
    throw pluginError("INVALID_PLUGIN_ID", "That plugin id is not valid");
  }
  return value;
}

export function safeRepository(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw pluginError("INVALID_PLUGIN_REPOSITORY", "That plugin repository is not valid");
  }
  return value;
}

export function safePluginVersion(value: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(value)) {
    throw pluginError("INVALID_PLUGIN_VERSION", "That plugin version is not valid");
  }
  return value;
}

export async function fetchText(url: string, maximum: number, optional = false): Promise<string | null> {
  const response = await fetch(url, {
    headers: { accept: "application/json,text/plain,*/*" },
    signal: AbortSignal.timeout(NETWORK_REQUEST_TIMEOUT_MS),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw pluginError("PLUGIN_DOWNLOAD_FAILED", "The plugin could not be downloaded");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw pluginError("PLUGIN_DOWNLOAD_TOO_LARGE", "The plugin download is too large");
  }
  const bytes = new Uint8Array(await boundedDownload(response, maximum));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function boundedDownload(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw pluginError("PLUGIN_DOWNLOAD_TOO_LARGE", "The plugin download is too large");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

export async function communityRegistry(): Promise<CommunityPlugin[]> {
  const text = await fetchText(COMMUNITY_REGISTRY_URL, MAX_REGISTRY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text!);
  } catch {
    throw pluginError("PLUGIN_REGISTRY_INVALID", "The community plugin registry is invalid");
  }
  if (!Array.isArray(value)) {
    throw pluginError("PLUGIN_REGISTRY_INVALID", "The community plugin registry is invalid");
  }
  const plugins: CommunityPlugin[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    if (
      typeof item.id !== "string" || typeof item.name !== "string" ||
      typeof item.author !== "string" || typeof item.description !== "string" ||
      typeof item.repo !== "string"
    ) continue;
    try {
      plugins.push({
        id: safePluginId(item.id),
        name: item.name.slice(0, 200),
        author: item.author.slice(0, 200),
        description: item.description.slice(0, 1_000),
        repository: safeRepository(item.repo),
      });
    } catch {
      continue;
    }
  }
  return plugins;
}

export function parseReleaseManifest(text: string, expectedId: string): { id: string; version: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw pluginError("PLUGIN_RELEASE_INVALID", "The plugin manifest is invalid");
  }
  if (!value || typeof value !== "object") {
    throw pluginError("PLUGIN_RELEASE_INVALID", "The plugin manifest is invalid");
  }
  const row = value as Record<string, unknown>;
  if (row.id !== expectedId || typeof row.version !== "string") {
    throw pluginError("PLUGIN_RELEASE_INVALID", "The plugin manifest id or version does not match");
  }
  return { id: expectedId, version: row.version };
}

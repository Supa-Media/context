/**
 * The shapes plugin records and runtime requests travel in: capability, grant,
 * runtime-status and RPC validators, and the types the runtime broker speaks.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function; this module registers none.
 */

import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";

export const capabilityValidator = v.union(
  v.literal("vault:read"),
  v.literal("metadata:read"),
  v.literal("vault:write"),
  v.literal("vault:rename"),
  v.literal("vault:delete"),
  v.literal("settings:read"),
  v.literal("settings:write"),
  v.literal("network:request"),
);

export type PluginCapability =
  | "vault:read"
  | "metadata:read"
  | "vault:write"
  | "vault:rename"
  | "vault:delete"
  | "settings:read"
  | "settings:write"
  | "network:request";

export const grantSummaryValidator = v.object({
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  capabilities: v.array(capabilityValidator),
  networkHosts: v.array(v.string()),
  status: v.union(v.literal("active"), v.literal("revoked")),
  grantedBy: v.id("users"),
  grantedAt: v.number(),
  updatedAt: v.number(),
  revokedAt: v.optional(v.number()),
});

export const runtimeStatusValidator = v.object({
  pluginId: v.string(),
  bundleFingerprint: v.string(),
  status: v.union(v.literal("loaded"), v.literal("crash-looped"), v.literal("blocked")),
  attempts: v.number(),
  errorCode: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  rollbackFingerprint: v.optional(v.string()),
  updatedAt: v.number(),
});

export const pluginRpcResponseValidator = v.union(
  v.object({
    version: v.literal(1),
    requestId: v.string(),
    ok: v.literal(true),
    result: v.any(),
  }),
  v.object({
    version: v.literal(1),
    requestId: v.string(),
    ok: v.literal(false),
    error: v.object({ code: v.string(), message: v.string() }),
  }),
);

export type GrantSummary = {
  pluginId: string;
  bundleFingerprint: string;
  capabilities: PluginCapability[];
  networkHosts: string[];
  status: "active" | "revoked";
  grantedBy: Id<"users">;
  grantedAt: number;
  updatedAt: number;
  revokedAt?: number;
};

export const communityPluginValidator = v.object({
  id: v.string(),
  name: v.string(),
  author: v.string(),
  description: v.string(),
  repository: v.string(),
});

export type CommunityPlugin = {
  id: string;
  name: string;
  author: string;
  description: string;
  repository: string;
};

export type InventoryEntry = {
  source: "obsidian" | "context";
  id: string;
  version: string;
  bundleFingerprint: string | null;
  verdict: "runs" | "needs-approval" | "files-only" | "wont-run" | "unknown";
  hosts: string[];
};

export type InventoryResult = { kind: "pluginInventory"; plugins: InventoryEntry[] };
export type BundleResult = {
  kind: "pluginBundle";
  pluginId: string;
  version: string;
  bundleFingerprint: string;
  manifestJson: string;
  mainJs: string;
  stylesCss: string | null;
};

export type RpcOperation = {
  kind: string;
  path?: string;
  prefix?: string;
  text?: string;
  expectedEtag?: string | null;
  from?: string;
  to?: string;
  json?: string;
  url?: string;
  method?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: string;
};

export type PluginRpcResponse =
  | { version: 1; requestId: string; ok: true; result: unknown }
  | { version: 1; requestId: string; ok: false; error: { code: string; message: string } };

export type RuntimeStorageResult = {
  kind: string;
  path?: string;
  text?: string;
  etag?: string;
  [key: string]: unknown;
};

export type RuntimeStorageOperation =
  | { kind: "list"; path: string }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; text: string; expectedEtag?: string }
  | { kind: "pluginRename"; from: string; to: string; expectedEtag: string }
  | { kind: "pluginDelete"; path: string; expectedEtag: string }
  | { kind: "pluginSettingsRead"; pluginId: string }
  | { kind: "pluginSettingsWrite"; pluginId: string; json: string; expectedEtag: string | null };

export type EgressWireResponse = {
  ok?: unknown;
  status?: unknown;
  headers?: unknown;
  bodyBase64?: unknown;
  error?: { code?: unknown; message?: unknown };
};

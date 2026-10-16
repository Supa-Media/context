/**
 * The vault's shapes: what a sealed entry's meta holds, what a person is
 * shown of it, and the validators the barrier in `../vault.ts` checks them
 * with. No function here opens a key; `shownPin` only drops the single-use
 * grants a person is never shown.
 */

import { v } from "convex/values";
import type { Id } from "../../_generated/dataModel";

export type FieldSummary = { name: string; perEnv: boolean; set: string[] };
export type FieldValues = { name: string; perEnv: boolean; values: Record<string, string> };
export type EntryKind = "login" | "secret";
/** `meta.proxy`: the one website Context adds this key for (`apps/mcp/src/vault/proxy.js`). */
export type ProxyPin = { host: string; style: "bearer" | "header" | "query"; name?: string; ask: boolean };
/** The AIs a person said "Yes, from now on" to (`apps/mcp/src/vault/asks.js`). */
export type ProxyClient = { id: string; name: string | null; at: number };
export type StoredPin = ProxyPin & { clients?: ProxyClient[]; once?: { id: string; until: number }[] };

export type VaultMeta = {
  type?: EntryKind;
  fields?: FieldSummary[];
  name: string;
  sites: string[];
  people: string[];
  proxy?: StoredPin;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type RequestLabels = {
  workspace: { handle: string; name: string; kind: "personal" | "shared" } | null;
  grantee: string | null;
};
export type LiveRequest = { workspaceId: Id<"workspaces">; entryId: string | null; granteeUserId: Id<"users"> | null };
export type ShownMeta = {
  type: EntryKind;
  name: string;
  sites: string[];
  people: string[];
  fields: FieldSummary[];
  proxy?: ProxyPin & { clients?: ProxyClient[] };
};
export type Revealed = { username: string; password: string; fields: FieldValues[] };
export type Shown = { entryId: string; meta: ShownMeta; revealed?: Revealed };
export type Listed = { entries: { entryId: string; meta: ShownMeta }[] };
export type RequestKind = "add" | "share" | "view";
export type Described = {
  kind: RequestKind;
  workspace: { handle: string; name: string; kind: "personal" | "shared" };
  grantee: string | null;
  entry: { type: EntryKind; name: string; sites: string[]; fields: FieldSummary[] } | null;
  expiresAt: number;
};

export const kindValidator = v.union(v.literal("add"), v.literal("share"), v.literal("view"));
export const fieldSummaryValidator = v.object({ name: v.string(), perEnv: v.boolean(), set: v.array(v.string()) });
export const fieldValuesValidator = v.object({ name: v.string(), perEnv: v.boolean(), values: v.record(v.string(), v.string()) });

export const proxyStyleValidator = v.union(v.literal("bearer"), v.literal("header"), v.literal("query"));
export const proxyPinValidator = v.object({ host: v.string(), style: proxyStyleValidator, name: v.optional(v.string()), ask: v.boolean() });

export const operationValidator = v.union(
  v.object({ kind: v.literal("meta"), entryId: v.string() }),
  v.object({
    kind: v.literal("add"),
    entryId: v.string(),
    userId: v.string(),
    type: v.union(v.literal("login"), v.literal("secret")),
    name: v.string(),
    sites: v.array(v.string()),
    username: v.string(),
    password: v.string(),
    fields: v.array(fieldValuesValidator),
    proxy: v.optional(proxyPinValidator),
  }),
  v.object({ kind: v.literal("share"), entryId: v.string(), userId: v.string(), granteeUserId: v.string() }),
  v.object({ kind: v.literal("reveal"), entryId: v.string(), userId: v.string() }),
  v.object({ kind: v.literal("list"), userId: v.string() }),
  // Cut one AI off a key, or every AI when `clientId` is absent.
  v.object({ kind: v.literal("cut"), entryId: v.string(), userId: v.string(), clientId: v.optional(v.string()) }),
);

export const proxyClientValidator = v.object({ id: v.string(), name: v.union(v.string(), v.null()), at: v.number() });
export const shownPinValidator = v.object({
  host: v.string(),
  style: proxyStyleValidator,
  name: v.optional(v.string()),
  ask: v.boolean(),
  clients: v.optional(v.array(proxyClientValidator)),
});
export const metaValidator = v.object({
  type: v.union(v.literal("login"), v.literal("secret")),
  name: v.string(),
  sites: v.array(v.string()),
  people: v.array(v.string()),
  fields: v.array(fieldSummaryValidator),
  proxy: v.optional(shownPinValidator),
});
export const revealedValidator = v.object({ username: v.string(), password: v.string(), fields: v.array(fieldValuesValidator) });

/** A pin as a person may see it: the "just this once" grants stay inside the key. */
export function shownPin(pin: StoredPin): ProxyPin & { clients?: ProxyClient[] } {
  return {
    host: pin.host,
    style: pin.style,
    ...(pin.name === undefined ? {} : { name: pin.name }),
    ask: pin.ask,
    ...(pin.clients && pin.clients.length > 0 ? { clients: pin.clients } : {}),
  };
}

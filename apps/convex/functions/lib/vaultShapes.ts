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
export type ProxyPin = { host: string; style: "bearer" | "header" | "query"; name?: string; prefix?: string; ask: boolean };
/** The AIs a person said "Yes, from now on" to (`apps/mcp/src/vault/asks.js`). */
export type ProxyClient = { id: string; name: string | null; at: number };
/** Each AI's count and last call, and the AIs the person said no to (`apps/mcp/src/vault/usage.js`). */
export type ProxyUse = { id: string; name: string | null; count: number; at: number; method: string; path: string };
export type ProxyRefusal = { id: string; name: string | null; at: number };
type PinHistory = { clients?: ProxyClient[]; uses?: ProxyUse[]; refused?: ProxyRefusal[] };
export type StoredPin = ProxyPin & PinHistory & { once?: { id: string; until: number }[] };

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
  proxy?: ProxyPin & PinHistory;
  createdBy: string;
  createdAt: number;
};
export type Revealed = { username: string; password: string; fields: FieldValues[] };
/** `changed`: after an edit, the names of what changed ("username", "password", a field's name). Never a value. */
export type Shown = { entryId: string; meta: ShownMeta; revealed?: Revealed; changed?: string[] };
/** `waiting`: entry id → how many AIs wait on a first-use ask from this person now. */
export type Listed = { entries: { entryId: string; meta: ShownMeta }[]; waiting: Record<string, number> };
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
export const proxyPinValidator = v.object({
  host: v.string(),
  style: proxyStyleValidator,
  name: v.optional(v.string()),
  prefix: v.optional(v.string()),
  ask: v.boolean(),
});

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
  // "Allow" on an AI the person said no to: it joins the AIs that may use the key.
  v.object({ kind: v.literal("allow"), entryId: v.string(), userId: v.string(), clientId: v.string() }),
  // A key's values changed in place in Settings › Vault. `anyKey`: an owner or
  // editor, who may change any key given to them; anyone else only their own.
  v.object({
    kind: v.literal("edit"),
    entryId: v.string(),
    userId: v.string(),
    anyKey: v.boolean(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    fields: v.optional(v.array(fieldValuesValidator)),
    name: v.optional(v.string()),
    /** The site Tex fills it on, a checked host, or "" for none. */
    site: v.optional(v.string()),
    /** The checked pin it is only ever sent to, or null to stop AIs using it. */
    proxy: v.optional(v.union(proxyPinValidator, v.null())),
  }),
  // Delete a key, with the same say as `edit`.
  v.object({ kind: v.literal("delete"), entryId: v.string(), userId: v.string(), anyKey: v.boolean() }),
);

export const proxyClientValidator = v.object({ id: v.string(), name: v.union(v.string(), v.null()), at: v.number() });
export const proxyUseValidator = v.object({
  id: v.string(),
  name: v.union(v.string(), v.null()),
  count: v.number(),
  at: v.number(),
  method: v.string(),
  path: v.string(),
});
export const shownPinValidator = v.object({
  host: v.string(),
  style: proxyStyleValidator,
  name: v.optional(v.string()),
  prefix: v.optional(v.string()),
  ask: v.boolean(),
  clients: v.optional(v.array(proxyClientValidator)),
  uses: v.optional(v.array(proxyUseValidator)),
  refused: v.optional(v.array(proxyClientValidator)),
});
export const metaValidator = v.object({
  type: v.union(v.literal("login"), v.literal("secret")),
  name: v.string(),
  sites: v.array(v.string()),
  people: v.array(v.string()),
  fields: v.array(fieldSummaryValidator),
  proxy: v.optional(shownPinValidator),
  createdBy: v.string(),
  createdAt: v.number(),
});
export const revealedValidator = v.object({ username: v.string(), password: v.string(), fields: v.array(fieldValuesValidator) });

/**
 * A pin as a person may see it: the "just this once" grants stay inside the
 * key, and the history is passed on only in the shape it was written in.
 */
export function shownPin(pin: StoredPin): ProxyPin & PinHistory {
  const uses = (pin.uses ?? []).filter(
    (use) => typeof use?.id === "string" && Number.isFinite(use.count) && Number.isFinite(use.at),
  );
  const refused = (pin.refused ?? []).filter((no) => typeof no?.id === "string" && Number.isFinite(no.at));
  return {
    host: pin.host,
    style: pin.style,
    ...(pin.name === undefined ? {} : { name: pin.name }),
    ...(pin.prefix === undefined ? {} : { prefix: pin.prefix }),
    ask: pin.ask,
    ...(pin.clients && pin.clients.length > 0 ? { clients: pin.clients } : {}),
    ...(uses.length > 0
      ? {
          uses: uses.map((use) => ({
            id: use.id,
            name: typeof use.name === "string" ? use.name : null,
            count: use.count,
            at: use.at,
            method: typeof use.method === "string" ? use.method : "GET",
            path: typeof use.path === "string" ? use.path : "/",
          })),
        }
      : {}),
    ...(refused.length > 0
      ? { refused: refused.map((no) => ({ id: no.id, name: typeof no.name === "string" ? no.name : null, at: no.at })) }
      : {}),
  };
}

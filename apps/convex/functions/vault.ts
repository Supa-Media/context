/**
 * The vault's human half: saving, sharing and seeing logins and secrets, on
 * signed-in pages.
 *
 * An agent can ask for a link (`/gateway/vault/request`) and nothing else.
 * Every change to a vault happens here, in an action a signed-in person
 * calls from `/vault/<token>`, after this checks that the person is the one
 * whose grant asked. So an agent, however it is steered, cannot save, change
 * or share a login: it can only hand the person a page where they do
 * (decided by the owner, 2026-10-10;
 * `docs/decisions/texting-assistant/vault.md`).
 *
 * The login is sealed with the workspace data key and written to the
 * workspace's own bucket (`apps/mcp/src/vault/`). This file holds no part of
 * one: a request row is ids and times, and an agent's suggested name and site
 * ride on the link's URL.
 *
 * ## The credential barrier
 *
 * `runVaultOperation` is the vault's barrier, pinned in
 * `__tests__/structure/analyzer/pins.helpers.ts`. It opens the bucket
 * credential and the data key, does one operation, and returns only what
 * that operation shows a person: an entry's name, sites, people and field
 * names. The one operation that opens a secret part is `reveal`, and its only
 * caller is `revealVaultEntry`, which answers the signed-in person on the
 * entry's people list who asked for that page; no gateway route and no tool
 * reaches it (decided by the owner, 2026-10-10: API keys and env variables a
 * person can see and copy).
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v, type Infer } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { hashToken } from "./lib/crypto";
import { consumeRateLimit } from "./lib/rateLimit";
import { getMembership } from "./lib/workspaceAuth";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import {
  MAX_NAME,
  MAX_SECRET,
  mayUse,
  newEntryId,
  isEntryId,
  listMeta,
  readMeta,
  readSecret,
  siteHost,
  writeEntry,
  writeMeta,
} from "../../mcp/src/vault/entries.js";
import { entryType, fieldSummaries, normalizeFields } from "../../mcp/src/vault/fields.js";
import { savedPin } from "../../mcp/src/vault/proxy.js";
import {
  fieldSummaryValidator,
  fieldValuesValidator,
  kindValidator,
  metaValidator,
  operationValidator,
  proxyClientValidator,
  proxyPinValidator,
  proxyStyleValidator,
  revealedValidator,
  shownPinValidator,
  shownPin,
  type Described,
  type EntryKind,
  type FieldSummary,
  type FieldValues,
  type LiveRequest,
  type ProxyClient,
  type ProxyPin,
  type RequestKind,
  type RequestLabels,
  type Revealed,
  type StoredPin,
  type VaultMeta,
  type Listed,
  type Shown,
  type ShownMeta,
} from "./lib/vaultShapes";
export type { Listed, Shown, ShownMeta } from "./lib/vaultShapes";

export const VAULT_LINK_TTL_MS = 30 * 60 * 1000;
const REQUEST_LIMIT = 20;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;



function fail(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

const dead = () => fail("VAULT_LINK_DEAD", "This link has expired or was already used. Ask Tex for a new one.");
const notYours = () =>
  fail("VAULT_LINK_NOT_YOURS", "This link is for a different account. Sign in as the person who asked for it.");

/* ------------------------------ agent requests ----------------------------- */

/**
 * Record one request for a cleared gateway caller. INTERNAL; the route has
 * already spent both proofs and passes the workspace and person off the grant.
 */
export const issueVaultRequest = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    kind: kindValidator,
    entryId: v.optional(v.string()),
    handle: v.optional(v.string()),
    hashedToken: v.string(),
  },
  returns: v.union(v.literal("issued"), v.literal("refused")),
  handler: async (ctx, args): Promise<"issued" | "refused"> => {
    await consumeRateLimit(ctx, {
      key: `vault.request:${args.userId}`,
      limit: REQUEST_LIMIT,
      windowMs: REQUEST_WINDOW_MS,
    });
    let granteeUserId: Id<"users"> | undefined;
    if (args.kind === "share") {
      const workspace = await ctx.db.get(args.workspaceId);
      if (workspace === null || workspace.kind !== "shared") return "refused";
      if (!isEntryId(args.entryId) || typeof args.handle !== "string") return "refused";
      const name = await ctx.db
        .query("names")
        .withIndex("by_name", (q) => q.eq("name", args.handle!.toLowerCase()))
        .unique();
      if (name?.kind !== "user" || name.userId === undefined || name.userId === args.userId) return "refused";
      if ((await getMembership(ctx, args.workspaceId, name.userId)) === null) return "refused";
      granteeUserId = name.userId;
    }
    if (args.kind === "view" && !isEntryId(args.entryId)) return "refused";
    await ctx.db.insert("vaultRequests", {
      hashedToken: args.hashedToken,
      workspaceId: args.workspaceId,
      userId: args.userId,
      kind: args.kind,
      ...(args.kind === "share" ? { entryId: args.entryId, granteeUserId } : {}),
      ...(args.kind === "view" ? { entryId: args.entryId } : {}),
      expiresAt: Date.now() + VAULT_LINK_TTL_MS,
    });
    return "issued";
  },
});

export const requestByHash = internalQuery({
  args: { hashedToken: v.string() },
  handler: async (ctx, args): Promise<Doc<"vaultRequests"> | null> =>
    await ctx.db
      .query("vaultRequests")
      .withIndex("by_hashed_token", (q) => q.eq("hashedToken", args.hashedToken))
      .unique(),
});

/** Names for the page: the workspace's handle and kind, and the grantee's handle. */
export const requestLabels = internalQuery({
  args: { workspaceId: v.id("workspaces"), granteeUserId: v.optional(v.id("users")) },
  handler: async (ctx, args): Promise<RequestLabels> => {
    const workspace = await ctx.db.get(args.workspaceId);
    let grantee: string | null = null;
    if (args.granteeUserId !== undefined) {
      const row = await ctx.db
        .query("names")
        .withIndex("by_user", (q) => q.eq("userId", args.granteeUserId))
        .first();
      grantee = row?.name ?? null;
    }
    return {
      workspace: workspace === null ? null : { handle: workspace.slug, name: workspace.displayName, kind: workspace.kind },
      grantee,
    };
  },
});

const requestCheckArgs = {
  hashedToken: v.string(),
  userId: v.id("users"),
  kind: v.union(v.literal("add"), v.literal("share")),
};

/**
 * The request row, if it is live, unused, of this kind and this person's, and
 * for a share the grantee is still a member. Throws the page's own codes.
 */
async function liveRequest(
  ctx: MutationCtx,
  args: { hashedToken: string; userId: Id<"users">; kind: "add" | "share" },
): Promise<Doc<"vaultRequests">> {
  const row = await ctx.db
    .query("vaultRequests")
    .withIndex("by_hashed_token", (q) => q.eq("hashedToken", args.hashedToken))
    .unique();
  if (row === null || row.usedAt !== undefined || row.expiresAt <= Date.now() || row.kind !== args.kind) {
    throw dead();
  }
  if (row.userId !== args.userId) throw notYours();
  if ((await getMembership(ctx, row.workspaceId, args.userId)) === null) throw dead();
  if (row.kind === "share" && (row.granteeUserId === undefined || (await getMembership(ctx, row.workspaceId, row.granteeUserId)) === null)) {
    throw dead();
  }
  return row;
}

/**
 * Before the write: is the link still good? Spends nothing, so a write that
 * fails leaves the person the same link to try again with.
 *
 * Saving and sharing check, write, then spend (`consumeVaultRequest`), rather
 * than spend first and un-spend on a throw: a rollback has to run to save the
 * link, and an action that dies mid-write never reaches its `catch`, so the
 * person is back to a spent link and nothing saved. Spending last cannot
 * strand a link that way, and the spend is one transaction that re-checks
 * `usedAt`, so two writes that race still spend it once.
 *
 * An add link also gets its entry id here, once: the first caller's
 * `candidateEntryId` is kept on the row and every later caller is handed that
 * one. So a retry after a write that landed but was never spent, or a second
 * tap racing the first, rewrites the same entry instead of leaving a
 * duplicate nobody can delete yet. An entry id is an id like the rest of the
 * row, and names nothing of a login.
 */
export const checkVaultRequest = internalMutation({
  args: { ...requestCheckArgs, candidateEntryId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<LiveRequest> => {
    const row = await liveRequest(ctx, args);
    let entryId = row.entryId ?? null;
    if (row.kind === "add" && entryId === null) {
      if (!isEntryId(args.candidateEntryId)) throw fail("INVALID_ARGUMENT", "Missing entry id.");
      entryId = args.candidateEntryId as string;
      await ctx.db.patch(row._id, { entryId });
    }
    return { workspaceId: row.workspaceId, entryId, granteeUserId: row.granteeUserId ?? null };
  },
});

/**
 * Spend a request, after its write landed. Same checks as before the write,
 * again, in one transaction: of two saves that both wrote, exactly one spends
 * the link and the other is told it was used.
 */
export const consumeVaultRequest = internalMutation({
  args: requestCheckArgs,
  handler: async (ctx, args): Promise<LiveRequest> => {
    const row = await liveRequest(ctx, args);
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    return { workspaceId: row.workspaceId, entryId: row.entryId ?? null, granteeUserId: row.granteeUserId ?? null };
  },
});

/**
 * A view link is not spent: the person may reveal, copy and come back to it
 * while it lives. It must be live and theirs, and they must still be a member.
 */
export const liveViewRequest = internalQuery({
  args: { hashedToken: v.string(), userId: v.id("users") },
  handler: async (ctx, args): Promise<{ workspaceId: Id<"workspaces">; entryId: string }> => {
    const row = await ctx.db
      .query("vaultRequests")
      .withIndex("by_hashed_token", (q) => q.eq("hashedToken", args.hashedToken))
      .unique();
    if (row === null || row.kind !== "view" || row.expiresAt <= Date.now() || row.entryId === undefined) throw dead();
    if (row.userId !== args.userId) throw notYours();
    if ((await getMembership(ctx, row.workspaceId, args.userId)) === null) throw dead();
    return { workspaceId: row.workspaceId, entryId: row.entryId };
  },
});

export const recordVaultAudit = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    action: v.union(v.literal("vault.saved"), v.literal("vault.shared"), v.literal("vault.viewed"), v.literal("vault.cut_off")),
    entryId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: args.action,
      paths: [`.context/vault/${args.entryId}.json`],
    });
    return null;
  },
});

export const purgeExpiredVaultRequests = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const expired = await ctx.db
      .query("vaultRequests")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(500);
    for (const row of expired) await ctx.db.delete(row._id);
    return null;
  },
});

/* --------------------------------- barrier -------------------------------- */


/**
 * CREDENTIAL BARRIER. Opens one workspace's bucket and data key, does one
 * vault operation, and returns an entry's id, name, sites, people and field
 * names, and for `reveal` alone its values. INTERNAL: reached only from the
 * public actions below, after they checked the person.
 */
export const runVaultOperation = internalAction({
  args: { workspaceId: v.id("workspaces"), operation: operationValidator },
  returns: v.union(
    v.null(),
    v.object({ entryId: v.string(), meta: metaValidator, revealed: v.optional(revealedValidator) }),
    v.object({ entries: v.array(v.object({ entryId: v.string(), meta: metaValidator })) }),
  ),
  handler: async (ctx, args): Promise<Shown | Listed | null> => {
    const credential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
      workspaceId: args.workspaceId,
    });
    if (credential === null) throw fail("VAULT_NO_STORAGE", "This workspace has no storage connected yet.");
    const managedEncryption = await managedEncryptionOption(ctx, args.workspaceId);
    const store = storeForBinding(credential, undefined, { managedEncryption });
    const keys = await ctx.runAction(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId: args.workspaceId,
      create: args.operation.kind === "add",
    });
    if (keys === null) return null;
    const workspaceId = String(args.workspaceId);
    const shown = (entryId: string, meta: VaultMeta): Shown => ({
      entryId,
      meta: {
        type: entryType(meta) as EntryKind,
        name: meta.name,
        sites: meta.sites ?? [],
        people: meta.people,
        fields: Array.isArray(meta.fields) ? meta.fields : [],
        ...(meta.proxy ? { proxy: shownPin(meta.proxy) } : {}),
      },
    });
    const op = args.operation;
    if (op.kind === "list") {
      const all = (await listMeta(store, keys, workspaceId)) as { id: string; meta: VaultMeta }[];
      return { entries: all.filter((entry) => mayUse(entry.meta, op.userId)).map((entry) => shown(entry.id, entry.meta)) };
    }
    if (op.kind === "cut") {
      const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
      if (meta === null || !mayUse(meta, op.userId)) return null;
      if (meta.proxy) {
        const keep = (id: string) => op.clientId !== undefined && id !== op.clientId;
        meta.proxy = {
          ...meta.proxy,
          clients: (meta.proxy.clients ?? []).filter((client) => keep(client.id)),
          once: (meta.proxy.once ?? []).filter((grant) => keep(grant.id)),
        };
        meta.updatedAt = Date.now();
        await writeMeta(store, keys, workspaceId, op.entryId, meta);
      }
      return shown(op.entryId, meta);
    }
    if (op.kind === "meta") {
      const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
      return meta === null ? null : shown(op.entryId, meta);
    }
    if (op.kind === "add") {
      // The id the link reserved (`checkVaultRequest`), so a retry rewrites one
      // entry. Only ever this person's own earlier try: an add that named
      // anybody else's entry would be a way to overwrite it and its people.
      const id = op.entryId;
      if (!isEntryId(id)) throw fail("INVALID_ARGUMENT", "Missing entry id.");
      const earlier = (await readMeta(store, keys, workspaceId, id)) as VaultMeta | null;
      if (earlier !== null && earlier.createdBy !== op.userId) throw dead();
      const now = Date.now();
      const meta: VaultMeta = {
        type: op.type,
        name: op.name,
        sites: op.sites,
        fields: fieldSummaries(op.fields) as FieldSummary[],
        ...(op.proxy === undefined ? {} : { proxy: op.proxy }),
        people: [op.userId],
        createdBy: op.userId,
        createdAt: now,
        updatedAt: now,
      };
      const secret = op.type === "login" ? { username: op.username, password: op.password, fields: op.fields } : { fields: op.fields };
      await writeEntry(store, keys, workspaceId, { id, meta, secret });
      return shown(id, meta);
    }
    if (op.kind === "reveal") {
      const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
      if (meta === null || !mayUse(meta, op.userId)) return null;
      const secret = (await readSecret(store, keys, workspaceId, op.entryId)) as Partial<Revealed> | null;
      return {
        ...shown(op.entryId, meta),
        revealed: {
          username: typeof secret?.username === "string" ? secret.username : "",
          password: typeof secret?.password === "string" ? secret.password : "",
          fields: Array.isArray(secret?.fields) ? secret.fields : [],
        },
      };
    }
    const meta = (await readMeta(store, keys, workspaceId, op.entryId)) as VaultMeta | null;
    if (meta === null || !mayUse(meta, op.userId)) return null;
    if (!meta.people.includes(op.granteeUserId)) {
      meta.people = [...meta.people, op.granteeUserId];
      meta.updatedAt = Date.now();
      await writeMeta(store, keys, workspaceId, op.entryId, meta);
    }
    return shown(op.entryId, meta);
  },
});


/* ------------------------------ signed-in pages ---------------------------- */

async function signedIn(ctx: Parameters<typeof getAuthUserId>[0]): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw fail("NOT_AUTHENTICATED", "Sign in to continue.");
  return userId as Id<"users">;
}

function checkToken(token: string): void {
  if (typeof token !== "string" || token.length === 0 || token.length > 128) throw dead();
}

/**
 * The barrier, from a signed-in page. Its own refusals (`VAULT_NO_STORAGE`,
 * a bad id) pass through; anything else is the bucket or the key service
 * failing, which the page hears as `VAULT_STORAGE_FAILED` in `message`'s
 * words. Never the store's own error text, which can name an endpoint or a
 * bucket. Every caller runs this before spending a link, so the link it
 * names is still good to try again.
 */
async function openVault(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  operation: Infer<typeof operationValidator>,
  message: string,
): Promise<Shown | null> {
  return (await runVault(ctx, workspaceId, operation, message)) as Shown | null;
}

/** `openVault` for any operation, `list` included; `vaultSettings.ts` reaches the barrier through it. */
export async function runVault(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  operation: Infer<typeof operationValidator>,
  message: string,
): Promise<Shown | Listed | null> {
  try {
    return await ctx.runAction(internal.functions.vault.runVaultOperation, { workspaceId, operation });
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    // Ids and the operation's kind only: never the error text, never a value.
    console.warn(JSON.stringify({ event: "vault.storage_failed", workspaceId, operation: operation.kind }));
    throw fail("VAULT_STORAGE_FAILED", message);
  }
}

/** What `/vault/<token>` shows before the person does anything. Never a value. */
export const describeVaultRequest = action({
  args: { token: v.string() },
  returns: v.object({
    kind: kindValidator,
    workspace: v.object({ handle: v.string(), name: v.string(), kind: v.union(v.literal("personal"), v.literal("shared")) }),
    grantee: v.union(v.null(), v.string()),
    entry: v.union(
      v.null(),
      v.object({
        type: v.union(v.literal("login"), v.literal("secret")),
        name: v.string(),
        sites: v.array(v.string()),
        fields: v.array(fieldSummaryValidator),
      }),
    ),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args): Promise<Described> => {
    const userId = await signedIn(ctx);
    checkToken(args.token);
    const row = await ctx.runQuery(internal.functions.vault.requestByHash, { hashedToken: await hashToken(args.token) });
    if (row === null || row.usedAt !== undefined || row.expiresAt <= Date.now()) throw dead();
    if (row.userId !== userId) throw notYours();
    const labels = await ctx.runQuery(internal.functions.vault.requestLabels, {
      workspaceId: row.workspaceId,
      ...(row.granteeUserId === undefined ? {} : { granteeUserId: row.granteeUserId }),
    });
    if (labels.workspace === null) throw dead();
    let entry: Described["entry"] = null;
    if (row.kind !== "add") {
      const opened = await openVault(
        ctx,
        row.workspaceId,
        { kind: "meta", entryId: row.entryId ?? "" },
        "Your workspace's storage didn't answer. Reload this page to try again.",
      );
      if (opened === null || !mayUse(opened.meta, userId)) throw dead();
      entry = { type: opened.meta.type, name: opened.meta.name, sites: opened.meta.sites, fields: opened.meta.fields };
    }
    return { kind: row.kind, workspace: labels.workspace, grantee: labels.grantee, entry, expiresAt: row.expiresAt };
  },
});

/**
 * Save a login or a secret the person typed. Never logged, never stored
 * outside the bucket. `type` and `fields` are optional so a page from before
 * secrets existed still saves a plain login.
 */
export const saveVaultLogin = action({
  args: {
    token: v.string(),
    type: v.optional(v.union(v.literal("login"), v.literal("secret"))),
    name: v.string(),
    site: v.string(),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    fields: v.optional(v.array(fieldValuesValidator)),
    /** "Let my AIs use it, never shown the key": the one website, and how it wants the key. */
    proxy: v.optional(v.object({ host: v.string(), style: proxyStyleValidator, name: v.optional(v.string()), ask: v.boolean() })),
  },
  returns: v.object({ name: v.string(), site: v.string() }),
  handler: async (ctx, args): Promise<{ name: string; site: string }> => {
    const userId = await signedIn(ctx);
    checkToken(args.token);
    const type: EntryKind = args.type ?? "login";
    const name = args.name.trim();
    const username = args.username ?? "";
    const password = args.password ?? "";
    const site = args.site.trim() === "" && type === "secret" ? "" : siteHost(args.site);
    if (name.length === 0 || name.length > MAX_NAME) throw fail("INVALID_ARGUMENT", "Give it a short name.");
    if (site === null) throw fail("INVALID_ARGUMENT", "Enter the site's address, like netflix.com.");
    const normalized = normalizeFields(args.fields);
    if (normalized.error !== null) throw fail("INVALID_ARGUMENT", `Check the fields: ${normalized.error}.`);
    const fields = normalized.fields as FieldValues[];
    if (type === "login" && password.length === 0) throw fail("INVALID_ARGUMENT", "Enter the password.");
    if (type === "secret" && !fields.some((field) => Object.keys(field.values).length > 0)) {
      throw fail("INVALID_ARGUMENT", "Add at least one value.");
    }
    if (username.length > MAX_SECRET || password.length > MAX_SECRET) {
      throw fail("INVALID_ARGUMENT", "That is longer than a login can be.");
    }
    let proxy: ProxyPin | undefined;
    if (args.proxy !== undefined) {
      if (type !== "secret") throw fail("INVALID_ARGUMENT", "Only an API key or secret can be used by your AIs this way.");
      const checked = savedPin(args.proxy) as { pin?: ProxyPin; problem?: string };
      if (checked.pin === undefined) throw fail("INVALID_ARGUMENT", checked.problem ?? "Check the website.");
      proxy = checked.pin;
    }
    // Check, write, then spend: see `checkVaultRequest` and `consumeVaultRequest`.
    const hashedToken = await hashToken(args.token);
    const live = await ctx.runMutation(internal.functions.vault.checkVaultRequest, {
      hashedToken,
      userId,
      kind: "add",
      candidateEntryId: newEntryId(),
    });
    if (live.entryId === null) throw dead();
    const saved = await openVault(
      ctx,
      live.workspaceId,
      { kind: "add", entryId: live.entryId, userId, type, name, sites: site ? [site] : [], username, password, fields, ...(proxy ? { proxy } : {}) },
      "That wasn't saved: your workspace's storage didn't take it.",
    );
    if (saved === null) throw fail("KEY_UNAVAILABLE", "This workspace's vault can't be opened right now.");
    await ctx.runMutation(internal.functions.vault.consumeVaultRequest, { hashedToken, userId, kind: "add" });
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: live.workspaceId,
      actorUserId: userId,
      action: "vault.saved",
      entryId: saved.entryId,
    });
    return { name, site };
  },
});

/**
 * Show the person one entry's values: the only door from a sealed secret part
 * to a person's eyes. The signed-in person who asked, on the entry's people
 * list, while the link lives. Each look is audited.
 */
export const revealVaultEntry = action({
  args: { token: v.string() },
  returns: v.object({
    type: v.union(v.literal("login"), v.literal("secret")),
    name: v.string(),
    sites: v.array(v.string()),
    username: v.string(),
    password: v.string(),
    fields: v.array(fieldValuesValidator),
  }),
  handler: async (ctx, args): Promise<{ type: EntryKind; name: string; sites: string[] } & Revealed> => {
    const userId = await signedIn(ctx);
    checkToken(args.token);
    const live = await ctx.runQuery(internal.functions.vault.liveViewRequest, {
      hashedToken: await hashToken(args.token),
      userId,
    });
    const opened = await openVault(
      ctx,
      live.workspaceId,
      { kind: "reveal", entryId: live.entryId, userId },
      "Your workspace's storage didn't answer. Try again.",
    );
    if (opened === null || opened.revealed === undefined) throw dead();
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: live.workspaceId,
      actorUserId: userId,
      action: "vault.viewed",
      entryId: live.entryId,
    });
    return { type: opened.meta.type, name: opened.meta.name, sites: opened.meta.sites, ...opened.revealed };
  },
});

/** Give one login to the member the request names. The person's tap is the consent. */
export const confirmVaultShare = action({
  args: { token: v.string() },
  returns: v.object({ name: v.string(), grantee: v.union(v.null(), v.string()) }),
  handler: async (ctx, args): Promise<{ name: string; grantee: string | null }> => {
    const userId = await signedIn(ctx);
    checkToken(args.token);
    // Check, write, then spend. Adding a name to the people list is idempotent,
    // so a retry or a racing second tap writes the same meta.
    const hashedToken = await hashToken(args.token);
    const live = await ctx.runMutation(internal.functions.vault.checkVaultRequest, { hashedToken, userId, kind: "share" });
    if (live.entryId === null || live.granteeUserId === null) throw dead();
    const shared = await openVault(
      ctx,
      live.workspaceId,
      { kind: "share", entryId: live.entryId, userId, granteeUserId: live.granteeUserId },
      "That wasn't shared: your workspace's storage didn't take it.",
    );
    if (shared === null) throw dead();
    await ctx.runMutation(internal.functions.vault.consumeVaultRequest, { hashedToken, userId, kind: "share" });
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: live.workspaceId,
      actorUserId: userId,
      action: "vault.shared",
      entryId: live.entryId,
    });
    const labels = await ctx.runQuery(internal.functions.vault.requestLabels, {
      workspaceId: live.workspaceId,
      granteeUserId: live.granteeUserId,
    });
    return { name: shared.meta.name, grantee: labels.grantee };
  },
});

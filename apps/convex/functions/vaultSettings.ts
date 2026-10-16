/**
 * Settings › Vault (vault board 2): the keys a signed-in person may use in
 * one workspace, the one website each goes to, the AIs they said yes to, and
 * Cut off. Every read and change goes through the vault's barrier
 * (`runVaultOperation` in `vault.ts`), which never returns a value here: a
 * key's values are seen and changed only through a fresh view link, opened in
 * place in Settings.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { workspaceNotFound } from "./lib/workspaceAuth";
import { MAX_NAME, MAX_SECRET, isEntryId, siteHost } from "../../mcp/src/vault/entries.js";
import { savedPin } from "../../mcp/src/vault/proxy.js";
import { normalizeFields } from "../../mcp/src/vault/fields.js";
import { fieldValuesValidator, proxyPinValidator, type FieldValues, type ProxyPin } from "./lib/vaultShapes";
import { runVault, type Listed, type Shown, type ShownMeta } from "./vault";

const fail = (code: string, message: string) => new ConvexError({ code, message });
const linkDead = () => fail("VAULT_LINK_DEAD", "This link has expired or was already used. Ask Tex for a new one.");

const clientValidator = v.object({ id: v.string(), name: v.union(v.string(), v.null()), at: v.number() });
const useValidator = v.object({
  id: v.string(),
  name: v.union(v.string(), v.null()),
  count: v.number(),
  at: v.number(),
  method: v.string(),
  path: v.string(),
});
const styleValidator = v.union(v.literal("bearer"), v.literal("header"), v.literal("query"));
const entryValidator = v.object({
  entryId: v.string(),
  type: v.union(v.literal("login"), v.literal("secret")),
  name: v.string(),
  sites: v.array(v.string()),
  envs: v.array(v.string()),
  shared: v.boolean(),
  proxy: v.union(
    v.null(),
    v.object({
      host: v.string(),
      style: styleValidator,
      name: v.union(v.string(), v.null()),
      /** A named header's word before the key ("Convex"), or null. */
      prefix: v.union(v.string(), v.null()),
      ask: v.boolean(),
      clients: v.array(clientValidator),
      uses: v.array(useValidator),
      refused: v.array(clientValidator),
      /** How many AIs wait on a first-use ask from this person now. */
      waiting: v.number(),
    }),
  ),
  /** When it was saved, and whether by the person reading. */
  savedAt: v.number(),
  savedByYou: v.boolean(),
});
type Entry = typeof entryValidator.type;

function entryFrom(entryId: string, meta: ShownMeta, userId: string, waiting = 0): Entry {
  const envs = new Set<string>();
  for (const field of meta.fields) for (const env of field.set) if (env !== "_") envs.add(env);
  return {
    entryId,
    type: meta.type,
    name: meta.name,
    sites: meta.sites,
    envs: ["dev", "staging", "prod"].filter((env) => envs.has(env)),
    shared: meta.people.length > 1,
    proxy: meta.proxy
      ? {
          host: meta.proxy.host,
          style: meta.proxy.style,
          name: meta.proxy.name ?? null,
          prefix: meta.proxy.prefix ?? null,
          ask: meta.proxy.ask,
          clients: meta.proxy.clients ?? [],
          uses: meta.proxy.uses ?? [],
          refused: meta.proxy.refused ?? [],
          waiting,
        }
      : null,
    savedAt: meta.createdAt,
    savedByYou: meta.createdBy === userId,
  };
}

async function signedInMember(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<{ userId: Id<"users">; role: "owner" | "editor" | "member" }> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw fail("NOT_AUTHENTICATED", "Sign in to continue.");
  const membership = await ctx.runQuery(internal.functions.contextPlugins.membershipFor, { workspaceId, userId });
  // A workspace this person is not in reads as one that does not exist.
  if (membership === null) throw workspaceNotFound();
  return { userId: userId as Id<"users">, role: membership.role };
}

/** The keys this person may use in one workspace, names and websites only. */
export const listVaultEntries = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(entryValidator),
  handler: async (ctx, args): Promise<Entry[]> => {
    const { userId } = await signedInMember(ctx, args.workspaceId);
    const listed = (await runVault(
      ctx,
      args.workspaceId,
      { kind: "list", userId },
      "Your workspace's storage didn't answer. Try again.",
    )) as Listed | null;
    if (listed === null) return [];
    return listed.entries
      .map((entry) => entryFrom(entry.entryId, entry.meta, userId, listed.waiting[entry.entryId] ?? 0))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Cut one AI off a key, or every AI when `clientId` is left out. The key itself is unchanged. */
export const cutOffVaultAI = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), clientId: v.optional(v.string()) },
  returns: entryValidator,
  handler: async (ctx, args): Promise<Entry> => {
    const { userId } = await signedInMember(ctx, args.workspaceId);
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const cut = (await runVault(
      ctx,
      args.workspaceId,
      { kind: "cut", entryId: args.entryId, userId, ...(args.clientId === undefined ? {} : { clientId: args.clientId }) },
      "That didn't go through: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (cut === null) throw fail("INVALID_ARGUMENT", "There is no such key.");
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "vault.cut_off",
      entryId: args.entryId,
    });
    return entryFrom(cut.entryId, cut.meta, userId);
  },
});

/** "Allow" beside an AI the person said no to: it may use the key from now on. */
export const allowVaultAI = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), clientId: v.string() },
  returns: entryValidator,
  handler: async (ctx, args): Promise<Entry> => {
    const { userId } = await signedInMember(ctx, args.workspaceId);
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const allowed = (await runVault(
      ctx,
      args.workspaceId,
      { kind: "allow", entryId: args.entryId, userId, clientId: args.clientId },
      "That didn't go through: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (allowed === null) throw fail("INVALID_ARGUMENT", "There is no such key.");
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "vault.allowed",
      entryId: args.entryId,
    });
    return entryFrom(allowed.entryId, allowed.meta, userId);
  },
});

/**
 * A link to the vault's own pages for the signed-in person: `add` (New key;
 * editors and owners) or `view` (Show the key, for someone the key was given
 * to, checked again when it is revealed). Opened in the app at once.
 */
export const startVaultLink = action({
  args: { workspaceId: v.id("workspaces"), kind: v.union(v.literal("add"), v.literal("view")), entryId: v.optional(v.string()) },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args): Promise<{ token: string }> => {
    const { userId, role } = await signedInMember(ctx, args.workspaceId);
    if (args.kind === "add" && role === "member") throw fail("FORBIDDEN", "Editors and owners add keys here.");
    if (args.kind === "view" && !isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const token = randomOpaqueToken(24);
    const status = await ctx.runMutation(internal.functions.vault.issueVaultRequest, {
      workspaceId: args.workspaceId,
      userId,
      kind: args.kind,
      ...(args.kind === "view" ? { entryId: args.entryId } : {}),
      hashedToken: await hashToken(token),
    });
    if (status !== "issued") throw fail("FORBIDDEN", "That link could not be made.");
    return { token };
  },
});

/** The person behind a view link minted moments ago, and their role in its workspace. */
async function viewLinkHolder(ctx: ActionCtx, token: string) {
  const signedIn = await getAuthUserId(ctx);
  if (signedIn === null) throw fail("NOT_AUTHENTICATED", "Sign in to continue.");
  if (typeof token !== "string" || token.length === 0 || token.length > 128) throw linkDead();
  const live = await ctx.runQuery(internal.functions.vault.liveViewRequest, {
    hashedToken: await hashToken(token),
    userId: signedIn as Id<"users">,
  });
  const { userId, role } = await signedInMember(ctx, live.workspaceId);
  return { ...live, userId, anyKey: role !== "member" };
}

const noSay = () => fail("FORBIDDEN", "Only an owner or editor, or whoever saved this key, can change it.");

/**
 * Save a key changed in place on its view link: its name, the site Tex fills
 * it on, the one website it is only ever sent to and how, the username, the
 * password, or a secret's fields. The link proves this person asked to see
 * this key moments ago; owners and editors may change any key given to them,
 * anyone else only one they saved. Audited as `vault.edited` with the names
 * of what changed ("website, password"), never a value.
 */
export const editVaultEntry = action({
  args: {
    token: v.string(),
    name: v.optional(v.string()),
    site: v.optional(v.string()),
    proxy: v.optional(v.union(v.null(), proxyPinValidator)),
    username: v.optional(v.string()),
    password: v.optional(v.string()),
    fields: v.optional(v.array(fieldValuesValidator)),
  },
  returns: v.object({ changed: v.array(v.string()) }),
  handler: async (ctx, args): Promise<{ changed: string[] }> => {
    const live = await viewLinkHolder(ctx, args.token);
    const name = args.name?.trim();
    if (name !== undefined && (name.length === 0 || name.length > MAX_NAME)) throw fail("INVALID_ARGUMENT", "Give it a short name.");
    const site = args.site === undefined || args.site.trim() === "" ? args.site?.trim() : siteHost(args.site);
    if (site === null) throw fail("INVALID_ARGUMENT", "Enter the site's address, like netflix.com.");
    let proxy: ProxyPin | null | undefined = args.proxy === null ? null : undefined;
    if (args.proxy) {
      const checked = savedPin(args.proxy) as { pin?: ProxyPin; problem?: string };
      if (checked.pin === undefined) throw fail("INVALID_ARGUMENT", checked.problem ?? "Check the website.");
      proxy = checked.pin;
    }
    if ((args.username?.length ?? 0) > MAX_SECRET || (args.password?.length ?? 0) > MAX_SECRET) {
      throw fail("INVALID_ARGUMENT", "That is longer than a login can be.");
    }
    if (args.password !== undefined && args.password.length === 0) throw fail("INVALID_ARGUMENT", "Enter the password.");
    let fields: FieldValues[] | undefined;
    if (args.fields !== undefined) {
      const normalized = normalizeFields(args.fields);
      if (normalized.error !== null) throw fail("INVALID_ARGUMENT", `Check the fields: ${normalized.error}.`);
      fields = normalized.fields as FieldValues[];
    }
    const edited = (await runVault(
      ctx,
      live.workspaceId,
      {
        kind: "edit",
        entryId: live.entryId,
        userId: live.userId,
        anyKey: live.anyKey,
        ...(name === undefined ? {} : { name }),
        ...(site === undefined ? {} : { site }),
        ...(proxy === undefined ? {} : { proxy }),
        ...(args.username === undefined ? {} : { username: args.username }),
        ...(args.password === undefined ? {} : { password: args.password }),
        ...(fields === undefined ? {} : { fields }),
      },
      "That wasn't saved: your workspace's storage didn't take it.",
    )) as Shown | null;
    if (edited === null) throw noSay();
    const changed = edited.changed ?? [];
    if (changed.length > 0) {
      await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
        workspaceId: live.workspaceId,
        actorUserId: live.userId,
        action: "vault.edited",
        entryId: live.entryId,
        changed: changed.join(", ").slice(0, 500),
      });
    }
    return { changed };
  },
});

/**
 * Delete a key from its view link, with the same say as editing it. Its name
 * and values go together; every AI loses it at once. Audited as
 * `vault.deleted`.
 */
export const deleteVaultEntry = action({
  args: { token: v.string() },
  returns: v.object({ name: v.string() }),
  handler: async (ctx, args): Promise<{ name: string }> => {
    const live = await viewLinkHolder(ctx, args.token);
    const deleted = (await runVault(
      ctx,
      live.workspaceId,
      { kind: "delete", entryId: live.entryId, userId: live.userId, anyKey: live.anyKey },
      "That wasn't deleted: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (deleted === null) throw noSay();
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: live.workspaceId,
      actorUserId: live.userId,
      action: "vault.deleted",
      entryId: live.entryId,
    });
    return { name: deleted.meta.name };
  },
});

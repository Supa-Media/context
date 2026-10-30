/**
 * Settings › Vault (vault board 2): the keys a signed-in person may use in
 * one workspace, the one website each goes to, the AIs they said yes to, and
 * Cut off; and who each key is given to (the vault sharing boards,
 * 2026-10-17): people, groups or the whole workspace, each for their AIs to
 * use or to see too, with Take back. Every read and change goes through the
 * vault's barrier (`runVaultOperation` in `vault.ts`), which never returns a
 * value here: a key's values are seen and changed only through a fresh view
 * link, opened in place in Settings.
 */

import { getAuthUserId } from "./lib/signedIn";
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
import { EVERYONE, accessOf, belongsTo, ownerOf } from "../../mcp/src/vault/access.js";
import { mayManage, newlyReached } from "./lib/vaultPeople";
import {
  cardSummaryValidator,
  fieldValuesValidator,
  proxyPinValidator,
  shareLevelValidator,
  type FieldValues,
  type ProxyPin,
  type ShareLevel,
} from "./lib/vaultShapes";
import { runVault, type Listed, type Shown, type ShownMeta } from "./vault";
import type { VaultLabels } from "./vaultPeople";

const fail = (code: string, message: string) => new ConvexError({ code, message });
const linkDead = () => fail("VAULT_LINK_DEAD", "This link has expired or was already used. Ask Tex for a new one.");

/** `by`: whose AI it is; `byName`: that person as shown; `mine`: the reader's own. */
const whose = { by: v.string(), byName: v.string(), mine: v.boolean() };
const clientValidator = v.object({ id: v.string(), name: v.union(v.string(), v.null()), at: v.number(), ...whose });
const useValidator = v.object({
  id: v.string(),
  name: v.union(v.string(), v.null()),
  count: v.number(),
  at: v.number(),
  method: v.string(),
  path: v.string(),
  ...whose,
});
/** One row of a key's People: a person, a group, or the whole workspace. */
const shareRowValidator = v.object({
  to: v.string(),
  kind: v.union(v.literal("person"), v.literal("group"), v.literal("everyone")),
  name: v.string(),
  handle: v.union(v.string(), v.null()),
  /** How many people a group or the workspace reaches; null for a person. */
  count: v.union(v.number(), v.null()),
  level: shareLevelValidator,
  at: v.number(),
  isYou: v.boolean(),
});
const styleValidator = v.union(v.literal("bearer"), v.literal("header"), v.literal("query"));
const entryValidator = v.object({
  entryId: v.string(),
  type: v.union(v.literal("login"), v.literal("secret"), v.literal("card")),
  name: v.string(),
  sites: v.array(v.string()),
  envs: v.array(v.string()),
  /** A card's brand, last four and expiry; never its number. */
  card: v.optional(cardSummaryValidator),
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
  /** When it was saved, by whom, and whether by the person reading. */
  savedAt: v.number(),
  savedByYou: v.boolean(),
  savedBy: v.string(),
  /** How much of it the reader has: "see", or "use" (their AIs only, the value hidden). */
  level: shareLevelValidator,
  /** Whether the reader may give it away, take it back and cut anybody's AI off. */
  manage: v.boolean(),
  /** Who gave it to the reader, when somebody did; null when they saved it. */
  givenBy: v.union(v.string(), v.null()),
  /** Whether the reader was given it by name, and so can hand it back. */
  givenToYou: v.boolean(),
  /** Who has it, the saver first; only for somebody who may manage it, else empty. */
  people: v.array(shareRowValidator),
});
type Entry = typeof entryValidator.type;
type Caller = { userId: Id<"users">; role: "owner" | "editor" | "member"; groups: string[] };

/** Every user id and group a set of keys names, for one read of their labels. */
function namedIn(metas: ShownMeta[]): { userIds: string[]; groups: string[] } {
  const userIds = new Set<string>();
  const groups = new Set<string>();
  for (const meta of metas) {
    userIds.add(meta.createdBy);
    for (const person of meta.people) userIds.add(person);
    for (const share of meta.shares ?? []) {
      userIds.add(share.by);
      if (share.to.startsWith("@")) groups.add(share.to);
      else if (share.to !== EVERYONE) userIds.add(share.to);
    }
    for (const list of [meta.proxy?.clients, meta.proxy?.uses, meta.proxy?.refused]) {
      for (const record of list ?? []) userIds.add(ownerOf(record, meta) ?? meta.createdBy);
    }
  }
  return { userIds: [...userIds], groups: [...groups] };
}

function entryFrom(entryId: string, meta: ShownMeta, caller: Caller, labels: VaultLabels, waiting = 0): Entry {
  const userId = String(caller.userId);
  const envs = new Set<string>();
  for (const field of meta.fields) for (const env of field.set) if (env !== "_") envs.add(env);
  const manage = mayManage(meta as never, { userId, groups: caller.groups, anyKey: caller.role !== "member" });
  const personName = (id: string) => (id === userId ? "You" : labels.people[id]?.name ?? "Someone");
  // Somebody who may not manage the key sees only their own AIs: whose AI
  // touched a shared key is the business of the people who give it out.
  const withWhose = <T extends { id: string; by?: string }>(list: T[] | undefined) =>
    (list ?? [])
      .map((record) => {
        const by = ownerOf(record, meta) ?? meta.createdBy;
        return { ...record, by, byName: personName(by), mine: belongsTo(record, userId, meta) };
      })
      .filter((record) => manage || record.mine);
  const shares = meta.shares ?? [];
  const direct = shares.find((share) => share.to === userId);
  const via = direct ?? shares.find((share) => share.to === EVERYONE || caller.groups.includes(share.to));
  const people: Entry["people"] = [];
  if (manage) {
    people.push({ to: meta.createdBy, kind: "person", name: personName(meta.createdBy), handle: labels.people[meta.createdBy]?.handle ?? null, count: null, level: "see", at: meta.createdAt, isYou: meta.createdBy === userId });
    // Given before levels existed: on the list, seeing it.
    for (const person of meta.people) {
      if (person === meta.createdBy || shares.some((share) => share.to === person)) continue;
      people.push({ to: person, kind: "person", name: personName(person), handle: labels.people[person]?.handle ?? null, count: null, level: "see", at: meta.createdAt, isYou: person === userId });
    }
    for (const share of shares) {
      const kind = share.to === EVERYONE ? "everyone" : share.to.startsWith("@") ? "group" : "person";
      const group = labels.groups[share.to];
      people.push({
        to: share.to,
        kind,
        name: kind === "everyone" ? "Everyone in this workspace" : kind === "group" ? group?.label ?? share.to.slice(1) : personName(share.to),
        handle: kind === "person" ? labels.people[share.to]?.handle ?? null : null,
        count: kind === "everyone" ? labels.members : kind === "group" ? group?.count ?? 0 : null,
        level: share.level,
        at: share.at,
        isYou: share.to === userId,
      });
    }
  }
  return {
    entryId,
    type: meta.type,
    name: meta.name,
    sites: meta.sites,
    envs: ["dev", "staging", "prod"].filter((env) => envs.has(env)),
    ...(meta.type === "card" && meta.card ? { card: meta.card } : {}),
    shared: meta.people.length > 1 || shares.length > 0,
    proxy: meta.proxy
      ? {
          host: meta.proxy.host,
          style: meta.proxy.style,
          name: meta.proxy.name ?? null,
          prefix: meta.proxy.prefix ?? null,
          ask: meta.proxy.ask,
          clients: withWhose(meta.proxy.clients),
          uses: withWhose(meta.proxy.uses),
          refused: withWhose(meta.proxy.refused),
          waiting,
        }
      : null,
    savedAt: meta.createdAt,
    savedByYou: meta.createdBy === userId,
    savedBy: personName(meta.createdBy),
    level: accessOf(meta, userId, caller.groups) === "see" ? "see" : "use",
    manage,
    givenBy: meta.createdBy === userId ? null : personName(via?.by ?? meta.createdBy),
    givenToYou: meta.createdBy !== userId && meta.people.includes(userId),
    people,
  };
}

async function signedInMember(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<Caller> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw fail("NOT_AUTHENTICATED", "Sign in to continue.");
  const membership = await ctx.runQuery(internal.functions.contextPlugins.membershipFor, { workspaceId, userId });
  // A workspace this person is not in reads as one that does not exist.
  if (membership === null) throw workspaceNotFound();
  const groups = await ctx.runQuery(internal.functions.vaultPeople.accessNames, { workspaceId, userId });
  return { userId: userId as Id<"users">, role: membership.role, groups };
}

/** Keys as Settings shows them, with every name they mention read once. */
async function shownEntries(ctx: ActionCtx, workspaceId: Id<"workspaces">, caller: Caller, metas: { entryId: string; meta: ShownMeta; waiting?: number }[]) {
  const named = namedIn(metas.map((entry) => entry.meta));
  const labels = await ctx.runQuery(internal.functions.vaultPeople.labels, { workspaceId, ...named });
  return metas.map((entry) => entryFrom(entry.entryId, entry.meta, caller, labels, entry.waiting ?? 0));
}

/** The keys this person may use in one workspace, names and websites only. */
export const listVaultEntries = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(entryValidator),
  handler: async (ctx, args): Promise<Entry[]> => {
    const caller = await signedInMember(ctx, args.workspaceId);
    const listed = (await runVault(
      ctx,
      args.workspaceId,
      { kind: "list", userId: caller.userId, groups: caller.groups },
      "Your workspace's storage didn't answer. Try again.",
    )) as Listed | null;
    if (listed === null) return [];
    const entries = listed.entries.map((entry) => ({ ...entry, waiting: listed.waiting[entry.entryId] ?? 0 }));
    return (await shownEntries(ctx, args.workspaceId, caller, entries)).sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Cut one AI off a key, or every AI when `clientId` is left out. `by` names
 * whose AI: somebody who manages the key may cut anybody's, everyone else
 * only their own. The key itself is unchanged.
 */
export const cutOffVaultAI = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), clientId: v.optional(v.string()), by: v.optional(v.string()) },
  returns: entryValidator,
  handler: async (ctx, args): Promise<Entry> => {
    const caller = await signedInMember(ctx, args.workspaceId);
    const { userId } = caller;
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const cut = (await runVault(
      ctx,
      args.workspaceId,
      {
        kind: "cut",
        entryId: args.entryId,
        userId,
        groups: caller.groups,
        anyKey: caller.role !== "member",
        ...(args.clientId === undefined ? {} : { clientId: args.clientId }),
        ...(args.by === undefined ? {} : { by: args.by }),
      },
      "That didn't go through: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (cut === null) throw fail("INVALID_ARGUMENT", "There is no such key.");
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "vault.cut_off",
      entryId: args.entryId,
    });
    return (await shownEntries(ctx, args.workspaceId, caller, [cut]))[0];
  },
});

/** "Allow" beside an AI the person said no to: it may use the key from now on. */
export const allowVaultAI = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), clientId: v.string() },
  returns: entryValidator,
  handler: async (ctx, args): Promise<Entry> => {
    const caller = await signedInMember(ctx, args.workspaceId);
    const { userId } = caller;
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const allowed = (await runVault(
      ctx,
      args.workspaceId,
      { kind: "allow", entryId: args.entryId, userId, groups: caller.groups, clientId: args.clientId },
      "That didn't go through: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (allowed === null) throw fail("INVALID_ARGUMENT", "There is no such key.");
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "vault.allowed",
      entryId: args.entryId,
    });
    return (await shownEntries(ctx, args.workspaceId, caller, [allowed]))[0];
  },
});

const kindOf = (to: string) => (to === EVERYONE ? "the workspace" : to.startsWith("@") ? "a group" : "a person");

/**
 * Give a key to a person, a group or the whole workspace (`to`: a user id,
 * `@name`, or `*`), for their AIs to use or to see too; or change how much of
 * it they have. Only in a shared workspace (a personal one has nobody to give
 * it to), only to its own members and groups, and only by somebody who may
 * manage the key. Groups are offered to owners only, as only owners see them.
 */
export const giveVaultKey = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), to: v.string(), level: shareLevelValidator },
  returns: entryValidator,
  handler: async (ctx, args): Promise<Entry> => {
    const caller = await signedInMember(ctx, args.workspaceId);
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const target = await ctx.runQuery(internal.functions.vaultPeople.shareTarget, { workspaceId: args.workspaceId, to: args.to });
    const kind = await ctx.runQuery(internal.functions.vaultPeople.workspaceKind, { workspaceId: args.workspaceId });
    if (kind !== "shared") throw fail("FORBIDDEN", "Keys in a personal workspace stay yours. Save it in a shared workspace to give it to people there.");
    if (target === null) throw fail("INVALID_ARGUMENT", "Only people and groups in this workspace can be given a key.");
    if (target === "group" && caller.role !== "owner") throw fail("FORBIDDEN", "Only an owner can give a key to a group.");
    if (args.to === String(caller.userId)) throw fail("INVALID_ARGUMENT", "You already have this key.");
    const startedAt = Date.now();
    const given = (await runVault(
      ctx,
      args.workspaceId,
      {
        kind: "give",
        entryId: args.entryId,
        userId: caller.userId,
        groups: caller.groups,
        anyKey: caller.role !== "member",
        to: args.to,
        level: args.level as ShareLevel,
      },
      "That wasn't given: your workspace's storage didn't take it.",
    )) as Shown | null;
    if (given === null) throw fail("FORBIDDEN", "Only whoever saved this key, or an owner or editor who can see it, can give it.");
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.workspaceId,
      actorUserId: caller.userId,
      action: "vault.shared",
      entryId: args.entryId,
      changed: `${kindOf(args.to)}, ${args.level}`,
    });
    // A share made just now (not a level changed on an old one) is told to whoever it newly reaches.
    if ((given.meta.shares ?? []).some((share) => share.to === args.to && share.at >= startedAt)) {
      const names = await ctx.runQuery(internal.functions.vaultPeople.everyonesAccessNames, { workspaceId: args.workspaceId });
      const recipients = newlyReached(given.meta as never, args.to, names, [String(caller.userId), given.meta.createdBy]);
      if (recipients.length > 0) {
        await ctx.scheduler.runAfter(0, internal.functions.vaultNotify.sendGivenMail, {
          workspaceId: args.workspaceId,
          giverId: caller.userId,
          recipients,
          level: args.level as ShareLevel,
        });
      }
    }
    return (await shownEntries(ctx, args.workspaceId, caller, [given]))[0];
  },
});

/**
 * Take a key back from a person, a group or the whole workspace; or, with
 * `to` the reader, hand back a key given to you. Whoever loses it loses their
 * AIs' yeses with it, at once.
 */
export const takeBackVaultKey = action({
  args: { workspaceId: v.id("workspaces"), entryId: v.string(), to: v.string() },
  returns: v.union(v.null(), entryValidator),
  handler: async (ctx, args): Promise<Entry | null> => {
    const caller = await signedInMember(ctx, args.workspaceId);
    if (!isEntryId(args.entryId)) throw fail("INVALID_ARGUMENT", "There is no such key.");
    const still = await ctx.runQuery(internal.functions.vaultPeople.everyonesAccessNames, { workspaceId: args.workspaceId });
    const taken = (await runVault(
      ctx,
      args.workspaceId,
      {
        kind: "take",
        entryId: args.entryId,
        userId: caller.userId,
        groups: caller.groups,
        anyKey: caller.role !== "member",
        to: args.to,
        still,
      },
      "That didn't go through: your workspace's storage didn't answer.",
    )) as Shown | null;
    if (taken === null) throw fail("FORBIDDEN", "Only whoever saved this key, or an owner or editor who can see it, can take it back.");
    await ctx.runMutation(internal.functions.vault.recordVaultAudit, {
      workspaceId: args.workspaceId,
      actorUserId: caller.userId,
      action: "vault.unshared",
      entryId: args.entryId,
      changed: args.to === String(caller.userId) ? "handed back" : kindOf(args.to),
    });
    // Handed back: the reader no longer has it.
    if (accessOf(taken.meta, String(caller.userId), caller.groups) === null) return null;
    return (await shownEntries(ctx, args.workspaceId, caller, [taken]))[0];
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
  const { userId, role, groups } = await signedInMember(ctx, live.workspaceId);
  return { ...live, userId, groups, anyKey: role !== "member" };
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
        groups: live.groups,
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
      { kind: "delete", entryId: live.entryId, userId: live.userId, groups: live.groups, anyKey: live.anyKey },
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

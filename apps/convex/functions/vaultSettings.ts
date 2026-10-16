/**
 * Settings › Vault (vault board 2): the keys a signed-in person may use in
 * one workspace, the one website each goes to, the AIs they said yes to, and
 * Cut off. Every read and change goes through the vault's barrier
 * (`runVaultOperation` in `vault.ts`), which never returns a value: a key's
 * values are seen only on its view page, reached here by a fresh link.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { isEntryId } from "../../mcp/src/vault/entries.js";
import { runVault, type Listed, type Shown, type ShownMeta } from "./vault";

const fail = (code: string, message: string) => new ConvexError({ code, message });

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
      ask: v.boolean(),
      clients: v.array(v.object({ id: v.string(), name: v.union(v.string(), v.null()), at: v.number() })),
    }),
  ),
});
type Entry = typeof entryValidator.type;

function entryFrom(entryId: string, meta: ShownMeta): Entry {
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
          ask: meta.proxy.ask,
          clients: meta.proxy.clients ?? [],
        }
      : null,
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
  if (membership === null) throw fail("WORKSPACE_NOT_FOUND", "There is no such workspace.");
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
      .map((entry) => entryFrom(entry.entryId, entry.meta))
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
    return entryFrom(cut.entryId, cut.meta);
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

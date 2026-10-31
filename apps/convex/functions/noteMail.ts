/**
 * Note mail mailboxes: which note an agent joined, as whom, and how far it
 * has read (`docs/decisions/note-mail.md`). The mail is in the note; nothing
 * here holds a word of it.
 *
 * Every function takes the presenting access token's hash and resolves the
 * live grant itself, so a mailbox is only ever reached by the connection that
 * joined it, and only while that grant is live and still reaches the
 * workspace.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { addressable, contextsForGrant, resolveLiveGrant } from "./lib/controlPlane/liveGrants";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_PATH = 1024;

const mailboxView = v.object({
  mailboxId: v.string(),
  workspaceId: v.id("workspaces"),
  path: v.string(),
  name: v.string(),
  readThrough: v.union(v.string(), v.null()),
});

function view(row: Doc<"noteMailboxes">) {
  return {
    mailboxId: row.mailboxId,
    workspaceId: row.workspaceId,
    path: row.path,
    name: row.name,
    readThrough: row.readThrough ?? null,
  };
}

/** The live mailbox this token's grant joined, or null for anything else. */
async function ownMailbox(ctx: QueryCtx, hashedAccessToken: string, mailboxId: string) {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live === null) return null;
  const row = await ctx.db
    .query("noteMailboxes")
    .withIndex("by_mailboxId", (q) => q.eq("mailboxId", mailboxId))
    .unique();
  if (row === null || row.grantId !== live.grant._id) return null;
  const reach = addressable(await contextsForGrant(ctx, live));
  if (!reach.some((entry) => entry.workspaceId === row.workspaceId)) return null;
  return row;
}

/**
 * Join a note's mail as `name`. Joining again with the same name from the
 * same grant returns the same mailbox; a name another connection holds on
 * that note is refused, so two agents never share one inbox by accident.
 */
export const joinMailbox = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    workspaceId: v.string(),
    path: v.string(),
    name: v.string(),
    mailboxId: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), mailbox: mailboxView }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("name_taken"), v.literal("refused")) }),
  ),
  handler: async (ctx, args) => {
    const refused = { ok: false as const, error: "refused" as const };
    if (!NAME_RE.test(args.name) || args.name === "everyone") return refused;
    if (!args.path || args.path.length > MAX_PATH || !/^mb_[a-z0-9]{8,32}$/.test(args.mailboxId)) return refused;
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return refused;
    const target = addressable(await contextsForGrant(ctx, live)).find((entry) => entry.workspaceId === args.workspaceId);
    if (!target) return refused;
    // A group chat's home in the pin is the one place in the pin it may hold a mailbox: its folder, never the pin.
    if (target.homeOnly === true && !(typeof target.chatHome === "string" && args.path.startsWith(`${target.chatHome}/`))) return refused;
    const existing = await ctx.db
      .query("noteMailboxes")
      .withIndex("by_workspace_path_name", (q) =>
        q.eq("workspaceId", target.workspaceId).eq("path", args.path).eq("name", args.name),
      )
      .collect();
    const mine = existing.find((row) => row.grantId === live.grant._id);
    if (mine) return { ok: true as const, mailbox: view(mine) };
    if (existing.length > 0) return { ok: false as const, error: "name_taken" as const };
    const id = await ctx.db.insert("noteMailboxes", {
      mailboxId: args.mailboxId,
      grantId: live.grant._id,
      workspaceId: target.workspaceId,
      path: args.path,
      name: args.name,
      readThrough: new Date().toISOString(),
      createdAt: Date.now(),
    });
    return { ok: true as const, mailbox: view((await ctx.db.get(id))!) };
  },
});

/** The mailbox, if this token's grant joined it. */
export const getMailbox = internalQuery({
  args: { hashedAccessToken: v.string(), mailboxId: v.string() },
  returns: v.union(mailboxView, v.null()),
  handler: async (ctx, args) => {
    const row = await ownMailbox(ctx, args.hashedAccessToken, args.mailboxId);
    return row === null ? null : view(row);
  },
});

/** Move the mailbox's read mark forward to `readThrough`; never back. */
export const markMailRead = internalMutation({
  args: { hashedAccessToken: v.string(), mailboxId: v.string(), readThrough: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(Date.parse(args.readThrough))) return null;
    const row = await ownMailbox(ctx, args.hashedAccessToken, args.mailboxId);
    if (row === null) return null;
    const current = row.readThrough ? Date.parse(row.readThrough) : -Infinity;
    if (Date.parse(args.readThrough) > current) await ctx.db.patch(row._id, { readThrough: args.readThrough });
    return null;
  },
});

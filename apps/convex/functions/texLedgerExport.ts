/**
 * The person's chat with Tex, in their Download as folders: the one-to-one
 * chat's ledger, the one record of everything said and done in it (decided by
 * the owner, 2026-11-02; `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * The ledger lives in the person's Tex object, which only the gateway can
 * reach, so this reads it through the gateway's door (`lib/texStore.ts`) a
 * page at a time, oldest first, and the console writes it as one JSON file
 * (`apps/mobile/features/console/files/ledgerDownload.ts`). Owner only, as the
 * chat is theirs: anyone else is answered an empty, finished page.
 *
 * A group chat's ledger rides its people's own exports, each as one file
 * beside it: only in the person's personal workspace, only while they are one
 * of the chat's people (`textGroups.homeUsers`, the rule the Tex page uses),
 * checked again on every page. Nobody else's export carries it, an owner of
 * the workspace that holds the chat's home included (`chat-homes.md`).
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import { consoleTexBuckets } from "./lib/texStore";
import { personalWorkspaceOf } from "./textLinks";

/** Entries a page reads: a tool's result is cut at 64,000 characters, so a page stays well inside an action's answer. */
export const LEDGER_EXPORT_PAGE = 50;

const pageValidator = v.object({
  /** The ledger's manifest, as JSON, on every page (it is small). Null when there is no ledger. */
  manifest: v.union(v.null(), v.string()),
  /** This page's entries, each one line of JSON, oldest first. */
  lines: v.array(v.string()),
  /** The `seq` to read on from, or null at the end. */
  next: v.union(v.null(), v.number()),
});

type Page = typeof pageValidator.type;
const EMPTY: Page = { manifest: null, lines: [], next: null };

/** Scanned, not indexed, as the Tex page finds them (`texPage.ts`): a person's few group chats in a bounded read. */
const CHAT_SCAN = 2000;
const CHAT_KEY = /^[0-9a-f]{64}$/;

/** The group chats whose ledgers ride this export: the actor's, and only in their own personal workspace. */
export const groupChatsForExport = internalQuery({
  args: { actorUserId: v.id("users"), workspaceId: v.id("workspaces") },
  returns: v.array(v.string()),
  handler: async (ctx, { actorUserId, workspaceId }) => {
    if ((await personalWorkspaceOf(ctx, actorUserId)) !== workspaceId) return [];
    return (await ctx.db.query("textGroups").take(CHAT_SCAN))
      .filter((chat) => (chat.homeUsers ?? []).includes(actorUserId) && CHAT_KEY.test(chat.groupKey))
      .map((chat) => chat.groupKey)
      .sort();
  },
});

/** The actor, when they own the workspace; null for anyone else. */
async function ownerOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<Id<"users"> | null> {
  const actorUserId = await callerId(ctx);
  try {
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum: "owner" });
  } catch (error) {
    if (error instanceof ConvexError) return null;
    throw error;
  }
  return actorUserId;
}

/** The group chats whose ledgers this export carries beside the person's own; none for anyone but the owner. */
export const listChatLedgersForExport = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ chats: v.array(v.string()) }),
  handler: async (ctx, { workspaceId }): Promise<{ chats: string[] }> => {
    const actorUserId = await ownerOf(ctx, workspaceId);
    if (actorUserId === null) return { chats: [] };
    return { chats: await ctx.runQuery(internal.functions.texLedgerExport.groupChatsForExport, { actorUserId, workspaceId }) };
  },
});

/**
 * One page of a chat ledger after `after`: the person's one-to-one chat, or
 * with `chat` one of their group chats. An empty, finished page for anyone but
 * the owner, and for a group chat the person is not one of the people of.
 */
export const readChatLedgerForExport = action({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.number()), chat: v.optional(v.string()) },
  returns: pageValidator,
  handler: async (ctx, { workspaceId, after, chat }): Promise<Page> => {
    const actorUserId = await ownerOf(ctx, workspaceId);
    if (actorUserId === null) return EMPTY;
    if (chat !== undefined) {
      const mine = await ctx.runQuery(internal.functions.texLedgerExport.groupChatsForExport, { actorUserId, workspaceId });
      if (!mine.includes(chat)) return EMPTY;
    }
    const owner = chat === undefined ? `person:${workspaceId}` : `chat:${chat}`;
    const buckets = consoleTexBuckets(ctx, workspaceId, { ticketOwners: [owner] });
    // A deployment that cannot reach the gateway has no Tex objects to read: said as a failure, never as an empty chat.
    if (buckets === null) throw new ConvexError({ code: "tex_store_unavailable" });
    const read = (await buckets(owner).ledgerRead(chat ?? "texts", { ...(after === undefined ? {} : { after }), limit: LEDGER_EXPORT_PAGE })) as {
      manifest?: { count?: number } & Record<string, unknown>;
      entries?: unknown[];
      next?: number;
    };
    const entries = Array.isArray(read?.entries) ? read.entries : [];
    const manifest = read?.manifest && Number(read.manifest.count ?? 0) > 0 ? JSON.stringify(read.manifest) : null;
    return { manifest, lines: entries.map((entry) => JSON.stringify(entry)), next: Number.isSafeInteger(read?.next) ? (read.next as number) : null };
  },
});

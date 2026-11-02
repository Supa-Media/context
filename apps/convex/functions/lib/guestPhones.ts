/**
 * The people in a Tex guest chat, by number, kept so they can open what the chat reads (the owner, 2026-10-27:
 * "when a note/artifact is shared with a groupchat with guests when they click on it there is an easy screen for
 * them to verify their number and open the artifact"; `docs/decisions/texting-assistant/guest-phone-pass.md`).
 *
 * A guest has no account, so the only thing that says they belong to a chat is their number, and until this the
 * chat's numbers were never kept (`lib/schema/textGroups.ts`). They still aren't: each is kept as an HMAC under a
 * key derived from the deployment's storage key, so the rows alone can't be walked back to numbers the way a plain
 * or chat-salted hash of a ten-digit number can.
 *
 *  - **Rewritten on every tag** from the participants the message came with (`syncChatPhones`, and `syncHomePhones`
 *    for a chat answered from its home), so someone who left is gone at the next tag and someone who joined is there.
 *  - **Emptied when guest mode goes off** (`clearChatPhones`), and ignored anyway for a chat that is no longer a
 *    guest chat: what a number opens is worked out from the live chat row on every read (`guestReach`).
 *  - **Reach is the chat's group, read as a guest.** The names are the tokens of the rows granted to the chat's
 *    group, and the rows are rendered for a guest (`renderAccess(rows, "guest")`), so `team` notes, private notes
 *    and notes shared with anyone else stay shut: exactly what Tex reads for the chat (`chatFolders.ts`).
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireEncryptionKey } from "./crypto";
import { normalizePath } from "./fileOps";
import { guestCanSee, type GuestView } from "./grants/outsider";
import { accessRowsOf } from "./nodes/accessRows";
import { nodeAt } from "./nodes/paths";
import { accessNamesFor, renderAccess } from "./nodes/rowAccess";
import { pinnedContextWorkspace } from "./pinnedContext";

/** What the derived key is for, so it can never equal a key derived for anything else. */
const KEY_LABEL = "context/guest-phone-hash/v1";
/** Most chats one number opens notes through; nobody is in this many guest chats. */
const MAX_CHATS_PER_PHONE = 32;
/** Most numbers kept for one chat: a chat holds at most 32 people (`MAX_GROUP_PARTICIPANTS`). */
const MAX_PHONES_PER_CHAT = 32;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message));
}

/** A number (E.164) as these tables keep it, or `null` on a deployment with no storage key to derive one from. */
export async function guestPhoneHash(phone: string): Promise<string | null> {
  let material: string;
  try {
    material = requireEncryptionKey();
  } catch {
    return null;
  }
  const key = await hmac(new TextEncoder().encode(material), KEY_LABEL);
  return hex(await hmac(key, phone));
}

/** Keep the chat's numbers as they are now: the ones gone come off, the new ones go on. Best effort. */
export async function syncChatPhones(ctx: MutationCtx, chat: Doc<"textGroups">, phones: readonly string[]): Promise<void> {
  if (chat.workspaceId === undefined || chat.guestGroupId === undefined) return;
  await keepPhones(ctx, chat._id, chat.workspaceId, phones);
}

/**
 * The same for a chat answered from its home (E1, `lib/textGroupHomeOnly.ts`): its numbers are kept against the pinned
 * workspace its home is in, so a number in the chat may open a note link there. Nothing for a chat with no home.
 */
export async function syncHomePhones(ctx: MutationCtx, chatId: Id<"textGroups">, phones: readonly string[]): Promise<void> {
  const chat = await ctx.db.get(chatId);
  const pinned = await pinnedContextWorkspace(ctx);
  if (chat === null || chat.homeWords === undefined || pinned === null) return;
  await keepPhones(ctx, chatId, pinned._id, phones);
}

async function keepPhones(ctx: MutationCtx, chatId: Id<"textGroups">, workspaceId: Id<"workspaces">, phones: readonly string[]): Promise<void> {
  const wanted = new Set<string>();
  for (const phone of phones.slice(0, MAX_PHONES_PER_CHAT)) {
    const hash = await guestPhoneHash(phone);
    if (hash === null) return;
    wanted.add(hash);
  }
  const rows = await ctx.db
    .query("chatGuestPhones")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(MAX_PHONES_PER_CHAT * 2);
  const kept = new Set<string>();
  for (const row of rows) {
    // A row for another workspace is from before the chat was bound again: it goes.
    if (!wanted.has(row.phoneHash) || row.workspaceId !== workspaceId || kept.has(row.phoneHash)) {
      await ctx.db.delete(row._id);
    } else {
      kept.add(row.phoneHash);
    }
  }
  const now = Date.now();
  for (const phoneHash of wanted) {
    if (!kept.has(phoneHash)) await ctx.db.insert("chatGuestPhones", { chatId, workspaceId, phoneHash, seenAt: now });
  }
}

/** Every number kept for the chat, gone: guest mode is off. */
export async function clearChatPhones(ctx: MutationCtx, chatId: Id<"textGroups">): Promise<void> {
  const rows = await ctx.db
    .query("chatGuestPhones")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .take(MAX_PHONES_PER_CHAT * 2);
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * The live chats this number is in, in one workspace or any: a legacy guest chat, or a chat answered from its home in
 * the pinned workspace. The chat row decides, not the number's row.
 */
export async function guestChatsOf(ctx: QueryCtx, phoneHash: string, workspaceId?: Id<"workspaces">): Promise<Doc<"textGroups">[]> {
  const rows = await ctx.db
    .query("chatGuestPhones")
    .withIndex("by_phone_hash", (q) => q.eq("phoneHash", phoneHash))
    .take(MAX_CHATS_PER_PHONE);
  const chats: Doc<"textGroups">[] = [];
  const pinned = await pinnedContextWorkspace(ctx);
  for (const row of rows) {
    if (workspaceId !== undefined && row.workspaceId !== workspaceId) continue;
    const chat = await ctx.db.get(row.chatId);
    if (chat === null) continue;
    // A chat out of guest mode, or bound elsewhere since, reaches nothing; a home counts only in the pin it is in.
    const legacy = chat.guestGroupId !== undefined && chat.workspaceId === row.workspaceId;
    const home = chat.homeWords !== undefined && pinned !== null && row.workspaceId === pinned._id;
    if (legacy || home) chats.push(chat);
  }
  return chats;
}

/**
 * What this number may read in one workspace, as a guest of the chats it is in there: the guest view the chats'
 * groups give, or `null` when it is in none or they hold nothing.
 */
export async function guestReach(ctx: QueryCtx, phoneHash: string, workspaceId: Id<"workspaces">): Promise<GuestView | null> {
  const chats = await guestChatsOf(ctx, phoneHash, workspaceId);
  const groupIds: string[] = [];
  for (const chat of chats) {
    const group = chat.guestGroupId === undefined ? null : await ctx.db.get(chat.guestGroupId);
    if (group !== null && group.workspaceId === workspaceId) groupIds.push(group._id);
  }
  if (groupIds.length === 0) return null;
  const rows = await accessRowsOf(ctx, workspaceId);
  const names = accessNamesFor({ groupIds }, rows);
  if (names.length === 0) return null;
  const { rules, overrides } = renderAccess(rows, "guest");
  return { workspaceId, names, rules, overrides, rows };
}

/** The live note at `path` this number may read in the workspace, with the names to read it by; else `null`. */
export async function guestNote(
  ctx: QueryCtx,
  phoneHash: string,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<{ path: string; names: string[] } | null> {
  const normalized = normalizePath(path);
  if (normalized === null || !normalized.toLowerCase().endsWith(".md")) return null;
  const view = await guestReach(ctx, phoneHash, workspaceId);
  if (view === null) return null;
  const node = await nodeAt(ctx.db, workspaceId, normalized);
  if (node === null || node.goneAt !== undefined || node.kind !== "file") return null;
  if (!guestCanSee(view, node.path)) return null;
  return { path: node.path, names: [...view.names] };
}

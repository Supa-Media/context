/**
 * A group chat's name, shown in the app on its home instead of the home's three words (decided by the owner,
 * 2026-11-02: "instead of showing the ID, why don't we just show the actual group chat name? ... or the group chat
 * name might just be a list of people and then, you know, ellipses when it gets too long").
 *
 * Its home is also drawn with the mark of the app the chat is in, iMessage or WhatsApp (the owner, 2026-11-02: "a
 * drawn green whatsapp logo or a drawn blue imessage logo, that way its easy to see whats imessge and whats
 * whatsapp"), told by the same report: a WhatsApp chat's id is `whapi:<jid>`, any other is Sendblue's iMessage.
 *
 * The texting Worker sends the chat's name with each message (`apps/agent/src/sendblueGroups.ts` `groupNameOf`),
 * beside it and never in it, so a rename shows on the chat's next message. Anyone in the chat can set it, so it is
 * text to show and nothing else: it never reaches a model, a path or a permission. The home's three words stay its
 * folder and its id.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { CHAT_HOMES_FOLDER } from "@context/shared";
import { getAuthUserId } from "./lib/signedIn";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { handleFor } from "./texPage";

/** The longest name kept, as the Worker cuts it. */
export const MAX_CHAT_NAME = 120;

/** Chats one person's homes are looked for among: Tex has few, so one bounded scan (as the Tex page does). */
const CHAT_SCAN = 2000;

/** Handles named before the rest are counted. */
const NAMED = 3;

/** `name` as one plain line of at most `MAX_CHAT_NAME` characters: control and direction characters out. */
export function cleanChatName(name: string): string {
  const plain = name
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...plain].slice(0, MAX_CHAT_NAME).join("");
}

/** A chat with no name, by its people: `@bo, @cy, @dana +2`, the reader left out; "Group chat" with nobody else. */
export function peopleTitle(handles: readonly string[], others: number): string {
  const named = handles.filter((handle) => handle !== "").map((handle) => `@${handle}`);
  const rest = Math.max(0, named.length - NAMED) + (handles.length - named.length) + Math.max(0, others);
  if (named.length === 0) return rest > 0 ? `Group chat +${rest}` : "Group chat";
  return `${named.slice(0, NAMED).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

export const chatServiceValidator = v.union(v.literal("imessage"), v.literal("whatsapp"));
export type ChatService = "imessage" | "whatsapp";

/** The app a chat is in, from the Worker's id for it: `whapi:<jid>` is WhatsApp, Sendblue's ids are iMessage. */
export function serviceOfGroupId(groupId: string): ChatService {
  return groupId.startsWith("whapi:") ? "whatsapp" : "imessage";
}

/**
 * The Worker's report of a chat, with each message: its app, and its name when the message gave one (kept, or
 * cleared for ""; a line that gives none leaves it). Answers whether Tex has the chat.
 */
export const setChatName = internalMutation({
  args: { groupKey: v.string(), name: v.optional(v.string()), service: chatServiceValidator },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, { groupKey, name, service }) => {
    const chat = await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", groupKey)).unique();
    if (chat === null) return { ok: false };
    const patch: { chatName?: string; chatService?: ChatService } = {};
    if (name !== undefined) {
      const clean = cleanChatName(name);
      const next = clean === "" ? undefined : clean;
      if (chat.chatName !== next) patch.chatName = next;
    }
    if (chat.chatService !== service) patch.chatService = service;
    if (Object.keys(patch).length > 0) await ctx.db.patch(chat._id, patch);
    return { ok: true };
  },
});

const titleValidator = v.object({
  path: v.string(),
  title: v.string(),
  named: v.boolean(),
  words: v.string(),
  /** The app the chat is in, `null` until its next message says. */
  service: v.union(chatServiceValidator, v.null()),
});

/**
 * What the app draws each of the reader's chat homes as, in the pinned workspace and nowhere else: its name, or its
 * people. Only the homes the reader is named on, which are the ones they can open; anything else answers nothing.
 */
export const homeTitles = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(titleValidator),
  handler: async (ctx, { workspaceId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null || pinned._id !== workspaceId) return [];
    const mine = (await ctx.db.query("textGroups").take(CHAT_SCAN)).filter(
      (chat) => typeof chat.homeWords === "string" && chat.homeWords !== "" && (chat.homeUsers ?? []).includes(userId),
    );
    return await Promise.all(mine.map(async (chat) => ({ ...(await titleOf(ctx, chat.homeWords as string, chat.chatName, chat.homeUsers ?? [], chat._id, userId)), service: chat.chatService ?? null })));
  },
});

async function titleOf(ctx: QueryCtx, words: string, chatName: string | undefined, people: Id<"users">[], chatId: Id<"textGroups">, reader: Id<"users">) {
  const path = `${CHAT_HOMES_FOLDER}/${words}`;
  if (chatName !== undefined && chatName !== "") return { path, title: chatName, named: true, words };
  const handles = await Promise.all(people.filter((id) => id !== reader).map(async (id) => await handleFor(ctx, id)));
  const guests = (await ctx.db.query("chatGuestPhones").withIndex("by_chat", (q) => q.eq("chatId", chatId)).take(64)).length;
  return { path, title: peopleTitle(handles, guests), named: false, words };
}

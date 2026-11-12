/** The shapes of a vault link texted in a group chat (`vaultChat.ts`): validators only, so the schema can name them. */

import { v } from "convex/values";

/** An account in the chat by id, or somebody invited by number who hasn't joined, by the chat's guest label. */
export const chatPersonValidator = v.object({ userId: v.optional(v.id("users")), label: v.optional(v.string()) });
export const requestChatValidator = v.object({ key: v.string(), people: v.array(chatPersonValidator) });
export type ChatPerson = typeof chatPersonValidator.type;
export type RequestChat = typeof requestChatValidator.type;

export const shareChoiceValidator = v.union(v.literal("chat"), v.literal("workspace"), v.literal("me"));
export type ShareChoice = typeof shareChoiceValidator.type;

export const chatPeopleRowValidator = v.object({
  name: v.string(),
  handle: v.union(v.string(), v.null()),
  status: v.union(v.literal("you"), v.literal("member"), v.literal("invited"), v.literal("not_member")),
});
export type ChatPeopleRow = typeof chatPeopleRowValidator.type;

/**
 * Name each chat's home again with its people as they stand, by every account that holds their number
 * (`lib/textGroupAccounts.ts` `withSameNumber`, 2026-11-02: a person in five chats saw none of them from the account
 * they sign in to the app with). A home is named again on its chat's next turn anyway; this does it now for every
 * chat, so nobody waits for a text. It only adds accounts that hold a named person's number: who is in a chat is still
 * decided by its turns.
 *
 * Run from the `Tex chat home people` workflow, whose log is public: it answers counts only. `dryRun` counts what
 * would change and writes nothing.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { withSameNumber } from "./lib/textGroupAccounts";
import { makeChatHome } from "./lib/textGroupHome";

export const nameAgain = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }) => {
    const chats = await ctx.db.query("textGroups").collect();
    let homes = 0;
    let widened = 0;
    let added = 0;
    let refused = 0;
    for (const chat of chats) {
      const people = chat.homeUsers ?? [];
      if (chat.homeWords === undefined || people.length === 0) continue;
      homes += 1;
      const wanted = await withSameNumber(ctx, people);
      if (wanted.length === people.length) continue;
      widened += 1;
      added += wanted.length - people.length;
      if (dryRun) continue;
      const actor = chat.sponsorId ?? people[0];
      const answer = await makeChatHome(ctx, chat, people, actor);
      if (!("folder" in answer)) refused += 1;
    }
    return { dryRun, homes, widened, added, refused };
  },
});

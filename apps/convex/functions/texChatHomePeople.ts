/**
 * Name each chat's home again with its people as they stand, by every account that holds their number
 * (`lib/textGroupAccounts.ts` `withSameNumber`, 2026-11-02: a person in five chats saw none of them from the account
 * they sign in to the app with). A home is named again on its chat's next turn anyway; this does it now for every
 * chat, so nobody waits for a text. It only adds accounts that hold a named person's number: who is in a chat is still
 * decided by its turns. A home missing any of its folders (`HOME_FOLDERS`, which grew on 2026-11-02 to every folder a
 * person's Tex has) gets them stood here too, so a quiet chat's home has the same shape without waiting for a text.
 *
 * Run from the `Tex chat home people` workflow, whose log is public: it answers counts only. `dryRun` counts what
 * would change and writes nothing. A run that writes does it inside `objectFirst` for the pinned workspace: a home's row
 * names exactly its people, so naming it again may take someone off it, and production's report of unmarked
 * narrowings named this run (2026-11-02).
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { objectFirst } from "./lib/rowWatch/objectFirst";
import { withSameNumber } from "./lib/textGroupAccounts";
import { chatHomePath, homeStands, makeChatHome, sealedPin } from "./lib/textGroupHome";
import { pinnedContextWorkspace } from "./lib/pinnedContext";

type Counts = { dryRun: boolean; homes: number; widened: number; added: number; unstood: number; refused: number };

export const nameAgain = internalAction({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }): Promise<Counts> => {
    const run = async (): Promise<Counts> => await ctx.runMutation(internal.functions.texChatHomePeople.nameAgainNow, { dryRun });
    const pinned = dryRun ? null : await ctx.runQuery(internal.functions.texChatHomePeople.pinnedWorkspace, {});
    return pinned === null ? await run() : await objectFirst(ctx, pinned, run);
  },
});

/** The pinned workspace the homes live in, or null on a deployment with none. */
export const pinnedWorkspace = internalQuery({
  args: {},
  handler: async (ctx) => await sealedPin(ctx),
});

/** The run itself, called only by `nameAgain`. */
export const nameAgainNow = internalMutation({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }) => {
    const chats = await ctx.db.query("textGroups").collect();
    const pinned = (await pinnedContextWorkspace(ctx))?._id ?? null;
    let homes = 0;
    let widened = 0;
    let added = 0;
    let unstood = 0;
    let refused = 0;
    for (const chat of chats) {
      const people = chat.homeUsers ?? [];
      if (chat.homeWords === undefined || people.length === 0) continue;
      homes += 1;
      const wanted = await withSameNumber(ctx, people);
      const stands = pinned !== null && (await homeStands(ctx, pinned, chatHomePath(chat.homeWords)));
      if (wanted.length === people.length && stands) continue;
      if (wanted.length !== people.length) widened += 1;
      if (!stands) unstood += 1;
      added += wanted.length - people.length;
      if (dryRun) continue;
      const actor = chat.sponsorId ?? people[0];
      const answer = await makeChatHome(ctx, chat, people, actor);
      if (!("folder" in answer)) refused += 1;
    }
    return { dryRun, homes, widened, added, unstood, refused };
  },
});

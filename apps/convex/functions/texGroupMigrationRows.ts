/**
 * The tree's side of the group chat migration (`texGroupMigration.ts`): a home for every chat (`homeEveryChat`), and
 * which chats there are and which old notes their workspaces still hold (`sweepPlan`). Reads no credential, so it stays out of the decrypt-capable list, as
 * `texMigrationRows.ts` does for the notes migration.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { rowsAfter } from "./lib/nodes/paths";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { chatHomeOf, makeChatHome } from "./lib/textGroupHome";

/** An old memory or voice note in a workspace's `tex/groups/`, as the gateway named them. */
export const OLD_NOTE = /^tex\/groups\/(chat|voice)-([0-9a-f]{12,16})\.md$/;
/** Rows read under one workspace's `tex/groups/`: far more than its chats ever wrote. */
const ROWS_PER_WORKSPACE = 500;

const count = (counts: Record<string, number>, code: string) => {
  counts[code] = (counts[code] ?? 0) + 1;
};

/** Who a home is made for: the people it was last seen with, and who it is made in the name of. */
function homePeople(chat: Doc<"textGroups">): { actor: Id<"users"> | null; people: Id<"users">[] } {
  const people = [...new Set([...(chat.homeUsers ?? []), ...(chat.reachPeople ?? [])])];
  const actor = chat.sponsorId ?? chat.boundBy ?? people[0] ?? null;
  return { actor, people: actor === null || people.includes(actor) ? people : [...people, actor] };
}

export const homeEveryChat = internalMutation({
  args: { dryRun: v.boolean() },
  returns: v.object({ chats: v.number(), homed: v.number(), wouldHome: v.number(), made: v.number(), refused: v.record(v.string(), v.number()) }),
  handler: async (ctx, { dryRun }) => {
    const chats = await ctx.db.query("textGroups").collect();
    let homed = 0;
    let wouldHome = 0;
    let made = 0;
    const refused: Record<string, number> = {};
    for (const chat of chats) {
      if ((await chatHomeOf(ctx, chat._id)) !== null) {
        homed += 1;
        continue;
      }
      const { actor, people } = homePeople(chat);
      if (actor === null) {
        count(refused, "no_person");
        continue;
      }
      wouldHome += 1;
      if (dryRun) continue;
      const answer = await makeChatHome(ctx, chat, people, actor);
      if ("folder" in answer) made += 1;
      else count(refused, answer.refused);
    }
    return { chats: chats.length, homed, wouldHome, made, refused };
  },
});


export type SweepPlan = {
  pin: Id<"workspaces"> | null;
  chats: { groupKey: string; bound: Id<"workspaces"> | null; homed: boolean }[];
  workspaces: { id: Id<"workspaces">; slug: string; paths: string[] }[];
};

/** The chats and the workspaces their old notes may be in: each one's bound workspace and its reach, never the pin. */
export const sweepPlan = internalQuery({
  args: {},
  returns: v.object({
    pin: v.union(v.id("workspaces"), v.null()),
    chats: v.array(v.object({ groupKey: v.string(), bound: v.union(v.id("workspaces"), v.null()), homed: v.boolean() })),
    workspaces: v.array(v.object({ id: v.id("workspaces"), slug: v.string(), paths: v.array(v.string()) })),
  }),
  handler: async (ctx): Promise<SweepPlan> => {
    const pin = (await pinnedContextWorkspace(ctx))?._id ?? null;
    const chats = await ctx.db.query("textGroups").collect();
    const ids = new Set<Id<"workspaces">>();
    const rows = [];
    for (const chat of chats) {
      for (const id of [chat.workspaceId, ...(chat.reach ?? [])]) if (id !== undefined && id !== pin) ids.add(id);
      rows.push({ groupKey: chat.groupKey, bound: chat.workspaceId ?? null, homed: (await chatHomeOf(ctx, chat._id)) !== null });
    }
    const workspaces = [];
    for (const id of ids) {
      const workspace = await ctx.db.get(id);
      if (workspace === null) continue;
      const paths = (await rowsAfter(ctx.db, id, "tex/groups", undefined, ROWS_PER_WORKSPACE))
        .filter((row) => row.kind === "file" && row.goneAt === undefined && OLD_NOTE.test(row.path))
        .map((row) => row.path);
      if (paths.length > 0) workspaces.push({ id, slug: workspace.slug, paths });
    }
    return { pin, chats: rows, workspaces };
  },
});


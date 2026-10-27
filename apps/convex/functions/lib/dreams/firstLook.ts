/**
 * A first look for everyone Tex texts with who still has no `tex/about-me.md`
 * (`docs/decisions/texting-assistant/dreams.md`, "A first look").
 *
 * The owner (Dev2), 2026-10-17: "some users do not have an about me and a
 * first look at their workspaces, can you please fix this?" Their first dream
 * had run, found no texts and no front page, and written nothing; it still
 * counted as dreamed, so no later night dreamed again until they texted. The
 * gateway now treats any dream with no note as a first look around the
 * workspace that always starts the note (`apps/mcp/src/agent/dream.js`); this
 * makes that dream due now for the people the old one left out.
 *
 * Only a schedule row, as every arming is: whether the dream runs, and as
 * whom, is asked again when it is handed out. It never writes a note itself,
 * so a note that exists is never touched, and each person gets this once
 * (`firstLookAt`), so someone whose workspace really is empty is not dreamed
 * about every hour.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { personalWorkspaceOf } from "../../textLinks";
import { nodeAt } from "../nodes/paths";

/** Tex's note about the person (`apps/mcp/src/agent/aboutMe.js`). */
export const ABOUT_ME_PATH = "tex/about-me.md";

/**
 * A phone linked this recently is left to onboarding, which writes the note
 * itself after reading their mail (`ai/production/skills/onboarding.md` starts
 * when the note is missing, so a sweep must not beat it there).
 */
export const FIRST_LOOK_AFTER_LINK_MS = 24 * 60 * 60 * 1000;

/** Whether the workspace's tree has a live `tex/about-me.md`. */
async function hasAboutMe(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const node = await nodeAt(ctx.db, workspaceId, ABOUT_ME_PATH);
  return node !== null && node.goneAt === undefined;
}

/**
 * Hourly (`crons.ts`): make a dream due now for each person with a phone
 * linked a day or more who has no about-me, no dream already waiting, and no
 * first look before. Returns how many it armed.
 */
export async function armFirstLooksHandler(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  const seen = new Set<string>();
  let armed = 0;
  for (const link of await ctx.db.query("phoneLinks").take(2000)) {
    if (seen.has(link.userId)) continue;
    seen.add(link.userId);
    if (link._creationTime + FIRST_LOOK_AFTER_LINK_MS > now) continue;
    const row = await ctx.db
      .query("texDreams")
      .withIndex("by_user", (q) => q.eq("userId", link.userId))
      .first();
    // Once each; and a dream already armed (or under way) does the first look itself.
    if (row !== null && (row.firstLookAt !== undefined || row.nextDreamAt !== null || row.claimedAt !== undefined)) continue;
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (workspaceId === null) continue;
    if (await hasAboutMe(ctx, workspaceId)) continue;
    if (row === null) {
      await ctx.db.insert("texDreams", { userId: link.userId, workspaceId, nextDreamAt: now, firstLookAt: now, updatedAt: now });
    } else {
      await ctx.db.patch(row._id, { workspaceId, nextDreamAt: now, firstLookAt: now, updatedAt: now });
    }
    armed += 1;
  }
  return armed;
}

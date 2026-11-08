import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "./fixtures.helpers";

/** Turn `flagId` on for `userId` in `people` mode, as the console's Features tab would. */
export async function turnOnFlagFor(t: TestConvex, flagId: string, userId: Id<"users">): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    const row = await ctx.db
      .query("featureFlags")
      .withIndex("by_flag", (q) => q.eq("flagId", flagId))
      .first();
    if (row === null) await ctx.db.insert("featureFlags", { flagId, mode: "people", updatedAt: now, updatedBy: userId });
    await ctx.db.insert("featureFlagPeople", { flagId, userId, addedAt: now, addedBy: userId });
  });
}

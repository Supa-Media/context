import { describe, expect, test } from "vitest";
import { chatHomeKeys } from "../functions/lib/nodes/accessSet";
import { setupTest } from "./fixtures.helpers";

/**
 * THE PIN'S ACCESS SET NAMES EACH CHAT HOME'S KEY BY ITS WORDS, AS `chatKeyOfHome` WOULD (2026-11-20;
 * `functions/lib/nodes/accessSet.ts` `chatHomeKeys`).
 *
 * The workspace object places a new note in a group chat's home in that chat's Tex object from this map, without
 * asking the control plane, so it must answer exactly what `chatKeyOfHome` answers: a home's one chat, and nothing for
 * words two chats name or for a chat with no home.
 *
 * Sabotage record: keeping the first chat for shared words (dropping the `null` mark) → the shared-words assertion fails.
 */
describe("chat home keys", () => {
  test("each home's key by its words, none for shared words or a chat with no home", async () => {
    const t = setupTest();
    const one = "a".repeat(64);
    const two = "b".repeat(64);
    const three = "c".repeat(64);
    await t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: one, lastSeenAt: 1, homeWords: "kite-willow-rocket" });
      await ctx.db.insert("textGroups", { groupKey: two, lastSeenAt: 1, homeWords: "amber-fox-lake" });
      await ctx.db.insert("textGroups", { groupKey: three, lastSeenAt: 1, homeWords: "amber-fox-lake" });
      await ctx.db.insert("textGroups", { groupKey: "d".repeat(64), lastSeenAt: 1 });
    });
    const keys = await t.run(async (ctx) => await chatHomeKeys(ctx));
    expect(keys).toEqual({ "kite-willow-rocket": one });
  });
});

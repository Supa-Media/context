/**
 * A MAIL, CHAT OR CALENDAR PASS TELLS AN OPEN CONSOLE WHAT IT WROTE.
 *
 * The forward sync writes channel-day notes straight into the bucket from
 * inside `runFileOperation`, and returns before the barrier's own tree
 * announcement runs — so a new day of mail appeared in somebody's tree only at
 * the next periodic walk. These pin the hint to what the pass actually wrote:
 * a day it wrote moves the hint of whoever can see that day, and a pass that
 * wrote nothing moves nothing, because the writers already skip a day whose
 * bytes are unchanged.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { enableMailSync, endToEnd, googleAndBucket, runPass } from "./fixtures.helpers";

describe("a forward sync pass and the tree hint", () => {
  beforeEach(() => enableMailSync());

  test("a day of mail it wrote moves the owner's hint, and a pass that wrote nothing does not", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = googleAndBucket({
      backend,
      history: { messageIds: ["msg-1"], historyId: "1100" },
      messages: [
        {
          id: "msg-1",
          date: "2026-09-08T09:14:00.000Z",
          subject: "Quarterly numbers",
          text: "The numbers are attached.",
        },
      ],
    });
    vi.stubGlobal("fetch", google.fetchImpl);
    const hint = () =>
      asUser(t, owner).query(api.functions.treeSignals.treeSignal, { workspaceId });
    expect(await hint()).toBeNull();

    await runPass(t, workspaceId, connectionId);
    const first = await hint();
    expect(first).not.toBeNull();
    const rows = await t.run((ctx) => ctx.db.query("treeSignals").collect());
    expect(rows.map((row) => row.audience)).toEqual(["private"]);

    // The same mail again: every day renders to the bytes already there, so
    // nothing is written and nobody is sent to re-walk.
    await t.run(async (ctx) => {
      const row = (await ctx.db.get(connectionId))!;
      await ctx.db.patch(connectionId, {
        gmail: { ...row.gmail!, historyId: "1000" },
        syncStartedAt: Date.now(),
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runPass(t, workspaceId, connectionId);
    expect(await hint()).toBe(first);
  });
});

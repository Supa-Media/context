/**
 * The meaning index census counts rows and names none: its answer goes to a
 * public workflow log.
 *
 * Sabotage: returning `workspaceId` in `largest` is refused by the return
 * validator, and adding `indexName` to the key fails "names no workspace".
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { twoConnectedTenants } from "./controlPlane/fixtures.helpers";

describe("meaning index census", () => {
  test("counts by status and code, largest first, and names no workspace or index", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("meaningIndexes", {
        workspaceId: aliceWs, enabled: true, enabledAt: now, status: "failed", errorCode: "REFUSED", errorCause: "http_400",
        indexName: "context-meaning-alice-secret", notesIndexed: 9000, createdAt: now, updatedAt: now - 7_200_000,
      });
      await ctx.db.insert("meaningIndexes", {
        workspaceId: bobWs, enabled: true, enabledAt: now, status: "ready", indexName: "context-meaning-bob-secret",
        notesIndexed: 40, createdAt: now, updatedAt: now,
      });
    });
    const answer = await t.query(internal.functions.meaningCensus.run, {});
    expect(answer.rows).toBe(2);
    expect(answer.byState).toEqual({ "failed/on/REFUSED/http_400": 1, "ready/on": 1 });
    expect(answer.largest[0]).toMatchObject({ notesIndexed: 9000, status: "failed", errorCode: "REFUSED", hoursSinceUpdate: 2 });
    const text = JSON.stringify(answer);
    for (const secret of [aliceWs, bobWs, "alice-secret", "bob-secret"]) expect(text).not.toContain(secret);
  });
});

/**
 * A legacy guest chat's turn may take its people off a folder (`clearGuests`, `lib/textGroupGuestSync.ts`), so the
 * gateway route runs it inside `objectFirst` for the chat's workspace (`functions/textGroupsMarked.ts`). Production's
 * report of unmarked narrowings named `textGroups.applyGroupTurn` (2026-11-02). Every other chat's turn runs as it
 * did, with no mark and no wait.
 *
 * Sabotage, each confirmed to fail a case here: have `guestChatWorkspace` answer null for every chat (the guest chat's
 * turn runs unmarked), or have the route call the turn straight (the same).
 */

import { getFunctionName } from "convex/server";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { agentTextsGroupHandler } from "../functions/lib/gatewayRoutes/agentTextGroups";
import { groupKeyOf } from "../functions/textGroups";
import { createUser, createWorkspace, setupTest } from "./fixtures.helpers";

const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";

describe("a group chat's turn and the workspace's object", () => {
  test("only a legacy guest chat with a workspace names one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "guest-chat@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "guest-chat", { kind: "shared" });
    const keys = { guest: "a".repeat(64), plain: "b".repeat(64), unbound: "c".repeat(64) };
    await t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: keys.guest, lastSeenAt: 1, workspaceId, guestFolder: "tex/chats/legacy" });
      await ctx.db.insert("textGroups", { groupKey: keys.plain, lastSeenAt: 1, workspaceId });
      await ctx.db.insert("textGroups", { groupKey: keys.unbound, lastSeenAt: 1, guestFolder: "tex/chats/none" });
    });
    const asked = (groupKey: string) => t.query(internal.functions.textGroupsMarked.guestChatWorkspace, { groupKey });
    expect(await asked(keys.guest)).toBe(workspaceId);
    expect(await asked(keys.plain)).toBeNull();
    expect(await asked(keys.unbound)).toBeNull();
    expect(await asked("d".repeat(64))).toBeNull();
  });

  /** The route, with the control plane stubbed: which mutations it ran, in order. */
  async function routeRuns(guestWorkspace: string | null): Promise<string[]> {
    const ran: string[] = [];
    const ctx = {
      runQuery: async (ref: Parameters<typeof getFunctionName>[0], args: { groupKey?: string }) => {
        const name = getFunctionName(ref);
        if (name === "functions/textGroupsMarked:guestChatWorkspace") {
          expect(args.groupKey).toBe(await groupKeyOf(LINE, GROUP));
          return guestWorkspace as Id<"workspaces"> | null;
        }
        // Nothing waits to reach the object.
        return false;
      },
      runMutation: async (ref: Parameters<typeof getFunctionName>[0]) => {
        const name = getFunctionName(ref);
        ran.push(name);
        // A workspace not judged in its object: no mark is needed, and the turn runs as before.
        if (name === "functions/workspaceObjectMarks:open") return false;
        return { status: "refused" };
      },
    };
    const response = await agentTextsGroupHandler(ctx as never, { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, LINE] });
    expect(await response.json()).toEqual({ status: "refused" });
    return ran;
  }

  test("a legacy guest chat's turn is told to its workspace's object first", async () => {
    expect(await routeRuns("ws-guest")).toEqual(["functions/workspaceObjectMarks:open", "functions/textGroups:applyGroupTurn"]);
  });

  test("any other chat's turn runs with no mark", async () => {
    expect(await routeRuns(null)).toEqual(["functions/textGroups:applyGroupTurn"]);
  });
});

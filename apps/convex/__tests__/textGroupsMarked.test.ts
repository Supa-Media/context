/**
 * A legacy guest chat's turn may take its people off a folder (`clearGuests`, `lib/textGroupGuestSync.ts`), and a
 * chat with a home may take somebody who left off the home's row in the pinned workspace (`makeChatHome`), so the
 * gateway route runs the turn inside `objectFirst` for each workspace it may touch (`functions/textGroupsMarked.ts`).
 * Production's report of unmarked narrowings named both (2026-11-02). Every other chat's turn runs as it did, with no
 * mark and no wait.
 *
 * Sabotage, each confirmed to fail a case here: have `turnWorkspaces` leave out the guest chat's workspace, or the
 * pinned one for a home, or have the route call the turn straight.
 */

import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { agentTextsGroupHandler } from "../functions/lib/gatewayRoutes/agentTextGroups";
import { groupKeyOf } from "../functions/textGroups";
import { createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { pinnedWorld } from "./pinnedReaders.helpers";

const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
    const asked = (groupKey: string) => t.query(internal.functions.textGroupsMarked.turnWorkspaces, { groupKey });
    expect(await asked(keys.guest)).toEqual([workspaceId]);
    expect(await asked(keys.plain)).toEqual([]);
    expect(await asked(keys.unbound)).toEqual([]);
    expect(await asked("d".repeat(64))).toEqual([]);
  });

  test("a chat with a home names the pinned workspace, and one without a home yet does not", async () => {
    const w = await pinnedWorld();
    const keys = { homed: "e".repeat(64), homeless: "f".repeat(64) };
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: keys.homed, lastSeenAt: 1, homeWords: "amber-brook-cedar" });
      await ctx.db.insert("textGroups", { groupKey: keys.homeless, lastSeenAt: 1 });
    });
    const asked = (groupKey: string) => w.t.query(internal.functions.textGroupsMarked.turnWorkspaces, { groupKey });
    expect(await asked(keys.homed)).toEqual([w.pinned]);
    expect(await asked(keys.homeless)).toEqual([]);
  });

  /** The route, with the control plane stubbed: which mutations it ran, in order. */
  async function routeRuns(marked: string[]): Promise<string[]> {
    const ran: string[] = [];
    const ctx = {
      runQuery: async (ref: Parameters<typeof getFunctionName>[0], args: { groupKey?: string }) => {
        const name = getFunctionName(ref);
        if (name === "functions/textGroupsMarked:turnWorkspaces") {
          expect(args.groupKey).toBe(await groupKeyOf(LINE, GROUP));
          return marked as Id<"workspaces">[];
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
    expect(await routeRuns(["ws-guest"])).toEqual(["functions/workspaceObjectMarks:open", "functions/textGroups:applyGroupTurn"]);
  });

  test("a guest chat with a home is told to both objects before its turn", async () => {
    const opened = ["functions/workspaceObjectMarks:open", "functions/workspaceObjectMarks:open"];
    expect(await routeRuns(["ws-guest", "ws-pinned"])).toEqual([...opened, "functions/textGroups:applyGroupTurn"]);
  });

  test("any other chat's turn runs with no mark", async () => {
    expect(await routeRuns([])).toEqual(["functions/textGroups:applyGroupTurn"]);
  });
});

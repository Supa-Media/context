/**
 * The pinned workspace's move to "team means members" (`functions/pinnedAccounts.ts`;
 * `docs/decisions/privacy-and-sharing/all-context-users.md`).
 *
 *  - Every `team` row gets the `accounts` view grant, except the bug reports, so what every account read stays
 *    readable by every account and the bug reports become members only.
 *  - The switch that makes pin readers guests flips on the last page of that pass, and not before.
 *  - Every row in the old Members position, notes and folders alike, becomes base `team` with the grant removed.
 *  - It is idempotent and pages, and touches no workspace but the pinned one.
 *
 * Every value here is fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `grantAccounts` passing over nothing under the bug roots. → "every team row but the bug reports" fails.
 *  2. `membersToTeam` skipping folders (`row.kind !== "file"`). → "notes and folders alike" fails, and so does
 *     `pinnedReaders.test.ts` "an ordinary MCP session ... reads a note under the folder".
 *  3. `flipSwitch` called on the first page instead of the last. → "the switch waits for the last page" fails.
 *  4. `grantAccounts` not checking for an existing grant. → "a row that already has its grant gets no second one"
 *     fails.
 *  6. `page` running the first pass after the switch. → "the first pass run again after the switch grants nothing"
 *     fails: the members' rows the second pass made get the accounts grant.
 *  5. `page` paging every workspace's rows instead of the pinned one's. → "no other workspace" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { createUser, createWorkspace, drainScheduled } from "./fixtures.helpers";
import { GUIDE, OLD_BUG, PLAN, migrate, pinnedWorld, setRow, type PinnedWorld } from "./pinnedReaders.helpers";
import { applyTreeObservation } from "./fixtures.helpers";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function rowAt(w: PinnedWorld, path: string, workspaceId: Id<"workspaces"> = w.pinned): Promise<Doc<"nodes">> {
  return await w.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    if (row === null) throw new Error(`no row at ${path}`);
    return row;
  });
}

/** The kinds of grant on a row, sorted. */
async function grantsOn(w: PinnedWorld, path: string, workspaceId: Id<"workspaces"> = w.pinned): Promise<string[]> {
  const row = await rowAt(w, path, workspaceId);
  return await w.t.run(async (ctx) =>
    (await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect())
      .map((grant) => `${grant.granteeKind}:${grant.role}`)
      .sort(),
  );
}

async function switchAt(w: PinnedWorld): Promise<number | undefined> {
  return await w.t.run(async (ctx) => (await ctx.db.query("nodeMigration").first())?.pinnedAccountsAt);
}

async function everyGrant(w: PinnedWorld): Promise<string[]> {
  return await w.t.run(async (ctx) =>
    (await ctx.db.query("nodeAccess").collect()).map((grant) => `${grant.nodeId}:${grant.granteeKind}:${grant.role}`).sort(),
  );
}

describe("the first pass", () => {
  test("every team row but the bug reports gets the accounts view grant", async () => {
    const w = await pinnedWorld();
    expect(await migrate(w)).toBe("started: accounts");
    expect(await grantsOn(w, "guides")).toEqual(["accounts:view"]);
    expect(await grantsOn(w, OLD_BUG)).toEqual([]);
    expect((await rowAt(w, OLD_BUG)).access).toEqual({ base: "team" });
    expect(await grantsOn(w, "1-projects/secret.md")).toEqual([]);
    expect(await switchAt(w)).toBeTypeOf("number");
  });

  test("the switch waits for the last page", async () => {
    const w = await pinnedWorld();
    await w.t.mutation(internal.functions.pinnedAccounts.page, { phase: "accounts", after: null, pageSize: 1 });
    // One page done, more to come: pin readers still read as members, and nothing they read is dark.
    expect((await switchAt(w)) ?? null).toBeNull();
  });

  test("a deployment with no pinned workspace only sets the switch", async () => {
    const w = await pinnedWorld();
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.pinned, { kind: "personal" } as never);
    });
    const before = await everyGrant(w);
    await migrate(w);
    expect(await everyGrant(w)).toEqual(before);
    expect(await switchAt(w)).toBeTypeOf("number");
  });
});

describe("the second pass", () => {
  test("notes and folders alike leave the Members position for base team, the grant removed", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    for (const path of [PLAN, "areas"]) {
      expect((await rowAt(w, path)).access).toEqual({ base: "team" });
      expect(await grantsOn(w, path)).toEqual([]);
    }
  });

  test("keeps the people named on a Members row", async () => {
    const w = await pinnedWorld();
    await setRow(w, PLAN, "private", [
      { kind: "members", role: "view" },
      { kind: "email", email: "pat@example.invalid", role: "edit" },
    ]);
    await migrate(w);
    expect((await rowAt(w, PLAN)).access).toEqual({ base: "team" });
    expect(await grantsOn(w, PLAN)).toEqual(["email:edit"]);
  });
});

describe("running it again", () => {
  test("a second run changes nothing, and starts at the pass the switch says is next", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const grants = await everyGrant(w);
    const flipped = await switchAt(w);
    expect(await migrate(w)).toBe("started: members");
    expect(await everyGrant(w)).toEqual(grants);
    expect(await switchAt(w)).toBe(flipped);
  });

  test("the first pass run again after the switch grants nothing, so a members' row stays members only", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const grants = await everyGrant(w);
    await w.t.mutation(internal.functions.pinnedAccounts.page, { phase: "accounts", after: null });
    await drainScheduled(w.t);
    expect(await everyGrant(w)).toEqual(grants);
  });

  test("a row that already has its grant gets no second one", async () => {
    const w = await pinnedWorld();
    await setRow(w, "guides", "team", [{ kind: "accounts", role: "view" }]);
    await migrate(w);
    expect(await grantsOn(w, "guides")).toEqual(["accounts:view"]);
  });

  test("one row a page ends where one big page does", async () => {
    const big = await pinnedWorld();
    await migrate(big);
    const small = await pinnedWorld();
    await migrate(small, 1);
    for (const path of ["guides", GUIDE, PLAN, "areas", OLD_BUG]) {
      expect(await grantsOn(small, path)).toEqual(await grantsOn(big, path));
      expect((await rowAt(small, path)).access).toEqual((await rowAt(big, path)).access);
    }
  });
});

describe("no other workspace", () => {
  test("a team row elsewhere gets no accounts grant, and a Members row elsewhere keeps its position", async () => {
    const w = await pinnedWorld();
    const owner = await createUser(w.t, "acme-owner@example.invalid");
    const acme = await createWorkspace(w.t, owner, "acme", { kind: "shared", displayName: "Acme" });
    await applyTreeObservation(w.t, {
      workspaceId: acme,
      at: 10,
      rows: [{ path: "team.md", etag: "e1", size: 1 }, { path: "members.md", etag: "e2", size: 1 }],
      gone: [],
     
    });
    await w.t.run(async (ctx) => {
      const at = (path: string) =>
        ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", acme).eq("path", path)).unique();
      const team = await at("team.md");
      const members = await at("members.md");
      await ctx.db.patch(team!._id, { access: { base: "team" } });
      await ctx.db.patch(members!._id, { access: { base: "private" } });
      await ctx.db.insert("nodeAccess", {
        workspaceId: acme,
        nodeId: members!._id,
        granteeKind: "members",
        role: "view",
        at: 1,
        source: "owner",
      });
    });
    await migrate(w);
    expect(await grantsOn(w, "team.md", acme)).toEqual([]);
    expect(await grantsOn(w, "members.md", acme)).toEqual(["members:view"]);
    expect((await rowAt(w, "members.md", acme)).access).toEqual({ base: "private" });
  });
});

/**
 * People an AI client adds to a note's list, once the person said yes (`nodesAccess.addGrantees`, the gateway's
 * `addGrantees` op). The gateway's egress gate decides whether the call may run at all; these pin what it does
 * when it runs.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - replace the list instead of adding (drop the held grants from the merge): "the people already named stay" fails;
 *  - let an editor's grant through: "an editor cannot name anybody" fails.
 */

import { describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { noteIdOf, PLAN, PLAN_MARKER, readByNoteId, setListFor, world, attachEmail } from "./outsider.helpers";

vi.setConfig({ testTimeout: 30_000 });

async function grantsOn(w: Awaited<ReturnType<typeof world>>, path: string) {
  return await w.t.run(async (ctx) => {
    const node = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", path))
      .unique();
    return await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", node!._id))
      .collect();
  });
}

describe("an AI client adds people to one note, after the person's yes", () => {
  test("an outsider named by email can then read the note, and the people already named stay", async () => {
    const w = await world();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.bob, role: "edit" }]);
    await attachEmail(w.t, w.kola, "kola.work@example.invalid");

    const answer = await w.t.mutation(internal.functions.nodesAccess.addGrantees, {
      workspaceId: w.ws,
      path: PLAN,
      entries: [{ email: "Kola.Work@example.invalid", role: "view" }],
      actor: { userId: w.owner, role: "owner" },
    });

    expect(answer.ok).toBe(true);
    const grants = await grantsOn(w, PLAN);
    expect(grants.map((grant) => [grant.granteeKind, grant.granteeUserId ?? grant.granteeEmail, grant.role]).sort()).toEqual(
      [
        ["email", "kola.work@example.invalid", "view"],
        ["user", w.bob, "edit"],
      ].sort(),
    );
    expect(JSON.stringify(await readByNoteId(w, w.kola, await noteIdOf(w, PLAN)))).toContain(PLAN_MARKER);
  });

  test("naming somebody already on the list changes their role and adds no second grant", async () => {
    const w = await world();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.bob, role: "view" }]);
    await w.t.mutation(internal.functions.nodesAccess.addGrantees, {
      workspaceId: w.ws,
      path: PLAN,
      entries: [{ email: "x@example.invalid", role: "view" }],
      actor: { userId: w.owner, role: "owner" },
    });
    await w.t.mutation(internal.functions.nodesAccess.addGrantees, {
      workspaceId: w.ws,
      path: PLAN,
      entries: [{ email: "X@example.invalid", role: "edit" }],
      actor: { userId: w.owner, role: "owner" },
    });
    const emails = (await grantsOn(w, PLAN)).filter((grant) => grant.granteeKind === "email");
    expect(emails.map((grant) => grant.role)).toEqual(["edit"]);
  });

  test("an editor cannot name anybody, and nothing is written", async () => {
    const w = await world();
    const answer = await w.t.mutation(internal.functions.nodesAccess.addGrantees, {
      workspaceId: w.ws,
      path: PLAN,
      entries: [{ email: "x@example.invalid", role: "view" }],
      actor: { userId: w.bob, role: "editor" },
    });
    expect(answer).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await grantsOn(w, PLAN)).toHaveLength(0);
  });

  test("one name that resolves to nobody refuses the whole call, with the one refusal", async () => {
    const w = await world();
    const answer = await w.t.mutation(internal.functions.nodesAccess.addGrantees, {
      workspaceId: w.ws,
      path: PLAN,
      entries: [
        { email: "x@example.invalid", role: "view" },
        { handle: "@nobody-holds-this-name", role: "view" },
      ],
      actor: { userId: w.owner, role: "owner" },
    });
    expect(answer).toEqual({ ok: false, code: "GRANTEE_NOT_FOUND" });
    expect(await grantsOn(w, PLAN)).toHaveLength(0);
  });
});

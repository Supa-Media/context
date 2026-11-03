/**
 * A removed member's grants, where the workspace's notes live in its object (`functions/accessMirrorGrants.ts`):
 * the access mirror leaves them to the object's `ws.write.dropGrantee` and opens no row outbox entry, and every answer
 * but the object's `ok` takes them out in Convex instead. Elsewhere the mirror takes them out itself, as before.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { dropInObject, type GranteeDropper } from "../functions/accessMirrorGrants";
import { addMember, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

async function world(home: "object" | "bucket") {
  const t = setupTest();
  const owner = await createUser(t, "drop-owner@example.com");
  await createWorkspace(t, owner, "drop-owner");
  const shared = await createWorkspace(t, owner, "drop-shared", { kind: "shared" });
  const member = await createUser(t, "drop-member@example.com");
  await createWorkspace(t, member, "drop-member");
  await addMember(t, shared, member, "editor", owner);
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceObjectHomes", { workspaceId: shared, home, since: 0, access: "object" });
    const nodeId = await ctx.db.insert("nodes", { workspaceId: shared, path: "1-projects", name: "1-projects", kind: "folder", observedAt: 1 });
    await ctx.db.insert("nodeAccess", { workspaceId: shared, nodeId, granteeKind: "user", granteeUserId: member, role: "edit", at: 1, source: "owner" });
  });
  return { t, owner, shared, member };
}

const grants = (t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) =>
  t.run(async (ctx) =>
    await ctx.db.query("nodeAccess").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("granteeUserId", userId)).collect(),
  );
const outbox = (t: TestConvex) => t.run(async (ctx) => await ctx.db.query("workspaceObjectOutbox").collect());
const scheduled = (t: TestConvex) => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name));
const remove = (shared: Id<"workspaces">, member: Id<"users">, by: Id<"users">) => ({
  workspaceId: shared,
  change: { op: "remove_member" as const, userId: String(member), at: 3, by: String(by) },
});

function dropper(answer: unknown | Error) {
  const calls: unknown[] = [];
  const client: GranteeDropper = {
    write: {
      dropGrantee: async (body) => {
        calls.push(body);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
  return { client, calls };
}

const runner = (t: TestConvex) => ({ runMutation: ((ref: never, args: never) => t.mutation(ref, args)) as never });

describe("a removed member's grants where the notes live in the object", () => {
  test("the mirror leaves them to the object, schedules the drop, and opens no row outbox entry", async () => {
    const { t, owner, shared, member } = await world("object");
    expect(await t.mutation(internal.functions.accessMirror.apply, remove(shared, member, owner))).toEqual({ applied: true });
    expect(await grants(t, shared, member)).toHaveLength(1);
    expect(await outbox(t)).toEqual([]);
    expect((await scheduled(t)).some((name) => name.includes("accessMirrorGrants"))).toBe(true);
  });

  test("the object's ok is the drop: Convex is left to the object's change, which comes back through the mirror", async () => {
    const { t, owner, shared, member } = await world("object");
    const { client, calls } = dropper({ ok: true, version: 5, dropped: 1 });
    expect(await dropInObject(runner(t), { workspaceId: shared, userId: member, actorUserId: owner, actorRole: "owner" }, client)).toBe("object");
    expect(calls).toEqual([{ kind: "user", id: member, actor: { role: "owner", userId: owner } }]);
    expect(await grants(t, shared, member)).toHaveLength(1);
  });

  test("an actor who is not an owner drops them as the person leaving, which the object allows", async () => {
    const { t, owner, shared, member } = await world("object");
    const { client, calls } = dropper({ ok: true, version: 5, dropped: 1 });
    await dropInObject(runner(t), { workspaceId: shared, userId: member, actorUserId: owner, actorRole: "editor" }, client);
    expect(calls).toEqual([{ kind: "user", id: member, actor: { role: "member", userId: member } }]);
  });

  for (const [why, answer] of [
    ["NOT_READY", { ok: false, code: "NOT_READY" }],
    ["a refusal", { ok: false, code: "FORBIDDEN" }],
    ["an unreachable object", new Error("down")],
  ] as const) {
    test(`${why} takes them out in Convex, watched, so the row push carries it`, async () => {
      const { t, owner, shared, member } = await world("object");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { client } = dropper(answer);
      expect(await dropInObject(runner(t), { workspaceId: shared, userId: member, actorUserId: owner, actorRole: "owner" }, client)).toBe("convex");
      expect(await grants(t, shared, member)).toEqual([]);
      expect((await outbox(t)).length).toBeGreaterThan(0);
    });
  }

  test("no client for the object takes them out in Convex", async () => {
    const { t, owner, shared, member } = await world("object");
    expect(await dropInObject(runner(t), { workspaceId: shared, userId: member, actorUserId: owner, actorRole: "owner" }, null)).toBe("convex");
    expect(await grants(t, shared, member)).toEqual([]);
  });
});

describe("a removed member's grants where the notes are in the bucket", () => {
  test("the mirror takes them out itself, with nothing scheduled for the object", async () => {
    const { t, owner, shared, member } = await world("bucket");
    expect(await t.mutation(internal.functions.accessMirror.apply, remove(shared, member, owner))).toEqual({ applied: true });
    expect(await grants(t, shared, member)).toEqual([]);
    expect((await scheduled(t)).some((name) => name.includes("accessMirrorGrants"))).toBe(false);
  });
});

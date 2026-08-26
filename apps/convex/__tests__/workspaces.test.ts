/**
 * Workspaces.
 *
 * A personal context and a shared context are the same row with different
 * membership, so most of what is worth testing is that nothing here
 * special-cases "personal" — and that a session resolves to a *set* of
 * contexts even when that set has one element.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

describe("createWorkspace", () => {
  test("creates the workspace, its name claim, and its owner membership together", async () => {
    const t = setupTest();
    const user = await createUser(t, "alice@example.invalid");
    const workspaceId = await createWorkspace(t, user, "atlas", {
      displayName: "Atlas",
    });

    const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
    expect(workspace).toMatchObject({
      slug: "atlas",
      displayName: "Atlas",
      kind: "personal",
      structureTemplate: "para",
      createdBy: user,
    });

    const names = await t.run((ctx) => ctx.db.query("names").collect());
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({ name: "atlas", kind: "workspace", workspaceId });

    const members = await t.run((ctx) =>
      ctx.db.query("workspaceMembers").collect(),
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ workspaceId, userId: user, role: "owner" });
  });

  test("defaults to the PARA scaffold but takes `custom`", async () => {
    const t = setupTest();
    const user = await createUser(t, "alice@example.invalid");

    const custom = await createWorkspace(t, user, "bring-my-own", {
      structureTemplate: "custom",
    });
    expect((await t.run((ctx) => ctx.db.get(custom)))?.structureTemplate).toBe(
      "custom",
    );
  });

  test("requires authentication", async () => {
    const t = setupTest();
    const error = await captureError(() =>
      t.mutation(api.functions.workspaces.createWorkspace, {
        slug: "atlas",
        displayName: "Atlas",
        kind: "personal",
      }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });

  test("rejects an empty or oversized display name without claiming the slug", async () => {
    const t = setupTest();
    const user = await createUser(t, "alice@example.invalid");

    for (const displayName of ["", "   ", "x".repeat(81)]) {
      const error = await captureError(() =>
        createWorkspace(t, user, "atlas", { displayName }),
      );
      expect(errorCode(error)).toBe("INVALID_DISPLAY_NAME");
    }
    expect(await t.run((ctx) => ctx.db.query("names").collect())).toHaveLength(0);
  });

  test("trims the display name but keeps it verbatim otherwise", async () => {
    const t = setupTest();
    const user = await createUser(t, "alice@example.invalid");
    const workspaceId = await createWorkspace(t, user, "atlas", {
      displayName: "  Alice's Second Brain  ",
    });
    expect((await t.run((ctx) => ctx.db.get(workspaceId)))?.displayName).toBe(
      "Alice's Second Brain",
    );
  });

  test("a shared workspace is the same row with a different kind", async () => {
    const t = setupTest();
    const user = await createUser(t, "alice@example.invalid");
    const personal = await createWorkspace(t, user, "alice", {
      kind: "personal",
    });
    const shared = await createWorkspace(t, user, "shared-thing", {
      kind: "shared",
    });

    const [a, b] = await Promise.all([
      t.run((ctx) => ctx.db.get(personal)),
      t.run((ctx) => ctx.db.get(shared)),
    ]);
    // Identical field sets — nothing about "shared" is modelled separately.
    expect(Object.keys(a!).sort()).toEqual(Object.keys(b!).sort());
  });
});

describe("listMyWorkspaces", () => {
  test("returns a set, not a single context, even for one workspace", async () => {
    const t = setupTest();
    const user = await createUser(t, "alice@example.invalid");
    const workspaceId = await createWorkspace(t, user, "atlas");

    const result = await asUser(t, user).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ workspaceId, role: "owner" });
  });

  test("includes contexts someone else granted the caller access to", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    const bobsOwn = await createWorkspace(t, bob, "bob-context");
    const alicesShared = await createWorkspace(t, alice, "shared-context", {
      kind: "shared",
    });
    await addMember(t, alicesShared, bob, "editor", alice);

    const result = await asUser(t, bob).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    const byId = new Map(result.map((w) => [w.workspaceId, w.role]));
    expect(byId.get(bobsOwn)).toBe("owner");
    expect(byId.get(alicesShared)).toBe("editor");
  });

  test("is empty for a user who has created nothing", async () => {
    const t = setupTest();
    const user = await createUser(t, "new@example.invalid");
    expect(
      await asUser(t, user).query(api.functions.workspaces.listMyWorkspaces, {}),
    ).toEqual([]);
  });
});

describe("getWorkspace", () => {
  test("returns the caller's role and the member count", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "shared-context", {
      kind: "shared",
      displayName: "Shared Context",
    });
    await addMember(t, workspaceId, bob, "member", alice);

    const asOwner = await asUser(t, alice).query(
      api.functions.workspaces.getWorkspace,
      { workspaceId },
    );
    expect(asOwner).toMatchObject({
      slug: "shared-context",
      displayName: "Shared Context",
      role: "owner",
      memberCount: 2,
    });

    const asMember = await asUser(t, bob).query(
      api.functions.workspaces.getWorkspace,
      { workspaceId },
    );
    expect(asMember.role).toBe("member");
  });
});

describe("listMembers", () => {
  test("names the people a shared context is shared with", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "shared-context", {
      kind: "shared",
    });
    await addMember(t, workspaceId, bob, "editor", alice);

    const members = await asUser(t, bob).query(
      api.functions.workspaces.listMembers,
      { workspaceId },
    );
    expect(members.map((m) => m.email).sort()).toEqual([
      "alice@example.invalid",
      "bob@example.invalid",
    ]);
    expect(members.find((m) => m.userId === bob)?.role).toBe("editor");
  });
});

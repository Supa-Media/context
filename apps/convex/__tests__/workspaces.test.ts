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

/**
 * Name squatting.
 *
 * `createWorkspace` used to require only authentication: no cap, no rate
 * limit, and — still — no release, rename, or delete path anywhere. An
 * adversarial review claimed 40 names from one account without resistance. The
 * namespace is `[a-z0-9-]{2,32}`, of which roughly 1.3k two-character and 46k
 * three-character names exist, so one account could exhaust the memorable end
 * of it in minutes, permanently. Names are the addressing scheme *and* a
 * future subdomain, which makes that availability loss and impersonation at
 * once.
 *
 * Both limits are deliberate product decisions (see `functions/workspaces.ts`
 * for the numbers and the reasoning); these tests pin that they exist and
 * apply per account, not the specific values.
 */
describe("one account cannot claim the namespace", () => {
  /** Names that are well-formed, unreserved, and distinct. */
  function candidates(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `context-name-${i}`);
  }

  async function createUntilRefused(
    t: ReturnType<typeof setupTest>,
    userId: Awaited<ReturnType<typeof createUser>>,
    attempts: string[],
    onWindowRollover?: () => Promise<void>,
  ): Promise<{ created: number; error: unknown }> {
    let created = 0;
    for (const slug of attempts) {
      try {
        await createWorkspace(t, userId, slug);
        created += 1;
        if (onWindowRollover) await onWindowRollover();
      } catch (error) {
        return { created, error };
      }
    }
    throw new Error("Expected creation to be refused, but it never was.");
  }

  test("a burst of creations is rate limited", async () => {
    const t = setupTest();
    const squatter = await createUser(t, "squatter@example.invalid");

    const { created, error } = await createUntilRefused(
      t,
      squatter,
      candidates(40),
    );

    expect(errorCode(error)).toBe("RATE_LIMITED");
    expect(created).toBeLessThan(40);
    // The refusal tells the client when to come back, rather than dead-ending.
    expect(
      (error as { data: { retryAfterMs: number } }).data.retryAfterMs,
    ).toBeGreaterThan(0);

    // Only the names that actually succeeded were taken out of the namespace.
    const claimed = await t.run((ctx) => ctx.db.query("names").collect());
    expect(claimed).toHaveLength(created);
  });

  test("a patient squatter still hits a hard cap on how many contexts they own", async () => {
    const t = setupTest();
    const squatter = await createUser(t, "squatter@example.invalid");

    // Waiting out the rate limit is exactly what a script would do, so expire
    // the window after every success and keep going.
    const expireWindow = async () => {
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("rateLimits").collect()) {
          await ctx.db.patch(row._id, { windowStartedAt: 0, count: 0 });
        }
      });
    };

    const { created, error } = await createUntilRefused(
      t,
      squatter,
      candidates(40),
      expireWindow,
    );

    expect(errorCode(error)).toBe("WORKSPACE_LIMIT_REACHED");
    expect(created).toBeLessThan(40);
    expect(await t.run((ctx) => ctx.db.query("names").collect())).toHaveLength(
      created,
    );
  });

  test("the limits are per account, so one squatter does not block anyone else", async () => {
    const t = setupTest();
    const squatter = await createUser(t, "squatter@example.invalid");
    const { created } = await createUntilRefused(t, squatter, candidates(40));
    expect(created).toBeGreaterThan(0);

    // A second person is unaffected by the first one's exhausted budget.
    const newcomer = await createUser(t, "newcomer@example.invalid");
    const workspaceId = await createWorkspace(t, newcomer, "atlas");
    expect(await t.run((ctx) => ctx.db.get(workspaceId))).not.toBeNull();
  });

  test("being invited into other people's contexts does not spend your own allowance", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    // Alice owns several shared contexts and adds Bob to all of them.
    for (let i = 0; i < 4; i += 1) {
      const shared = await createWorkspace(t, alice, `shared-${i}`, {
        kind: "shared",
      });
      await addMember(t, shared, bob, "member", alice);
    }

    // Bob can still create his own. Counting *memberships* rather than
    // ownership here would have let anyone exhaust someone else's allowance by
    // inviting them.
    const bobsOwn = await createWorkspace(t, bob, "bob-context");
    expect(await t.run((ctx) => ctx.db.get(bobsOwn))).not.toBeNull();
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

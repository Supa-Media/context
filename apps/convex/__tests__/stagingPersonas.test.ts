import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { setupTest, asUser, createUser } from "./fixtures.helpers";

beforeEach(() => {
  vi.stubEnv("APP_ENV", "staging");
  vi.stubEnv("APP_ORIGIN", "https://staging.context.lc");
  vi.stubEnv("STAGING_CONVEX_DEPLOYMENT", "example-deployment");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://example-deployment.convex.cloud");
});
afterEach(() => vi.unstubAllEnvs());

describe("isolated staging fixtures", () => {
  test.each([
    ["APP_ENV", "production"], ["APP_ORIGIN", "https://context.lc"],
    ["STAGING_CONVEX_DEPLOYMENT", ""], ["CONVEX_CLOUD_URL", "https://your-deployment.convex.cloud"],
  ])("refuses mismatched %s without writing", async (key, value) => {
    vi.stubEnv(key, value);
    const t = setupTest();
    await expect(t.mutation(internal.functions.stagingPersonas.prepare, {})).rejects.toThrow(/isolated staging/);
    expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(0);
  });
  test("seeds exactly five personas, preserves IDs, resets invitation acceptance", async () => {
    const t = setupTest();
    const first = await t.mutation(internal.functions.stagingPersonas.prepare, {});
    expect(first.workspaces).toHaveLength(5);
    const second = await t.mutation(internal.functions.stagingPersonas.prepare, {});
    expect(second).toEqual(first);
    const users = await t.run(ctx => ctx.db.query("users").collect());
    expect(users).toHaveLength(5);
    for (const who of ["beta", "gamma", "epsilon"]) {
      const user = users.find(u => u.email === `${who}@supa.media`)!;
      const workspaces = await asUser(t, user._id).query(api.functions.workspaces.listMyWorkspaces, {});
      expect(workspaces.some(w => w.kind === "personal")).toBe(false);
    }
    const epsilon = asUser(t, users.find(u => u.email === "epsilon@supa.media")!._id);
    const invites = await epsilon.query(api.functions.invitations.listMyInvitations, {});
    expect(invites).toHaveLength(1);
    await epsilon.mutation(api.functions.invitations.acceptInvitation, { token: invites[0].token });
    expect((await epsilon.query(api.functions.workspaces.listMyWorkspaces, {}))[0].role).toBe("editor");
    await t.mutation(internal.functions.stagingPersonas.prepare, { reset: true });
    expect(await epsilon.query(api.functions.workspaces.listMyWorkspaces, {})).toHaveLength(0);
    expect(await epsilon.query(api.functions.invitations.listMyInvitations, {})).toHaveLength(1);
  });
  test("name collisions roll back all fixture creation", async () => {
    const t = setupTest();
    const owner = await createUser(t, "unrelated@example.test");
    await asUser(t, owner).mutation(api.functions.workspaces.createWorkspace, { slug: "lumio", displayName: "Existing", kind: "shared" });
    await expect(t.mutation(internal.functions.stagingPersonas.prepare, { reset: true })).rejects.toThrow(/collision/);
    expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.query("workspaces").collect())).toHaveLength(1);
  });
  test("an unrelated member prevents fixture reset", async () => {
    const t = setupTest();
    const { workspaces } = await t.mutation(internal.functions.stagingPersonas.prepare, {});
    const owner = await createUser(t, "unrelated@example.test");
    await t.run(ctx => ctx.db.insert("workspaceMembers", { workspaceId: workspaces[2].workspaceId, userId: owner, role: "member", joinedAt: Date.now() }));
    await expect(t.mutation(internal.functions.stagingPersonas.prepare, { reset: true })).rejects.toThrow(/Non-fixture member/);
  });
});

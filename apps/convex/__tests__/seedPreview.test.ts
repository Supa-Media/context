import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { setupTest } from "./fixtures.helpers";
import type { TestConvex } from "./fixtures.helpers";

const PREVIEW_ENV = {
  APP_ENV: "preview",
  PREVIEW_NAME: "pr42",
  APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev",
  CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud",
  ADMIN_EMAILS: "staff@example.com",
};

function stubEnvironment(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

afterEach(() => vi.unstubAllEnvs());

/** Row counts of every table the preview seed writes, so a second run can be shown to add none. */
async function counts(t: TestConvex) {
  return t.run(async ctx => ({
    users: (await ctx.db.query("users").collect()).length,
    workspaces: (await ctx.db.query("workspaces").collect()).length,
    workspaceMembers: (await ctx.db.query("workspaceMembers").collect()).length,
    names: (await ctx.db.query("names").collect()).length,
    nodes: (await ctx.db.query("nodes").collect()).length,
    phoneLinks: (await ctx.db.query("phoneLinks").collect()).length,
    workspaceInvitations: (await ctx.db.query("workspaceInvitations").collect()).length,
  }));
}

describe("seed:preview refuses outside an isolated preview", () => {
  test("refuses on production and writes nothing", async () => {
    stubEnvironment({
      APP_ENV: "production",
      APP_ORIGIN: "https://context.lc",
      CONVEX_CLOUD_URL: "https://prod-example-1.convex.cloud",
      ADMIN_EMAILS: "staff@example.com",
    });
    const t = setupTest();
    await expect(t.mutation(internal.functions.seed.preview, {})).rejects.toThrow(/only on a preview deployment/);
    expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(0);
  });

  test("refuses on staging and writes nothing", async () => {
    stubEnvironment({
      APP_ENV: "staging",
      APP_ORIGIN: "https://staging.context.lc",
      STAGING_CONVEX_DEPLOYMENT: "example-deployment",
      CONVEX_CLOUD_URL: "https://example-deployment.convex.cloud",
      ADMIN_EMAILS: "staff@example.com",
    });
    const t = setupTest();
    await expect(t.mutation(internal.functions.seed.preview, {})).rejects.toThrow(/only on a preview deployment/);
    expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(0);
  });

  test("refuses a preview whose origin is not its own router", async () => {
    stubEnvironment({ ...PREVIEW_ENV, APP_ORIGIN: "https://context.lc" });
    const t = setupTest();
    await expect(t.mutation(internal.functions.seed.preview, {})).rejects.toThrow(/only on a preview deployment/);
    expect(await t.run(ctx => ctx.db.query("users").collect())).toHaveLength(0);
  });
});

describe("seed:preview on an isolated preview", () => {
  beforeEach(() => stubEnvironment(PREVIEW_ENV));

  test("creates the personas, workspaces, members, folders and the alpha phone link", async () => {
    const t = setupTest();
    const result = await t.mutation(internal.functions.seed.preview, {});

    expect(result.workspaces.map(w => w.slug)).toEqual(["alpha", "delta", "context-lc", "lumio", "maison-solenne", "common-ground", "beta-preview", "gamma"]);
    expect(result.phones).toEqual({ alpha: "+12125550101", beta: "+12125550102", gamma: "+12125550103" });
    expect(result.groupChat).toBeNull();

    const users = await t.run(ctx => ctx.db.query("users").collect());
    for (const who of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      expect(users.some(u => u.email === `${who}@supa.media`)).toBe(true);
    }

    const lumio = result.workspaces.find(w => w.slug === "lumio")!;
    const members = await t.run(ctx => ctx.db.query("workspaceMembers").withIndex("by_workspace", q => q.eq("workspaceId", lumio.workspaceId)).collect());
    expect(members.map(m => m.role).sort()).toEqual(["editor", "member", "owner"]);

    const folders = await t.run(ctx => ctx.db.query("nodes").withIndex("by_workspace_path", q => q.eq("workspaceId", lumio.workspaceId)).collect());
    const paths = folders.filter(f => f.kind === "folder" && f.goneAt === undefined).map(f => f.path).sort();
    expect(paths).toEqual(["projects", "projects/launch"]);
    const launch = folders.find(f => f.path === "projects/launch")!;
    const projects = folders.find(f => f.path === "projects")!;
    expect(launch.parentId).toBe(projects._id);

    const alpha = users.find(u => u.email === "alpha@supa.media")!;
    const links = await t.run(ctx => ctx.db.query("phoneLinks").withIndex("by_user", q => q.eq("userId", alpha._id)).collect());
    expect(links).toMatchObject([{ phone: "+12125550101", via: "text" }]);
  });

  test("each texting persona's phone resolves to its own account, and a second run adds no rows", async () => {
    const t = setupTest();
    const first = await t.mutation(internal.functions.seed.preview, {});
    const links = await t.run(ctx => ctx.db.query("phoneLinks").collect());
    const byPhone = Object.fromEntries(links.map(link => [link.phone, link.userId]));
    expect(Object.keys(byPhone).sort()).toEqual(["+12125550101", "+12125550102", "+12125550103"]);
    const accounts = new Set(Object.values(byPhone));
    expect(accounts.size).toBe(3);
    const users = await t.run(ctx => ctx.db.query("users").collect());
    const emailOf = (id: string) => users.find(u => u._id === id)?.email;
    expect(emailOf(byPhone["+12125550101"])).toBe("alpha@supa.media");
    expect(emailOf(byPhone["+12125550102"])).toBe("beta@supa.media");
    expect(emailOf(byPhone["+12125550103"])).toBe("gamma@supa.media");
    for (const phone of Object.keys(byPhone)) {
      const workspace = first.workspaces.find(w => w.owner === emailOf(byPhone[phone])!.split("@")[0]);
      expect(workspace?.slug).toBeDefined();
    }
    const before = await counts(t);
    await t.mutation(internal.functions.seed.preview, {});
    expect(await counts(t)).toEqual(before);
  });

  test("a second run creates nothing new and returns the same result", async () => {
    const t = setupTest();
    const first = await t.mutation(internal.functions.seed.preview, {});
    const afterFirst = await counts(t);
    const second = await t.mutation(internal.functions.seed.preview, {});
    expect(second).toEqual(first);
    expect(await counts(t)).toEqual(afterFirst);
  });

  test("refuses a fixture phone already linked to another account, and changes nothing", async () => {
    const t = setupTest();
    await t.mutation(internal.functions.seed.preview, {});
    const other = await t.run(ctx => ctx.db.insert("users", { email: "other@example.test", isActive: true, createdAt: Date.now() }));
    await t.run(async ctx => ctx.db.delete((await ctx.db.query("phoneLinks").collect())[0]._id));
    await t.run(ctx => ctx.db.insert("phoneLinks", { userId: other, phone: "+12125550101", linkedAt: Date.now(), via: "text" }));
    const before = await counts(t);
    await expect(t.mutation(internal.functions.seed.preview, {})).rejects.toThrow(/already linked/);
    expect(await counts(t)).toEqual(before);
  });
});

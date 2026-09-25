/**
 * The website route index is disposable metadata rebuilt from bucket files.
 * These tests keep the bucket authoritative and prove an incomplete or
 * cross-tenant refresh cannot publish somebody else's route state.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { WEBSITE_STARTER_MARKDOWN } from "@context/shared";
import { scanWebsiteRoutes } from "../functions/lib/websites/routes";
import { memoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => vi.unstubAllGlobals());

async function fixture(slug = "atlas", options: MemoryS3Options = {}) {
  const t = setupTest();
  const owner = await createUser(t, `${slug}@example.invalid`);
  const stranger = await createUser(t, `stranger-${slug}@example.invalid`);
  const member = await createUser(t, `member-${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await addMember(t, workspaceId, member, "member", owner);
  await createWorkspace(t, stranger, `${slug}-elsewhere`);
  const backend = memoryS3(FAKE_STORAGE.bucket, options);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", `# ${slug}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, member, stranger, workspaceId, backend };
}

describe("website route index", () => {
  test("a repeated manifest cursor fails closed instead of looping", async () => {
    const page = {
      kind: "manifest",
      entries: [],
      folders: [],
      cursor: "stuck",
      truncated: true,
      manifestUsable: true,
    };
    const ctx = {
      runAction: vi.fn().mockResolvedValue(page),
    } as unknown as ActionCtx;

    await expect(
      scanWebsiteRoutes(
        ctx,
        "0000000000000000010002workspaces" as Id<"workspaces">,
        { scope: "private", grantedNames: [] },
      ),
    ).rejects.toMatchObject({ data: { code: "WEBSITE_SCAN_INCOMPLETE" } });
    expect(ctx.runAction).toHaveBeenCalledTimes(2);
  });

  test("an incomplete bulk read fails closed instead of deleting old routes", async () => {
    const ctx = {
      runAction: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "manifest",
          entries: [{ path: "website/index.md" }],
          folders: [],
          cursor: null,
          truncated: false,
          manifestUsable: true,
        })
        .mockResolvedValueOnce({ kind: "notes", results: [] }),
    } as unknown as ActionCtx;

    await expect(
      scanWebsiteRoutes(
        ctx,
        "0000000000000000010002workspaces" as Id<"workspaces">,
        { scope: "private", grantedNames: [] },
      ),
    ).rejects.toMatchObject({ data: { code: "WEBSITE_SCAN_INCOMPLETE" } });
  });

  test("refreshes owner-facing statuses and persists metadata, never Markdown", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\nnav: 1\n---\n\n# Hello\n",
    );
    f.backend.seed(
      "website/team.md",
      "---\ntitle: Team\naudience: members\n---\n\nMembers\n",
    );

    const statuses = await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      { workspaceId: f.workspaceId },
    );
    expect(
      statuses.map((status) => [status.routePath, status.audience]),
    ).toEqual([
      ["/", "public"],
      ["/team", "members"],
    ]);

    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("websiteRouteIndex")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceEtag).every(Boolean)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("# Hello");
    expect(JSON.stringify(rows)).not.toContain("Members\\n");
  }, 15_000);

  test("reconciliation removes a route deleted from the bucket", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nHome\n");
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nAbout\n");
    await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      {
        workspaceId: f.workspaceId,
      },
    );
    f.backend.objects.delete("website/about.md");

    const statuses = await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      { workspaceId: f.workspaceId },
    );
    expect(statuses.map((status) => status.objectKey)).toEqual([
      "website/index.md",
    ]);
    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("websiteRouteIndex")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect(),
    );
    expect(rows.map((row) => row.objectKey)).toEqual(["website/index.md"]);
  });

  test("collisions and invalid metadata are indexed only as problems", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/about.md",
      "---\ntitle: About\naudience: everybody\n---\n\nAbout\n",
    );
    f.backend.seed(
      "website/about/index.md",
      "---\ntitle: Other\n---\n\nOther\n",
    );

    const statuses = await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      { workspaceId: f.workspaceId },
    );
    expect(statuses.every((status) => status.status === "problem")).toBe(true);
    expect(statuses[0]?.problems.map((problem) => problem.code)).toEqual([
      "route_collision",
      "invalid_metadata",
    ]);
  });

  test("a stranger cannot scan or infer another workspace", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Secret name\n---\n\nBody\n",
    );
    const before = f.backend.requests.length;

    const error = await captureError(() =>
      asUser(f.t, f.stranger).action(
        api.functions.websites.refreshRouteStatuses,
        {
          workspaceId: f.workspaceId,
        },
      ),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    expect(f.backend.requests).toHaveLength(before);
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("websiteRouteIndex")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
          .collect(),
      ),
    ).toEqual([]);
  });

  test("a clearance-filtered member scan cannot erase the owner index", async () => {
    const f = await fixture("atlas-clearance");
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nHome\n");
    await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      {
        workspaceId: f.workspaceId,
      },
    );

    // `website/` inherits private in the PARA fixture, so the member sees the
    // same empty snapshot as any ordinary file read at team clearance.
    await expect(
      asUser(f.t, f.member).action(
        api.functions.websites.refreshRouteStatuses,
        {
          workspaceId: f.workspaceId,
        },
      ),
    ).resolves.toEqual([]);
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("websiteRouteIndex")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
          .collect(),
      ),
    ).toHaveLength(1);
  });

  test("a failed bucket scan leaves the last complete derivative intact", async () => {
    const f = await fixture("atlas-failure");
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nHome\n");
    await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      {
        workspaceId: f.workspaceId,
      },
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("simulated storage outage");
    });

    await expect(
      asUser(f.t, f.owner).action(api.functions.websites.refreshRouteStatuses, {
        workspaceId: f.workspaceId,
      }),
    ).rejects.toThrow();
    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("websiteRouteIndex")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ routePath: "/", title: "Home" });
  });

  test("identical route paths remain isolated by workspace", async () => {
    const first = await fixture("atlas-first");
    first.backend.seed("website/index.md", "---\ntitle: First\n---\n\nFirst\n");
    await asUser(first.t, first.owner).action(
      api.functions.websites.refreshRouteStatuses,
      { workspaceId: first.workspaceId },
    );
    const rows = await first.t.run((ctx) =>
      ctx.db.query("websiteRouteIndex").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: first.workspaceId,
      routePath: "/",
    });
  });

  test("an older scan cannot replace a newer reconciliation", async () => {
    const f = await fixture("atlas-fence");
    const older = await f.t.mutation(
      internal.functions.websites.beginRouteReconciliation,
      { workspaceId: f.workspaceId },
    );
    const newer = await f.t.mutation(
      internal.functions.websites.beginRouteReconciliation,
      { workspaceId: f.workspaceId },
    );
    if (older === null || newer === null) {
      throw new Error("an explicit reconciliation must allocate a generation");
    }

    await expect(
      f.t.mutation(internal.functions.websites.commitRouteReconciliation, {
        workspaceId: f.workspaceId,
        generation: older,
        routes: [],
      }),
    ).resolves.toBe(false);
    await expect(
      f.t.mutation(internal.functions.websites.commitRouteReconciliation, {
        workspaceId: f.workspaceId,
        generation: newer,
        routes: [],
      }),
    ).resolves.toBe(true);
  });

  test("the unattended reconciler rebuilds enabled websites", async () => {
    const f = await fixture("atlas-scheduled");
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nHome\n");
    await f.t.run(async (ctx) => {
      await ctx.db.insert("websiteStates", {
        workspaceId: f.workspaceId,
        state: "enabled",
        enabledAt: Date.now(),
        enabledBy: f.owner,
        updatedAt: Date.now(),
      });
    });

    await f.t.action(internal.functions.websites.reconcileWorkspace, {
      workspaceId: f.workspaceId,
    });
    const rows = await f.t.run((ctx) =>
      ctx.db
        .query("websiteRouteIndex")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      routePath: "/",
      title: "Home",
      status: "live",
    });
    expect(f.backend.snapshot()["website/index.md"]).toBe(
      "---\ntitle: Home\n---\n\nHome\n",
    );
    expect(
      await f.t.run(
        async (ctx) =>
          await ctx.db
            .query("websiteStates")
            .withIndex("by_workspace", (q) =>
              q.eq("workspaceId", f.workspaceId),
            )
            .unique(),
      ),
    ).toMatchObject({ starterEnsuredAt: expect.any(Number) });
  }, 15_000);

  test("the unattended reconciler repairs one legacy missing starter, then respects later deletion", async () => {
    const f = await fixture("atlas-starter-repair");
    await f.t.run(async (ctx) => {
      await ctx.db.insert("websiteStates", {
        workspaceId: f.workspaceId,
        state: "enabled",
        enabledAt: Date.now(),
        enabledBy: f.owner,
        updatedAt: Date.now(),
      });
    });

    await expect(
      f.t.action(internal.functions.websites.reconcileWorkspace, {
        workspaceId: f.workspaceId,
      }),
    ).resolves.toBe(true);
    expect(f.backend.snapshot()["website/index.md"]).toBe(
      WEBSITE_STARTER_MARKDOWN,
    );
    expect(
      await f.t.run(
        async (ctx) =>
          await ctx.db
            .query("websiteStates")
            .withIndex("by_workspace", (q) =>
              q.eq("workspaceId", f.workspaceId),
            )
            .unique(),
      ),
    ).toMatchObject({ starterEnsuredAt: expect.any(Number) });

    f.backend.objects.delete("website/index.md");
    await expect(
      f.t.action(internal.functions.websites.reconcileWorkspace, {
        workspaceId: f.workspaceId,
      }),
    ).resolves.toBe(true);
    expect(f.backend.snapshot()["website/index.md"]).toBeUndefined();
  }, 15_000);

  test("a failed legacy starter repair stays retryable and publishes no empty index", async () => {
    const f = await fixture("atlas-starter-failure", {
      refuseWrite: (key) => key === "website/index.md",
    });
    await f.t.run(async (ctx) => {
      await ctx.db.insert("websiteStates", {
        workspaceId: f.workspaceId,
        state: "enabled",
        enabledAt: Date.now(),
        enabledBy: f.owner,
        updatedAt: Date.now(),
      });
    });

    await expect(
      f.t.action(internal.functions.websites.reconcileWorkspace, {
        workspaceId: f.workspaceId,
      }),
    ).rejects.toMatchObject({ data: { code: "STORAGE_FAILED" } });
    const state = await f.t.run(
      async (ctx) =>
        await ctx.db
          .query("websiteStates")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
          .unique(),
    );
    expect(state?.starterEnsuredAt).toBeUndefined();
    expect(
      await f.t.run((ctx) =>
        ctx.db
          .query("websiteRouteIndex")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
          .collect(),
      ),
    ).toEqual([]);
  }, 15_000);
});

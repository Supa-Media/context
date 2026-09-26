/**
 * Website addresses prefer bucket-backed routes and preserve live named
 * shares only as a compatibility fallback when no website route owns a path.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryS3 } from "./storeStub.helpers";
import { publishWebsiteFolder } from "./website.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

afterEach(() => vi.unstubAllGlobals());

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: ReturnType<typeof memoryS3>;
}

async function fixture(slug = "atlas"): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, `${slug}-owner@example.invalid`);
  const member = await createUser(t, `${slug}-member@example.invalid`);
  const stranger = await createUser(t, `${slug}-stranger@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug, {
    displayName: slug === "atlas" ? "Atlas Studio" : slug,
  });
  await addMember(t, workspaceId, member, "member", owner);
  await createWorkspace(t, stranger, `${slug}-elsewhere`);
  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", `# ${slug}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, member, stranger, workspaceId, backend };
}

async function publish(f: Fixture): Promise<void> {
  await publishWebsiteFolder(f.t, f.owner, f.workspaceId);
  await f.t.run(async (ctx) => {
    await ctx.db.insert("websiteStates", {
      workspaceId: f.workspaceId,
      state: "enabled",
      enabledAt: Date.now(),
      enabledBy: f.owner,
      updatedAt: Date.now(),
    });
  });
  await asUser(f.t, f.owner).action(
    api.functions.websites.refreshRouteStatuses,
    { workspaceId: f.workspaceId },
  );
}

async function claimLegacyLink(
  f: Fixture,
  slug: string,
): Promise<Id<"noteShares">> {
  await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
    workspaceId: f.workspaceId,
    path: "index.md",
    visibility: "team",
  });
  const { token } = await asUser(f.t, f.owner).action(
    api.functions.shares.createLinkShare,
    { workspaceId: f.workspaceId, path: "index.md" },
  );
  const shares = await asUser(f.t, f.owner).query(
    api.functions.shares.listShares,
    { workspaceId: f.workspaceId },
  );
  const share = shares.find((candidate) => candidate.token === token);
  if (share === undefined) throw new Error("legacy share fixture is missing");
  await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
    shareId: share.shareId,
    slug,
  });
  return share.shareId;
}

describe("website-first address resolution", () => {
  test("keeps a live named share as a compatibility fallback when no website route owns its path", async () => {
    const f = await fixture();
    await claimLegacyLink(f, "intake");

    await expect(
      f.t.action(api.functions.websites.resolveAddress, {
        handle: "@ATLAS",
        routePath: "/intake",
      }),
    ).resolves.toEqual({
      kind: "legacy_short_link",
      handle: "atlas",
      slug: "intake",
    });
    await expect(
      f.t.query(internal.functions.websites.previewAddress, {
        handle: "atlas",
        slug: "intake",
      }),
    ).resolves.toEqual({ owned: false, title: null });
    await expect(
      f.t.action(api.functions.shares.readShortLink, {
        handle: "atlas",
        slug: "intake",
      }),
    ).resolves.toMatchObject({ kind: "note", text: "# atlas\n" });
    await expect(
      f.t.action(api.functions.websites.resolveAddress, {
        handle: "atlas",
        routePath: "/",
        legacySlug: "intake",
      }),
    ).resolves.toEqual({
      kind: "legacy_short_link",
      handle: "atlas",
      slug: "intake",
    });
  });

  test("a website file wins over a legacy named share at the same path", async () => {
    const f = await fixture();
    await claimLegacyLink(f, "intake");
    f.backend.seed(
      "website/intake.md",
      "---\ntitle: Website intake\n---\n\nWebsite body\n",
    );
    await publish(f);

    await expect(
      f.t.action(api.functions.websites.resolveAddress, {
        handle: "atlas",
        routePath: "/intake",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      title: "Website intake",
      markdown: "Website body\n",
    });
    await expect(
      f.t.action(api.functions.shares.readShortLink, {
        handle: "atlas",
        slug: "intake",
      }),
    ).rejects.toThrow();
    await expect(
      f.t.query(internal.functions.websites.previewAddress, {
        handle: "atlas",
        slug: "intake",
      }),
    ).resolves.toEqual({ owned: true, title: "Website intake" });
  });

  test("a custom-domain homepage preview wins over its configured legacy home slug", async () => {
    const f = await fixture();
    await claimLegacyLink(f, "intake");
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Website home\n---\n\nHome body\n",
    );
    await publish(f);

    await expect(
      f.t.query(internal.functions.websites.previewAddress, {
        handle: "atlas",
        slug: "intake",
        routePath: "/",
      }),
    ).resolves.toEqual({ owned: true, title: "Website home" });
    await expect(
      f.t.query(internal.functions.websites.previewAddress, {
        handle: "atlas",
        slug: "intake",
      }),
    ).resolves.toEqual({ owned: false, title: null });
  });

  test("draft, broken, and stale website claims do not fall through to a named share", async () => {
    const f = await fixture();
    await claimLegacyLink(f, "intake");
    f.backend.seed(
      "website/intake.md",
      "---\ntitle: Draft intake\ndraft: true\n---\n\nNot published\n",
    );
    await publish(f);
    const unavailable = {
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    };
    await expect(
      f.t.action(api.functions.websites.resolveAddress, {
        handle: "atlas",
        routePath: "/intake",
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      f.t.query(internal.functions.websites.previewAddress, {
        handle: "atlas",
        slug: "intake",
      }),
    ).resolves.toEqual({ owned: true, title: null });

    f.backend.seed(
      "website/intake.md",
      "---\ntitle: Broken intake\naudience: everyone\n---\n\nNot valid\n",
    );
    await asUser(f.t, f.owner).action(
      api.functions.websites.refreshRouteStatuses,
      { workspaceId: f.workspaceId },
    );
    await expect(
      f.t.action(api.functions.websites.resolveAddress, {
        handle: "atlas",
        routePath: "/intake",
      }),
    ).resolves.toEqual(unavailable);

    await claimLegacyLink(f, "missing");
    await f.t.run(async (ctx) => {
      const state = await ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        routeGeneration: (state?.routeGeneration ?? 0) + 1,
      });
    });
    await expect(
      f.t.action(api.functions.websites.resolveAddress, {
        handle: "atlas",
        routePath: "/missing",
      }),
    ).resolves.toEqual(unavailable);
  });

  test("revoked and nested legacy addresses stay unavailable", async () => {
    const f = await fixture();
    const shareId = await claimLegacyLink(f, "intake");
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId,
    });

    for (const routePath of ["/intake", "/writing/intake"]) {
      await expect(
        f.t.action(api.functions.websites.resolveAddress, {
          handle: "atlas",
          routePath,
          legacySlug: "intake",
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        siteName: null,
        navigation: [],
      });
    }
  });

});

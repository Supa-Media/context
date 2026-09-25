/**
 * Public website resolution is one server decision: handle, lifecycle,
 * derivative freshness, audience, membership and current bucket bytes are
 * checked before any Markdown is returned.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryS3 } from "./storeStub.helpers";
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

describe("public website resolution", () => {
  test("serves a public page from current bucket bytes with public navigation", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\ndescription: Hello there.\nnav: 2\n---\n\n# Welcome\n",
    );
    f.backend.seed(
      "website/about.md",
      "---\ntitle: About\nnav: 1\n---\n\nAbout us\n",
    );
    f.backend.seed(
      "website/team.md",
      "---\ntitle: Team\naudience: members\nnav: 0\n---\n\nTeam\n",
    );
    await publish(f);

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "@ATLAS",
        routePath: "/",
      }),
    ).resolves.toEqual({
      kind: "page",
      siteName: "Atlas Studio",
      routePath: "/",
      audience: "public",
      title: "Home",
      description: "Hello there.",
      markdown: "# Welcome\n",
      navigation: [
        { routePath: "/about", title: "About" },
        { routePath: "/", title: "Home" },
      ],
    });
  });

  test("an anonymous members page returns only a server-built sign-in route", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/team.md",
      "---\ntitle: Team\naudience: members\n---\n\nPrivate body\n",
    );
    await publish(f);
    const before = f.backend.requests.length;

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/team",
      }),
    ).resolves.toEqual({
      kind: "authentication_required",
      siteName: "Atlas Studio",
      navigation: [],
      signInPath: "/login?next=%2F%40atlas%2Fteam",
    });
    expect(f.backend.requests).toHaveLength(before);
  });

  test("a current member may read a members page", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/team.md",
      "---\ntitle: Team\naudience: members\n---\n\nPrivate body\n",
    );
    await publish(f);

    await expect(
      asUser(f.t, f.member).action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/team",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      audience: "members",
      markdown: "Private body\n",
    });
  });

  test("revoking membership removes access before the next bucket read", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/team.md",
      "---\ntitle: Team\naudience: members\n---\n\nPrivate body\n",
    );
    await publish(f);
    const member = asUser(f.t, f.member);
    await expect(
      member.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/team",
      }),
    ).resolves.toMatchObject({ kind: "page" });

    const membership = await f.t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", f.workspaceId).eq("userId", f.member),
        )
        .unique(),
    );
    await f.t.run((ctx) => ctx.db.delete(membership!._id));
    const before = f.backend.requests.length;

    await expect(
      member.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/team",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    });
    expect(f.backend.requests).toHaveLength(before);
  });

  test("a signed-in non-member gets the same unavailable shape and no bucket read", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/team.md",
      "---\ntitle: Team\naudience: members\n---\n\nPrivate body\n",
    );
    await publish(f);
    const before = f.backend.requests.length;

    await expect(
      asUser(f.t, f.stranger).action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/team",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    });
    expect(f.backend.requests).toHaveLength(before);
  });

  test("disabled and unknown sites expose no shell and never open storage", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nSecret\n");
    const before = f.backend.requests.length;
    const unavailable = { kind: "unavailable", siteName: null, navigation: [] };

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toEqual(unavailable);
    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "nobody-here",
        routePath: "/",
      }),
    ).resolves.toEqual(unavailable);
    expect(f.backend.requests).toHaveLength(before);
  });

  test("draft, problem and absent routes share one diagnostic-free answer", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/draft.md",
      "---\ntitle: Draft\ndraft: true\n---\n\nDraft\n",
    );
    f.backend.seed(
      "website/broken.md",
      "---\ntitle: Broken\naudience: everyone\n---\n\nBroken\n",
    );
    await publish(f);
    const unavailable = {
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    };

    for (const routePath of ["/draft", "/broken", "/missing"]) {
      await expect(
        f.t.action(api.functions.websites.resolvePage, {
          handle: "atlas",
          routePath,
        }),
      ).resolves.toEqual(unavailable);
    }
  });

  test("a stale generation fails closed before opening the bucket", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nOld\n");
    await publish(f);
    await f.t.run(async (ctx) => {
      const state = await ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        routeGeneration: (state?.routeGeneration ?? 0) + 1,
      });
    });
    const before = f.backend.requests.length;

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    });
    expect(f.backend.requests).toHaveLength(before);
  });

  test("a successful website write invalidates the derivative immediately", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nOld\n");
    await publish(f);
    const rawEtag = f.backend.objects.get("website/index.md")?.etag;
    if (rawEtag === undefined) throw new Error("fixture page is missing");

    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "website/index.md",
      text: "---\ntitle: Home\naudience: members\n---\n\nChanged\n",
      expectedEtag: rawEtag,
    });
    const state = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(state?.routeGeneration).not.toBe(state?.routeReconciledGeneration);
    const before = f.backend.requests.length;
    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    });
    expect(f.backend.requests).toHaveLength(before);
  });

  test("changed source bytes are never served through a stale etag", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\nnav: 1\n---\n\nOld public body\n",
    );
    await publish(f);
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\naudience: members\n---\n\nNew private body\n",
    );

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toEqual({
      kind: "unavailable",
      siteName: "Atlas Studio",
      navigation: [],
    });
    expect(JSON.stringify(resolved)).not.toContain("body");
    const state = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(state?.routeGeneration).not.toBe(state?.routeReconciledGeneration);
  });
});

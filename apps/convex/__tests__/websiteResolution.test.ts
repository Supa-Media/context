/**
 * Public website resolution is one server decision: handle, lifecycle,
 * derivative freshness, audience, membership and current bucket bytes are
 * checked before any Markdown is returned.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

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

  test("publishes only live routes and currently readable anyone-shares as links", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      [
        "---",
        "title: Home",
        "---",
        "",
        "[[about|About us]]",
        "[Shared](../1-projects/shared.md#details)",
        "[Private](../1-projects/private.md)",
        "[[draft|Draft]]",
      ].join("\n"),
    );
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nAbout\n");
    f.backend.seed(
      "website/draft.md",
      "---\ntitle: Draft\ndraft: true\n---\n\nSecret draft\n",
    );
    f.backend.seed("1-projects/shared.md", "# Shared\n");
    f.backend.seed("1-projects/private.md", "# Private\n");
    await asUser(f.t, f.owner).action(
      api.functions.files.setDirectoryVisibility,
      {
        workspaceId: f.workspaceId,
        path: "1-projects",
        visibility: "team",
      },
    );
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/private.md",
      visibility: "private",
    });
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/draft.md",
      visibility: "team",
    });
    const { token } = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: "1-projects/shared.md" },
    );
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: "website/draft.md",
    });
    await publish(f);

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({
      kind: "page",
      markdown: [
        "[About us](/about)",
        `[Shared](/s/${token}#details)`,
        "[Private](../1-projects/private.md)",
        "[[draft|Draft]]",
      ].join("\n"),
    });

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      visibility: "private",
    });
    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      markdown: expect.stringContaining(
        "[Shared](../1-projects/shared.md#details)",
      ),
    });
  });

  test("evaluates folder lists from only the notes this public viewer may open", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      [
        "---",
        "title: Home",
        "---",
        "",
        "```list",
        "from: website",
        "sort: title",
        "```",
        "",
        "```list",
        "from: 1-projects",
        "sort: title",
        "```",
      ].join("\n"),
    );
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nAbout\n");
    f.backend.seed(
      "website/members.md",
      "---\ntitle: Members\naudience: members\n---\n\nMembers\n",
    );
    f.backend.seed(
      "website/draft.md",
      "---\ntitle: Hidden draft\ndraft: true\n---\n\nDraft\n",
    );
    f.backend.seed(
      "1-projects/shared.md",
      "---\ntitle: Shared project\n---\n\nShared\n",
    );
    f.backend.seed(
      "1-projects/private.md",
      "---\ntitle: Private project\n---\n\nPrivate\n",
    );
    await asUser(f.t, f.owner).action(
      api.functions.files.setDirectoryVisibility,
      { workspaceId: f.workspaceId, path: "1-projects", visibility: "team" },
    );
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/private.md",
      visibility: "private",
    });
    const { token } = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: "1-projects/shared.md" },
    );
    await publish(f);

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).toContain("[About](/about)");
    expect(resolved.markdown).toContain(`[Shared project](/s/${token})`);
    expect(resolved.markdown).not.toContain("Members");
    expect(resolved.markdown).not.toContain("Hidden draft");
    expect(resolved.markdown).not.toContain("Private project");
    expect(resolved.markdown).not.toContain("```list");

    const memberView = await asUser(f.t, f.member).action(
      api.functions.websites.resolvePage,
      { handle: "atlas", routePath: "/" },
    );
    expect(memberView).toMatchObject({ kind: "page" });
    if (memberView.kind !== "page") throw new Error("expected a member page");
    expect(memberView.markdown).toContain("[Members](/members)");
  });

  test("removes a shared list row immediately when its share is revoked", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\n---\n\n```list\nfrom: 1-projects\n```\n",
    );
    f.backend.seed(
      "1-projects/shared.md",
      "---\ntitle: Shared project\n---\n\nShared\n",
    );
    await asUser(f.t, f.owner).action(
      api.functions.files.setDirectoryVisibility,
      { workspaceId: f.workspaceId, path: "1-projects", visibility: "team" },
    );
    const { token } = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: "1-projects/shared.md" },
    );
    await publish(f);

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      markdown: expect.stringContaining(`[Shared project](/s/${token})`),
    });

    const [share] = await asUser(f.t, f.owner).query(
      api.functions.shares.listShares,
      { workspaceId: f.workspaceId },
    );
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: share.shareId,
    });

    const afterRevoke = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(afterRevoke).toMatchObject({ kind: "page" });
    if (afterRevoke.kind !== "page") throw new Error("expected a website page");
    expect(afterRevoke.markdown).not.toContain("Shared project");
    expect(afterRevoke.markdown).not.toContain(token);
  });

  test("excludes a list route whose bucket bytes drifted and invalidates the index", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\n---\n\n```list\nfrom: website\n```\n",
    );
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nOld\n");
    await publish(f);
    f.backend.seed(
      "website/about.md",
      "---\ntitle: Secret now\naudience: members\n---\n\nChanged\n",
    );

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).not.toContain("About");
    expect(resolved.markdown).not.toContain("Secret now");

    const state = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(state?.routeGeneration).not.toBe(state?.routeReconciledGeneration);
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

  test("a stale index keeps the last complete menu while live bytes are changing", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nOld\n");
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

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      title: "Home",
      navigation: [{ routePath: "/", title: "Home" }],
    });
  });

  test("an incomplete autosave serves the last good page instead of Nothing here", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\nnav: 1\n---\n\nThe published page.\n",
    );
    await publish(f);

    // A text editor can persist between the opening and closing frontmatter
    // delimiters. That intermediate file is not a request to take the site
    // down; it is simply not a publishable revision yet.
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Editing right now\nnav: 1\n\nHalf-written frontmatter.\n",
    );
    await expect(
      f.t.action(internal.functions.websites.reconcileWorkspace, {
        workspaceId: f.workspaceId,
      }),
    ).resolves.toBe(false);

    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      title: "Home",
      markdown: "The published page.\n",
      navigation: [{ routePath: "/", title: "Home" }],
    });

    f.backend.seed(
      "website/index.md",
      "---\ntitle: Finished\nnav: 1\n---\n\nThe complete edit.\n",
    );
    await expect(
      f.t.action(internal.functions.websites.reconcileWorkspace, {
        workspaceId: f.workspaceId,
      }),
    ).resolves.toBe(true);
    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      title: "Finished",
      markdown: "The complete edit.\n",
    });
  });

  test("an ordinary edit is served as saved, not refused until the rebuild", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nOld\n");
    await publish(f);
    f.backend.seed("website/index.md", "---\ntitle: Hello\n---\n\nHi, I'm Atlas.\n");

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page", title: "Hello" });
    expect(JSON.stringify(resolved)).toContain("Hi, I'm Atlas.");
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
    // The page became members-only: the stale public row cannot serve it.
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

  test("a restriction written in the same save as a problem is still a restriction", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\nnav: 0\n---\n\nHome\n",
    );
    f.backend.seed(
      "website/notes.md",
      "---\ntitle: Board notes\nnav: 1\n---\n\nAnyone may read this.\n",
    );
    await publish(f);

    // Taking a page private and clearing it to rewrite it is one save. The
    // empty body makes the page a "problem", but `audience: members` parsed
    // cleanly and says exactly what the owner wants; the last good release is
    // a public copy of the very page they just restricted.
    f.backend.seed(
      "website/notes.md",
      "---\ntitle: Board notes\nnav: 1\naudience: members\n---\n",
    );
    await expect(
      f.t.action(internal.functions.websites.reconcileWorkspace, {
        workspaceId: f.workspaceId,
      }),
    ).resolves.toBe(false);

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/notes",
    });
    expect(resolved).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(resolved)).not.toContain("Anyone may read this.");
    expect(JSON.stringify(resolved)).not.toContain("Board notes");
  });

  test("an audience the parser cannot read is never resolved as public", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\nnav: 0\n---\n\nHome\n",
    );
    f.backend.seed(
      "website/notes.md",
      "---\ntitle: Board notes\nnav: 1\n---\n\nAnyone may read this.\n",
    );
    await publish(f);

    // `Members` is not a value the parser accepts, so the page is a problem
    // and its parsed audience falls back to the permissive default. An
    // audience line that does not say `public` is not evidence of consent to
    // keep serving the public copy.
    f.backend.seed(
      "website/notes.md",
      "---\ntitle: Board notes\nnav: 1\naudience: Members\n---\n\nStill here.\n",
    );

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/notes",
    });
    expect(resolved).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(resolved)).not.toContain("Anyone may read this.");
  });

  test("a members page keeps its autosave grace, because its release is not wider", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\nnav: 0\n---\n\nHome\n",
    );
    f.backend.seed(
      "website/notes.md",
      "---\ntitle: Board notes\nnav: 1\naudience: members\n---\n\nMembers read this.\n",
    );
    await publish(f);

    // The same half-finished save, on a page the index already holds as
    // members-only. Its release was never public, and this reader passed the
    // membership gate to get here, so refusing it would be the release
    // fallback failing at the one case it exists for.
    f.backend.seed(
      "website/notes.md",
      "---\ntitle: Board notes\nnav: 1\naudience: members\n---\n",
    );
    await expect(
      asUser(f.t, f.member).action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/notes",
      }),
    ).resolves.toMatchObject({
      kind: "page",
      title: "Board notes",
      audience: "members",
      markdown: "Members read this.\n",
    });

    // And nobody else is handed it on the way past.
    await expect(
      f.t.action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/notes",
      }),
    ).resolves.toMatchObject({ kind: "authentication_required" });
    await expect(
      asUser(f.t, f.stranger).action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath: "/notes",
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });
});

/**
 * `privacy.md` decides what a website publishes, on every serving path.
 *
 * A website is the owner's folder link over `website/`: pages, menu entries
 * and list rows are read at `team` scope with no granted names, so a note the
 * manifest holds back is absent from the site whatever its frontmatter says,
 * and `audience: members` only narrows further. Each refusal below is checked
 * twice where it matters — through a fresh route index, and through the
 * bucket probe that serves an address the index has not caught up with —
 * because a fix to one path alone would pass half of these and leave the
 * other half open.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { asUser, drainScheduled } from "./fixtures.helpers";
import {
  fixture,
  publish,
  publishWebsiteFolder,
  type Fixture,
} from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const SECRET = "Only the owner should ever read this.";

const resolveAs = (f: Fixture, routePath: string, user?: Fixture["owner"]) =>
  user === undefined
    ? f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath })
    : asUser(f.t, user).action(api.functions.websites.resolvePage, {
        handle: "atlas",
        routePath,
      });

/**
 * A private exception inside the published folder. The folder rule goes first:
 * an exception that restates its folder's default is not recorded, so marking
 * a note private while `website/` is still private would record nothing.
 */
async function setNotePrivate(f: Fixture, path: string): Promise<void> {
  await publishWebsiteFolder(f.t, f.owner, f.workspaceId);
  await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
    workspaceId: f.workspaceId,
    path,
    visibility: "private",
  });
}

async function indexRows(f: Fixture) {
  return await f.t.run((ctx) =>
    ctx.db
      .query("websiteRouteIndex")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .collect(),
  );
}

async function websiteState(f: Fixture) {
  return await f.t.run((ctx) =>
    ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique(),
  );
}

/** Drop the committed index, so the next request goes through the probe. */
async function forgetIndex(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const state = await ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique();
    await ctx.db.patch(state!._id, { routeReconciledGeneration: undefined });
  });
}

const privacyText = (f: Fixture): string => f.backend.snapshot()[PRIVACY_KEY] ?? "";

const paths = ["indexed", "probed"] as const;

describe("a note privacy.md holds back is never served", () => {
  for (const path of paths) {
    test(`a private note with no audience is refused to anonymous readers (${path})`, async () => {
      const f = await fixture();
      f.backend.seed("website/index.md", HOME);
      f.backend.seed("website/diary.md", `---\ntitle: Diary\nnav: 2\n---\n\n${SECRET}\n`);
      await setNotePrivate(f, "website/diary.md");
      await publish(f);
      if (path === "probed") await forgetIndex(f);

      const page = await resolveAs(f, "/diary");
      expect(page).toMatchObject({ kind: "unavailable" });
      expect(JSON.stringify(page)).not.toContain(SECRET);
      expect(JSON.stringify(page)).not.toContain("Diary");
      // Nor to a member, nor to the owner: the site publishes only what the
      // folder publishes to the workspace.
      for (const user of [f.member, f.owner]) {
        expect(JSON.stringify(await resolveAs(f, "/diary", user))).not.toContain(SECRET);
      }
      // The public page next to it still works.
      await expect(resolveAs(f, "/")).resolves.toMatchObject({ kind: "page", title: "Home" });
    });

    test(`a members page privacy.md holds back is refused to every member (${path})`, async () => {
      const f = await fixture();
      f.backend.seed("website/index.md", HOME);
      f.backend.seed(
        "website/team.md",
        `---\ntitle: Team\naudience: members\n---\n\n${SECRET}\n`,
      );
      await setNotePrivate(f, "website/team.md");
      await publish(f);
      if (path === "probed") await forgetIndex(f);

      for (const user of [undefined, f.member, f.stranger]) {
        const page = await resolveAs(f, "/team", user);
        expect(page).toMatchObject({ kind: "unavailable" });
        expect(JSON.stringify(page)).not.toContain(SECRET);
      }
    });

    test(`a members page pointed at a group is not served, even to the group (${path})`, async () => {
      const f = await fixture();
      f.backend.seed("website/index.md", HOME);
      f.backend.seed(
        "website/leads.md",
        `---\ntitle: Leads\naudience: members\n---\n\n${SECRET}\n`,
      );
      const group = await asUser(f.t, f.owner).mutation(api.functions.groups.createGroup, {
        workspaceId: f.workspaceId,
        label: "leads",
      });
      await asUser(f.t, f.owner).mutation(api.functions.groups.addGroupMember, {
        workspaceId: f.workspaceId,
        groupId: group.groupId,
        userId: f.member,
      });
      await asUser(f.t, f.owner).action(api.functions.files.setNoteGroup, {
        workspaceId: f.workspaceId,
        path: "website/leads.md",
        group: group.name,
      });
      await publish(f);
      if (path === "probed") await forgetIndex(f);

      const page = await resolveAs(f, "/leads", f.member);
      expect(page).toMatchObject({ kind: "unavailable" });
      expect(JSON.stringify(page)).not.toContain(SECRET);
    });
  }

  test("the committed index and menu hold only what the folder publishes", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/diary.md", "---\ntitle: Diary\nnav: 2\n---\n\nDiary\n");
    await setNotePrivate(f, "website/diary.md");
    await publish(f);

    expect((await indexRows(f)).map((row) => row.objectKey)).toEqual(["website/index.md"]);
    await expect(resolveAs(f, "/")).resolves.toMatchObject({
      navigation: [{ routePath: "/", title: "Home" }],
    });
  });

  test("the index does not depend on who last rebuilt it", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/diary.md", "---\ntitle: Diary\n---\n\nDiary\n");
    await setNotePrivate(f, "website/diary.md");
    await publish(f); // the owner's refresh
    const byOwner = (await indexRows(f)).map((row) => row.objectKey);

    await f.t.action(internal.functions.websites.reconcileWorkspace, {
      workspaceId: f.workspaceId,
    });
    const byReconcile = (await indexRows(f)).map((row) => row.objectKey);
    expect(byOwner).toEqual(["website/index.md"]);
    expect(byReconcile).toEqual(byOwner);
  });

  test("a folder list on a public page leaves out a note privacy.md holds back", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\n---\n\n```list\nfrom: website/posts\nsort: title\n```\n",
    );
    f.backend.seed("website/posts/open.md", "---\ntitle: Open post\n---\n\n# Open post\n");
    f.backend.seed("website/posts/closed.md", "---\ntitle: Closed post\n---\n\n# Closed post\n");
    await setNotePrivate(f, "website/posts/closed.md");
    await publish(f);

    const page = JSON.stringify(await resolveAs(f, "/"));
    expect(page).toContain("Open post");
    expect(page).not.toContain("Closed post");
  });
});

describe("making a published page private takes it off the site", () => {
  test("the live read refuses it at once, without the release fallback", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", `---\ntitle: About\nnav: 2\n---\n\n${SECRET}\n`);
    await publish(f);
    await expect(resolveAs(f, "/about")).resolves.toMatchObject({ kind: "page" });

    await setNotePrivate(f, "website/about.md");

    // The manifest change is a website change that may narrow a route, so the
    // menu is withheld until the rebuild lands.
    const state = await websiteState(f);
    expect(state?.routeUnsafeGeneration).toBeDefined();
    const page = await resolveAs(f, "/about");
    expect(page).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(page)).not.toContain(SECRET);
    expect(JSON.stringify(page)).not.toContain("About");
  });

  test("a privacy.md edited outside the product takes effect on the next request", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", `---\ntitle: About\n---\n\n${SECRET}\n`);
    await publish(f);
    await expect(resolveAs(f, "/about")).resolves.toMatchObject({ kind: "page" });

    // Obsidian, rclone or a text editor: no product event, the index is still
    // fresh, and only the live read can notice.
    const manifest = privacyText(f).replace(/^(\s*)website: team\s*$/m, "$1website: private");
    expect(manifest).not.toBe(privacyText(f));
    f.backend.seed(PRIVACY_KEY, manifest);

    const page = await resolveAs(f, "/about");
    expect(page).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(page)).not.toContain(SECRET);
  });

  test("an unreadable source does not fall back to a release while a restriction is pending", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", `---\ntitle: About\n---\n\n${SECRET}\n`);
    await publish(f);
    expect((await indexRows(f)).find((row) => row.objectKey === "website/about.md")?.releaseId)
      .toBeDefined();

    await setNotePrivate(f, "website/about.md");
    // Storage now fails every read: only the release could answer.
    vi.stubGlobal("fetch", async () => {
      throw new Error("simulated storage outage");
    });
    const page = await resolveAs(f, "/about");
    expect(JSON.stringify(page)).not.toContain(SECRET);
  });
});

describe("turning a website on writes the folder rule to privacy.md", () => {
  test("enabling marks website/ as team, and the homepage serves", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    await drainScheduled(f.t);

    expect(privacyText(f)).toMatch(/^\s*website: team\s*$/m);
    await expect(resolveAs(f, "/")).resolves.toMatchObject({ kind: "page" });
    expect((await websiteState(f))?.publicationRuleEnsuredAt).toBeDefined();
  });

  test("a website/ rule the owner already set to private is left alone, and nothing is served", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "website",
      visibility: "private",
    });
    await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    await drainScheduled(f.t);

    expect(privacyText(f)).toMatch(/^\s*website: private\s*$/m);
    expect(privacyText(f)).not.toMatch(/^\s*website: team\s*$/m);
    await expect(resolveAs(f, "/")).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("a site enabled before this rule existed is repaired once by the rebuild", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await f.t.run(async (ctx) => {
      await ctx.db.insert("websiteStates", {
        workspaceId: f.workspaceId,
        state: "enabled",
        enabledAt: Date.now(),
        enabledBy: f.owner,
        starterEnsuredAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await f.t.action(internal.functions.websites.reconcileWorkspace, {
      workspaceId: f.workspaceId,
    });

    expect(privacyText(f)).toMatch(/^\s*website: team\s*$/m);
    expect((await websiteState(f))?.publicationRuleEnsuredAt).toBeDefined();
    await expect(resolveAs(f, "/")).resolves.toMatchObject({ kind: "page", title: "Home" });

    // Once repaired, a later owner choice stands.
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "website",
      visibility: "private",
    });
    await f.t.action(internal.functions.websites.reconcileWorkspace, {
      workspaceId: f.workspaceId,
    });
    expect(privacyText(f)).toMatch(/^\s*website: private\s*$/m);
    await expect(resolveAs(f, "/")).resolves.toMatchObject({ kind: "unavailable" });
  });
});

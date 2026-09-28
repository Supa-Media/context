/**
 * A website page can name a folder, and the folder narrows.
 *
 * `folder: features` in `website/features.md` publishes the notes in
 * `features/` at `/features/<note>` without moving them. What that must never
 * do is widen the site: every note is still read at `team` scope with no
 * granted names, so a note `privacy.md` holds back by name, a private subfolder
 * and a note pointed at a group are absent through the folder exactly as they
 * would be in `website/`. And no page may name the whole context, `website/`
 * itself or Context's own `.context/`.
 *
 * SABOTAGE: scanning at `private` in `scanWebsiteRoutes` fails "a note held
 * back by name, a private subfolder and a group note are absent" (the served
 * page is still refused, by the resolver's own re-read); dropping the `startsWith(".")` segment check in
 * `websiteFolderPath` fails the refusal cases; dropping `folderListFor`'s own
 * page check lists the folder's notes on the home page too.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { websiteFolderPath, websiteFolderReference } from "@context/shared";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, pressPublish, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const FEATURES = "---\ntitle: Features\nnav: 2\nfolder: features\n---\n\nWhat Context does.\n";
const SECRET = "Only the owner should ever read this.";

const resolve = (f: Site, routePath: string, user?: Fixture["owner"]) =>
  user === undefined
    ? f.t.action(api.functions.websites.resolvePage, { handle: f.handle, routePath })
    : asUser(f.t, user).action(api.functions.websites.resolvePage, { handle: f.handle, routePath });

type Site = Fixture & { handle: string };

async function site(slug = "atlas"): Promise<Site> {
  const f = await fixture(slug);
  f.backend.seed("website/index.md", HOME);
  f.backend.seed("website/features.md", FEATURES);
  f.backend.seed(
    "features/forms.md",
    "---\ntitle: Forms\ndescription: Questions your notes can ask.\n---\n\nForms body\n",
  );
  f.backend.seed("features/tables.md", "# Tables\n\nTables body\n");
  await folderVisibility(f, "features", "team");
  return { ...f, handle: slug };
}

async function folderVisibility(f: Fixture, path: string, visibility: "team" | "private") {
  await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: f.workspaceId,
    path,
    visibility,
  });
}

async function indexedKeys(f: Fixture): Promise<string[]> {
  const rows = await f.t.run((ctx) =>
    ctx.db
      .query("websiteRouteIndex")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .collect(),
  );
  return rows.map((row) => row.objectKey).sort();
}

describe("a page that names a folder publishes its notes", () => {
  test("each note is a page under the folder page's address", async () => {
    const f = await site();
    await publish(f);

    const forms = await resolve(f, "/features/forms");
    expect(forms).toMatchObject({ kind: "page", routePath: "/features/forms", title: "Forms" });
    expect(JSON.stringify(forms)).toContain("Forms body");
    await expect(resolve(f, "/features/tables")).resolves.toMatchObject({
      kind: "page",
      title: "Tables",
    });
    // Nothing was copied: the notes stay where they were.
    expect(Object.keys(f.backend.snapshot()).filter((key) => key.startsWith("website/features/"))).toEqual(
      [],
    );
  });

  test("the folder page lists its notes, and no other page does", async () => {
    const f = await site();
    await publish(f);

    const page = await resolve(f, "/features");
    const text = JSON.stringify(page);
    expect(text).toContain("What Context does.");
    expect(text).toContain("/features/forms");
    expect(text).toContain("Questions your notes can ask.");
    expect(text).toContain("/features/tables");
    expect(JSON.stringify(await resolve(f, "/"))).not.toContain("/features/forms");
  });

  test("a folder nobody named publishes nothing", async () => {
    const f = await site();
    f.backend.seed("website/features.md", "---\ntitle: Features\n---\n\nNo folder line.\n");
    await publish(f);
    await expect(resolve(f, "/features/forms")).resolves.toMatchObject({ kind: "unavailable" });
    expect(await indexedKeys(f)).toEqual(["website/features.md", "website/index.md"]);
  });

  test("a page of the site's own keeps its address over a note of the folder's", async () => {
    const f = await site();
    f.backend.seed("website/features/forms.md", "---\ntitle: Our forms\n---\n\nThe site's own\n");
    await publish(f);
    const text = JSON.stringify(await resolve(f, "/features/forms"));
    expect(text).toContain("The site's own");
    expect(text).not.toContain("Forms body");
  });

  test("a draft folder page publishes nothing of its folder", async () => {
    const f = await site();
    f.backend.seed("website/features.md", `${FEATURES.replace("nav: 2\n", "nav: 2\ndraft: true\n")}`);
    await publish(f);
    await expect(resolve(f, "/features/forms")).resolves.toMatchObject({ kind: "unavailable" });
  });
});

describe("a folder never publishes what privacy.md holds back", () => {
  test("a note held back by name, a private subfolder and a group note are absent", async () => {
    const f = await site();
    f.backend.seed("features/diary.md", `---\ntitle: Diary\n---\n\n${SECRET}\n`);
    f.backend.seed("features/private/plan.md", `---\ntitle: Plan\n---\n\n${SECRET}\n`);
    f.backend.seed("features/leads.md", `---\ntitle: Leads\n---\n\n${SECRET}\n`);
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "features/diary.md",
      visibility: "private",
    });
    await folderVisibility(f, "features/private", "private");
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
      path: "features/leads.md",
      group: group.name,
    });
    await publish(f);

    expect(await indexedKeys(f)).toEqual([
      "features/forms.md",
      "features/tables.md",
      "website/features.md",
      "website/index.md",
    ]);
    for (const route of ["/features/diary", "/features/private/plan", "/features/leads"]) {
      for (const user of [undefined, f.member, f.owner]) {
        const page = await resolve(f, route, user);
        expect({ route, kind: page.kind }).toEqual({ route, kind: "unavailable" });
        expect(JSON.stringify(page)).not.toContain(SECRET);
      }
    }
    const list = JSON.stringify(await resolve(f, "/features"));
    for (const title of ["Diary", "Plan", "Leads"]) expect(list).not.toContain(title);
  });

  test("a folder privacy.md keeps private publishes nothing", async () => {
    const f = await site();
    await folderVisibility(f, "features", "private");
    await publish(f);
    await expect(resolve(f, "/features/forms")).resolves.toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(await resolve(f, "/features"))).not.toContain("/features/forms");
  });

  test("a restriction takes a note off at once, an edit waits for Publish", async () => {
    const f = await site();
    await publish(f);

    f.backend.seed("features/forms.md", "---\ntitle: Forms\n---\n\nHalf-typed words\n");
    const edited = JSON.stringify(await resolve(f, "/features/forms"));
    expect(edited).toContain("Forms body");
    expect(edited).not.toContain("Half-typed words");
    await pressPublish(f);
    expect(JSON.stringify(await resolve(f, "/features/forms"))).toContain("Half-typed words");

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "features/forms.md",
      visibility: "private",
    });
    const restricted = await resolve(f, "/features/forms");
    expect(restricted).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(restricted)).not.toContain("Half-typed words");
  });
});

describe("the homepage's sidebar", () => {
  test("the folder page opens its folder, with the notes it published inside", async () => {
    const f = await site("context-lc");
    await publish(f);
    const snapshot = await f.t.action(api.functions.websites.siteSnapshot, { handle: "context-lc" });
    expect(snapshot?.pages.map((page) => [page.path, page.routePath])).toEqual([
      ["index.md", "/"],
      ["features/index.md", "/features"],
      ["features/forms.md", "/features/forms"],
      ["features/tables.md", "/features/tables"],
    ]);
    const folderPage = snapshot!.pages.find((page) => page.routePath === "/features")!;
    expect(folderPage.markdown).toContain("[Forms](/features/forms) — Questions your notes can ask.");
  });
});

describe("the folders no page may name", () => {
  test.each([
    ["", "the whole context"],
    ["/", "the whole context"],
    ["website", "the site itself"],
    ["Website/blog", "the site itself"],
    [".context", "Context's own files"],
    ["notes/.context", "Context's own files"],
    ["../features", "outside the context"],
    ["features/../website", "outside the context"],
    ["a\\b", "an ambiguous path"],
    ["a%2Fb", "an ambiguous path"],
  ])("%j (%s)", (raw) => {
    expect(websiteFolderPath(raw)).toBeNull();
  });

  test("a folder is read from one plain line", () => {
    expect(websiteFolderReference("---\nfolder: features\n---\n")).toBe("features");
    expect(websiteFolderReference('---\nfolder: "/3-resources/guides/"\n---\n')).toBe("3-resources/guides");
    expect(websiteFolderReference("---\nfolder: a\nfolder: b\n---\n")).toBeNull();
    expect(websiteFolderReference("folder: features\n")).toBeNull();
  });
});

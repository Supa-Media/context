import { describe, expect, test } from "@jest/globals";
import { castPreviewFrom, castPreviewFragment } from "../features/home/castPreview";
import { castSite } from "../features/home/cast/castSite";
import { snapshotIcons } from "../features/home/homeSnapshot";
import { liveHomeTree } from "../features/home/homeSite";
import { SCENE_TITLE, editorSceneSrc } from "../features/landing/editorScene";

/*
  Page a's editor demo (Dev2, 2026-10-09): the homepage's own shell plays a
  scene in a PARA tree whose folders carry emoji. The scene travels as a cast
  preview, so it goes through the same checks a crafted address does.
*/

describe("page a's editor scene", () => {
  const snapshot = castPreviewFrom(editorSceneSrc().slice(1), { banner: false });

  test("reads back as a site: the scene first, then a page in each PARA folder", () => {
    expect(snapshot).not.toBeNull();
    expect(snapshot!.pages[0]!.title).toBe(SCENE_TITLE);
    const folders = new Set(snapshot!.pages.slice(1).map((page) => page.path!.split("/")[0]));
    expect([...folders]).toEqual(["inbox", "projects", "areas", "resources", "archive"]);
  });

  test("its cast has people typing and more than one AI writing", () => {
    const steps = [...castSite(snapshot!.pages).scripts.values()].flat();
    const people = new Set(steps.filter((step) => "actor" in step && step.actor.kind === "person").map((step) => (step as { actor: { name: string } }).actor.name));
    const agents = new Set(steps.filter((step) => "actor" in step && step.actor.kind === "agent").map((step) => (step as { actor: { name: string } }).actor.name));
    expect(people.size).toBeGreaterThanOrEqual(2);
    expect(agents.size).toBeGreaterThanOrEqual(3);
  });

  test("every folder's emoji lands on that folder in the tree", () => {
    const tree = liveHomeTree(snapshot!.pages, snapshot!.icons).tree;
    const folders = Object.values(tree.listings).flatMap((listing) => listing.entries.filter((entry) => entry.kind === "folder"));
    expect(folders.length).toBe(6);
    for (const folder of folders) expect(tree.icons?.[folder.path]).toEqual(expect.any(String));
  });
});

describe("folder icons a snapshot carries", () => {
  test("keeps one emoji per plain folder path", () => {
    expect(snapshotIcons({ projects: "🚀", "projects/launch": "🗓️" })).toEqual({ projects: "🚀", "projects/launch": "🗓️" });
  });

  test("drops anything that is not one emoji on a plain path", () => {
    const icons = snapshotIcons({
      ...JSON.parse('{"__proto__": "🚀"}'),
      "../up": "🚀",
      "/root": "🚀",
      ".context": "🚀",
      "a//b": "🚀",
      words: "not an emoji",
      two: "🚀🚀",
      number: 7,
    });
    expect(icons).toEqual({});
    expect(Object.getPrototypeOf(icons)).toBe(Object.prototype);
    expect(snapshotIcons(["🚀"])).toEqual({});
    expect(snapshotIcons(null)).toEqual({});
  });

  test("a crafted preview's icons are checked the same way", () => {
    const fragment = castPreviewFragment("# hi\n", "Hi", [{ name: "projects/x", title: "X", markdown: "# X\n" }], {}, {
      projects: "🚀",
      evil: "<img src=x>",
    });
    expect(castPreviewFrom(`#${fragment}`)!.icons).toEqual({ projects: "🚀" });
  });

  test("an icon for a folder the site does not have draws nowhere", () => {
    const tree = liveHomeTree([{ path: "projects/x.md", routePath: "/projects/x", title: "X", markdown: "" }], { areas: "🧭", projects: "🚀" }).tree;
    expect(Object.values(tree.icons ?? {})).toEqual(["🚀"]);
  });
});

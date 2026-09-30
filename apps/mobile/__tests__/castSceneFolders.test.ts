import { describe, expect, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { findAnchors } from "@context/shared/src/comments.cjs";
import { createSharedDoc, seedSharedDoc, type SharedDoc } from "../features/console/presence/sharedDoc";
import { createCastClock } from "../features/home/cast/castClock";
import { playCast } from "../features/home/cast/castRun";
import { castTimeline } from "../features/home/cast/castTimeline";
import { pageNamed } from "../features/home/cast/useHomeCast";
import { castPreviewFrom, castPreviewHref, previewPagePath, previewSlug } from "../features/home/castPreview";
import { liveHomeTree } from "../features/home/homeSite";
import type { HomeSnapshot } from "../features/home/homeSnapshot";
import { sceneOpens } from "../features/studio/scenePages";
import { scenePageReader } from "../features/console/panes/browsePane/castPreviewButton";

/*
  A scene's pages keep their folders (Dev2, 2026-09-30): `opens: inbox/james`
  showed James at the root of the preview's tree, beside the scene, because
  the carried page's name was slugged whole into `inbox-james`.
*/

const SCENE = [
  "# podcast plan",
  "",
  "Budget: $1,850",
  "",
  "```cast",
  "@maya's Codex opens: saved-decisions",
  "@maya's Codex reads",
  "@maya's Codex opens: I told Claude that",
  "@maya's Codex comments on \"$1,850\": you still owe Klarna $500.",
  "@maya's Codex opens: inbox/james",
  "@maya's Codex reads",
  "wait 2s",
  "@maya's Codex opens: I told Claude that",
  "@maya's Codex comments on \"$1,850\": you still owe James $700.",
  "@maya replies: is this a podcast plan or an intervention?",
  "```",
  "",
].join("\n");

const JAMES = "# James\n\nhey, the Cancun Airbnb was $700.\n";
const GOALS = "# Maya’s goals\n\n- do not let me start a podcast\n";

const PAGES = [
  { name: "saved-decisions", title: "Maya’s goals", markdown: GOALS },
  { name: "inbox/james", title: "James", markdown: JAMES },
];

function preview(pages = PAGES, source = SCENE): HomeSnapshot {
  const href = castPreviewHref(source, "I told Claude that", pages);
  return castPreviewFrom(href.slice(href.indexOf("#")))!;
}

/** The tree as the sidebar draws it: folders by name, notes by title. */
function sidebar(snapshot: HomeSnapshot): string[] {
  const { tree, pages } = liveHomeTree(snapshot.pages);
  const lines: string[] = [];
  const walk = (folder: string, depth: number) => {
    for (const entry of tree.listings[folder]!.entries) {
      const indent = "  ".repeat(depth);
      if (entry.kind === "folder") {
        lines.push(`${indent}▾ ${entry.path.slice(entry.path.lastIndexOf("/") + 1).replace(/^\d{2}-/, "")}`);
        walk(entry.path, depth + 1);
      } else lines.push(`${indent}${pages.get(entry.path)!.title}`);
    }
  };
  walk("", 0);
  return lines;
}

describe("a carried page's address", () => {
  test("keeps each folder as its own segment", () => {
    expect(previewPagePath("inbox/james")).toBe("inbox/james");
    expect(previewPagePath("Inbox/James.md")).toBe("inbox/james");
    expect(previewPagePath("clients/big deals/james")).toBe("clients/big-deals/james");
    expect(previewPagePath("/inbox//james/")).toBe("inbox/james");
    expect(previewPagePath("Pricing page")).toBe(previewSlug("Pricing page"));
  });

  test("never steps out of the scene or names nothing", () => {
    for (const name of ["", "/", "../james", "inbox/../../keys", "./james", "inbox/./james", "..\\keys", "inbox/!!!"]) {
      expect(previewPagePath(name)).toBeNull();
    }
  });
});

describe("the preview's tree", () => {
  test("puts James inside an expandable inbox folder, not beside the scene", () => {
    const snapshot = preview();
    expect(snapshot.pages.map((page) => page.path)).toEqual(["index.md", "saved-decisions.md", "inbox/james.md"]);
    expect(sidebar(snapshot)).toEqual(["I told Claude that", "Maya’s goals", "▾ inbox", "  James"]);
    const { tree } = liveHomeTree(snapshot.pages);
    expect(tree.defaultExpanded).toHaveLength(1);
  });

  test("deeper folders nest all the way down", () => {
    const snapshot = preview([{ name: "clients/acme/2026/james", title: "James", markdown: JAMES }]);
    expect(sidebar(snapshot)).toEqual(["I told Claude that", "▾ clients", "  ▾ acme", "    ▾ 2026", "      James"]);
  });

  test("inbox/james, clients/james and a root inbox-james are three pages", () => {
    const snapshot = preview([
      { name: "inbox/james", title: "James", markdown: "inbox\n" },
      { name: "clients/james", title: "James", markdown: "clients\n" },
      { name: "inbox-james", title: "Inbox James", markdown: "root\n" },
    ]);
    expect(snapshot.pages.map((page) => page.routePath)).toEqual(["/", "/inbox/james", "/clients/james", "/inbox-james"]);
    const byPath = new Map(snapshot.pages.map((page) => [page.path, page]));
    expect(pageNamed("inbox/james", byPath as never, {})).toBe("inbox/james.md");
    expect(pageNamed("clients/james", byPath as never, {})).toBe("clients/james.md");
    expect(pageNamed("inbox-james", byPath as never, {})).toBe("inbox-james.md");
    // The flat root page sorted first still does not answer for the folder.
    const rootFirst = new Map([...byPath].reverse());
    expect(pageNamed("inbox/james", rootFirst as never, {})).toBe("inbox/james.md");
    expect(sceneOpens(SCENE.replace("opens: saved-decisions", "opens: inbox-james"))).toEqual(["inbox-james", "I told Claude that", "inbox/james"]);
  });

  test("flat scenes and links made before folders still play as they did", () => {
    const snapshot = preview([{ name: "Pricing page", title: "Pricing", markdown: "# Pricing\n" }]);
    expect(snapshot.pages.map((page) => [page.path, page.routePath])).toEqual([
      ["index.md", "/"],
      ["pricing-page.md", "/pricing-page"],
    ]);
    expect(sidebar(snapshot)).toEqual(["I told Claude that", "Pricing"]);
  });

  test("a crafted address cannot carry a page from outside the scene", () => {
    const craft = (pages: unknown) =>
      `#cast-preview=${btoa(JSON.stringify({ title: "x", markdown: "# x\n", pages })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    expect(castPreviewFrom(craft([{ name: "../keys", title: "k", markdown: "" }]))).toBeNull();
    expect(castPreviewFrom(craft([{ name: "inbox/../../keys", title: "k", markdown: "" }]))).toBeNull();
    expect(castPreviewFrom(craft([{ name: "/inbox/james", title: "J", markdown: "" }]))!.pages[1]!.path).toBe("inbox/james.md");
  });
});

describe("playing the scene", () => {
  test("Codex opens James in the inbox, reads him, goes back and comments in the scene", () => {
    const snapshot = preview();
    const { markdown, steps, problems } = splitWebsiteCast(snapshot.pages[0]!.markdown);
    expect(problems).toEqual([]);
    const { pages } = liveHomeTree(snapshot.pages);
    const notes = Object.fromEntries([...pages].map(([path, page]) => [path, page.markdown]));
    const start = [...pages].find(([, page]) => page.routePath === "/")![0];
    const docs = new Map<string, SharedDoc>();
    const doc = (path: string, text: string) => {
      if (!docs.has(path)) {
        const shared = createSharedDoc({});
        seedSharedDoc(shared, text);
        docs.set(path, shared);
      }
      return docs.get(path)!;
    };
    const home = doc(start, markdown);
    const visited: string[] = [];
    const reads: string[] = [];
    const clock = createCastClock();
    let here = start;
    let ended = false;
    playCast(
      steps,
      home,
      {
        schedule: (ms, fn) => clock.schedule(ms, fn),
        instant: () => false,
        pageNamed: (name) => pageNamed(name, pages, notes),
        addNote: () => null,
        agentDid: (_actor, kind, path) => {
          if (kind === "read") reads.push(path);
        },
        room: () => {},
        ended: () => {
          ended = true;
        },
        open: (name) => {
          const target = pageNamed(name, pages, notes);
          if (target === null || target === here) return null;
          here = target;
          visited.push(pages.get(target)!.routePath);
          return { path: target, shared: doc(target, notes[target]!) };
        },
      },
      { path: start },
    );
    clock.rush(() => ended);
    expect(visited).toEqual(["/saved-decisions", "/", "/inbox/james", "/"]);
    expect(reads.map((path) => pages.get(path)!.routePath)).toEqual(["/saved-decisions", "/inbox/james"]);
    const scene = home.text.toString();
    expect([...findAnchors(scene).keys()]).toHaveLength(2);
    expect(scene).toContain("you still owe James $700.");
    expect(scene).toContain("is this a podcast plan or an intervention?");
    // James is read, never written to.
    const james = [...pages].find(([, page]) => page.routePath === "/inbox/james")![0];
    expect(docs.get(james)!.text.toString()).toContain("Cancun Airbnb");
    expect(docs.get(james)!.text.toString()).not.toContain("```comments");
  });

  test("the studio times the steps in James against his page", () => {
    const { markdown, steps } = splitWebsiteCast(SCENE);
    const byName = Object.fromEntries(PAGES.map((page) => [page.name, page.markdown]));
    expect(castTimeline(markdown, steps, byName).starts.every((start) => start !== null)).toBe(true);
  });
});

describe("the console reading a scene's pages", () => {
  test("finds inbox/james in the inbox folder beside the scene, and nothing outside it", async () => {
    const reads: string[] = [];
    const scene = "scenes/08-i-told-claude";
    const files = {
      listings: {
        [scene]: { entries: [{ kind: "file", path: `${scene}/inbox-james.md`, name: "inbox-james.md" }] },
        [`${scene}/inbox`]: { entries: [{ kind: "file", path: `${scene}/inbox/01-james.md`, name: "01-james.md" }] },
      },
      readRaw: async (path: string) => {
        reads.push(path);
        return { text: `# ${path}\n`, etag: "e" };
      },
    };
    const read = scenePageReader(files as never, `${scene}/index.md`);
    expect(await read("inbox/james")).toMatchObject({ name: "inbox/james", markdown: `# ${scene}/inbox/01-james.md\n` });
    expect(await read("inbox-james")).toMatchObject({ markdown: `# ${scene}/inbox-james.md\n` });
    expect(await read("clients/james")).toMatchObject({ markdown: `# ${scene}/clients/james.md\n` });
    for (const name of ["../secrets", "inbox/../../x", "./james", "inbox/./james", "..\\x", "/"]) expect(await read(name)).toBeNull();
    expect(reads).toEqual([`${scene}/inbox/01-james.md`, `${scene}/inbox-james.md`, `${scene}/clients/james.md`]);
  });
});

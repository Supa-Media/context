import { describe, expect, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { findAnchors } from "@context/shared/src/comments.cjs";
import { createSharedDoc, seedSharedDoc, type SharedDoc } from "../features/console/presence/sharedDoc";
import type { PresenceMember } from "../features/console/presence/protocol";
import { createCastClock } from "../features/home/cast/castClock";
import { playCast, type CastMoment } from "../features/home/cast/castRun";
import { castTimeline } from "../features/home/cast/castTimeline";
import { describeStep } from "../features/studio/studioScript";
import { sceneOpens } from "../features/studio/scenePages";
import { pageNamed } from "../features/home/cast/useHomeCast";
import { CAST_PREVIEW_BANNER, MAX_PREVIEW_PAGES, castPreviewFrom, castPreviewHref } from "../features/home/castPreview";
import { scenePageReader } from "../features/console/panes/browsePane/castPreviewButton";

/*
  A scene across several pages (Dev2, 2026-09-29, "Multiple notes would be
  amazing!"): `opens:` takes the show to another page and it carries on there.
*/

const HOME = "# Home\n\nWelcome in.\n\n```cast\nCAST\n```\n";
const PRICING = "# Pricing\n\nFree is free.\n";

function seeded(markdown: string): SharedDoc {
  const shared = createSharedDoc({});
  seedSharedDoc(shared, markdown);
  return shared;
}

function scene(script: string, pages: Record<string, string> = { pricing: PRICING }) {
  const { markdown, steps, problems } = splitWebsiteCast(HOME.replace("CAST", script));
  expect(problems).toEqual([]);
  const home = seeded(markdown);
  const opened = new Map<string, SharedDoc>();
  const rooms: string[][] = [];
  const cues: CastMoment[] = [];
  const writes: string[] = [];
  const clock = createCastClock();
  let ended = false;
  const run = playCast(
    steps,
    home,
    {
      schedule: (ms, fn) => clock.schedule(ms, fn),
      instant: () => false,
      pageNamed: () => null,
      addNote: (name) => `${name}.md`,
      agentDid: (_actor, kind, path) => {
        if (kind === "write") writes.push(path);
      },
      room: (members: PresenceMember[]) => rooms.push(members.map((member) => member.name)),
      cue: (moment) => cues.push(moment),
      ended: () => {
        ended = true;
      },
      open: (name) => {
        const markdown = pages[name.toLowerCase()];
        if (markdown === undefined) return null;
        const shared = seeded(markdown);
        opened.set(name.toLowerCase(), shared);
        return { path: `website/${name.toLowerCase()}.md`, shared };
      },
    },
    { path: "website/index.md" },
  );
  return {
    home,
    opened,
    rooms,
    cues,
    writes,
    run,
    clock,
    ended: () => ended,
    playTo: (done: () => boolean) => clock.rush(done),
  };
}

describe("the grammar", () => {
  test("opens a page, in the ways people write it", () => {
    const { steps, problems } = splitWebsiteCast(HOME.replace("CAST", "@maya opens: pricing\nClaude goes to Pricing\n@maya opens pricing page"));
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      { kind: "open", actor: { name: "@maya", kind: "person" }, page: "pricing" },
      { kind: "open", actor: { name: "Claude", kind: "agent" }, page: "Pricing" },
      { kind: "open", actor: { name: "@maya", kind: "person" }, page: "pricing page" },
    ]);
    expect(steps.map(describeStep)).toEqual(["opens pricing", "opens Pricing", "opens pricing page"]);
  });
});

describe("playing across pages", () => {
  const SCRIPT = [
    "@maya types: hi",
    "@jon joins",
    "@maya opens: pricing",
    "@maya types: and it stays free.",
    "Claude comments on \"Free is free\": say why?",
    "@jon replies: because.",
  ].join("\n");

  test("the steps after an open play in the page it opened, and the page it left keeps what it had", () => {
    const show = scene(SCRIPT);
    show.playTo(() => show.ended());
    const home = show.home.text.toString();
    const pricing = show.opened.get("pricing")!.text.toString();
    expect(home).toContain("hi");
    expect(home).not.toContain("stays free");
    // A line after an open lands at the end of that page, as a paragraph of its own.
    expect(pricing).toMatch(/^# Pricing\n\n.*Free is free.*\.\n\nand it stays free\.\n\n```comments\n/);
    // Comments quote the page they are in; a reply finds that page's thread.
    const threads = [...findAnchors(pricing).keys()];
    expect(threads).toHaveLength(1);
    expect(pricing).toContain("because.");
    expect(show.writes).toEqual(["website/pricing.md"]);
  });

  test("whoever opens the page goes along, and the rest come back when they act", () => {
    const show = scene(SCRIPT);
    const opened = () => show.opened.has("pricing");
    show.playTo(opened);
    expect(show.rooms[show.rooms.length - 1]).toEqual(["@maya"]);
    show.playTo(() => (show.rooms[show.rooms.length - 1] ?? []).includes("@jon"));
    expect(show.rooms[show.rooms.length - 1]).toEqual(["@maya", "Claude", "@jon"]);
    // Opening is a click; Maya does not "join" a second time.
    expect(show.cues.filter((cue) => cue !== "typing")).toEqual(["join", "join", "click", "agent", "comment", "join"]);
    show.run.stop();
  });

  test("a page that is not there leaves the show where it is", () => {
    const show = scene("@maya opens: nowhere\n@maya types: still home.");
    show.playTo(() => show.ended());
    expect(show.opened.size).toBe(0);
    expect(show.home.text.toString()).toContain("still home.");
  });

  test("the visitor typing in the page the show moved to stops it; typing in the page it left does not", () => {
    const show = scene("@maya opens: pricing\nwait 5s\n@maya types: later");
    show.playTo(() => show.opened.has("pricing"));
    show.home.doc.transact(() => show.home.text.insert(0, "x"));
    show.playTo(() => show.ended() || show.opened.get("pricing")!.text.toString().includes("later"));
    expect(show.opened.get("pricing")!.text.toString()).toContain("later");

    const again = scene("@maya opens: pricing\nwait 5s\n@maya types: later");
    again.playTo(() => again.opened.has("pricing"));
    const pricing = again.opened.get("pricing")!;
    pricing.doc.transact(() => pricing.text.insert(0, "x"));
    again.clock.rush(() => false);
    expect(pricing.text.toString()).not.toContain("later");
    expect(again.rooms[again.rooms.length - 1]).toEqual([]);
  });

  test("the studio times the steps after an open against the page they play in", () => {
    const { markdown, steps } = splitWebsiteCast(HOME.replace("CAST", SCRIPT));
    const timeline = castTimeline(markdown, steps, { pricing: PRICING });
    expect(timeline.starts.every((start) => start !== null)).toBe(true);
    expect(timeline.moments.comment).toBe(2);
    // Without the page, the comment has no words to quote and makes no sound.
    expect(castTimeline(markdown, steps).moments.comment).toBe(0);
  });
});

describe("the pages a scene opens, carried into its preview", () => {
  const DRAFT = HOME.replace("CAST", "@maya opens: pricing\n@jon opens: Pricing\nClaude goes to about us");

  test("each page the script names, once", () => {
    expect(sceneOpens(DRAFT)).toEqual(["pricing", "about us"]);
  });

  test("they ride in the fragment beside the draft, each with the preview's warning, at the address the script names", () => {
    const pages = [
      { name: "pricing", title: "Pricing", markdown: "---\ntitle: x\n---\n" + PRICING },
      { name: "about us", title: "About", markdown: "# About\n" },
    ];
    const href = castPreviewHref(DRAFT, "Home", pages);
    const snapshot = castPreviewFrom(href.slice(href.indexOf("#")))!;
    expect(snapshot.pages.map((page) => page.routePath)).toEqual(["/", "/pricing", "/about-us"]);
    for (const page of snapshot.pages) expect(page.markdown.startsWith(CAST_PREVIEW_BANNER)).toBe(true);
    expect(snapshot.pages[1]!.markdown).not.toContain("title: x");
    const byPath = new Map(snapshot.pages.map((page) => [page.path, page]));
    expect(pageNamed("About us", byPath as never, {})).toBe("about-us.md");
    expect(pageNamed("pricing", byPath as never, {})).toBe("pricing.md");
  });

  test("a crafted address cannot slip in a page that is not one", () => {
    const craft = (body: unknown) =>
      `#cast-preview=${btoa(JSON.stringify(body)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
    const base = { title: "Home", markdown: "# Home\n" };
    expect(castPreviewFrom(craft({ ...base, pages: "nope" }))).toBeNull();
    expect(castPreviewFrom(craft({ ...base, pages: [{ name: "x", title: 1, markdown: "" }] }))).toBeNull();
    expect(castPreviewFrom(craft({ ...base, pages: [{ name: "!!!", title: "t", markdown: "" }] }))).toBeNull();
    const many = Array.from({ length: MAX_PREVIEW_PAGES + 1 }, (_, i) => ({ name: `p${i}`, title: "t", markdown: "" }));
    expect(castPreviewFrom(craft({ ...base, pages: many }))).toBeNull();
    // Two names for one address: the first keeps it, and the front page is never replaced.
    const twice = castPreviewFrom(craft({ ...base, pages: [{ name: "a", title: "A", markdown: "1" }, { name: "A", title: "B", markdown: "2" }] }))!;
    expect(twice.pages.map((page) => page.title)).toEqual(["Home", "A"]);
  });

  test("the console finds them beside the scene's note, and reads nothing it was not asked for", async () => {
    const reads: string[] = [];
    const files = {
      listings: {
        website: {
          entries: [
            { kind: "file", path: "website/index.md", name: "index.md" },
            { kind: "file", path: "website/02-pricing.md", name: "02-pricing.md" },
          ],
        },
      },
      readRaw: async (path: string) => {
        reads.push(path);
        return path === "website/02-pricing.md" || path === "website/team/about.md" ? { text: `# ${path}\n`, etag: "e" } : null;
      },
    };
    const read = scenePageReader(files as never, "website/index.md");
    expect(await read("Pricing")).toEqual({ name: "Pricing", title: "website/02-pricing.md", markdown: "# website/02-pricing.md\n" });
    expect(await read("team/about")).toMatchObject({ name: "team/about" });
    expect(await read("nowhere")).toBeNull();
    expect(await read("index")).toBeNull();
    expect(await read("../secrets/keys")).toBeNull();
    expect(reads).toEqual(["website/02-pricing.md", "website/team/about.md", "website/nowhere.md"]);
  });
});

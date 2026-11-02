/**
 * A website page, list or stylesheet edited moments ago is drawn as published,
 * even while the tree's facts for it are still being read.
 *
 * Reported 2026-10-28 on @shyoh's site. A note edited and published again went
 * missing from the homepage's list while its own page still rendered, and for
 * three publishes the site drew none of its stylesheet. The facts fill runs
 * after a change, not with it (for a write through the gateway, up to the
 * quarter-hour sweep), and the list and the design took "no current facts"
 * for "not published". Now a lagging row runs a fill pass first.
 *
 * ## Sabotage record
 *
 * `currentRows` answering `treeRows` alone fails the first two tests; the
 * third holds either way, and is here so the fix never answers a narrowing
 * from the copy Publish kept.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, pressPublish, type Fixture, writeNote } from "./website.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const HOME = "---\ntitle: Home\n---\n\n```list\nfrom: website/notes\nsort: date, z to a\nshow: description\nlimit: 100\n```\n";
const note = (title: string, date: string, extra = "") =>
  `---\ntitle: ${title}\ndate: ${date}\ndescription: ${date}${extra}\n---\n\n${title}, the poem.\n`;
const STYLES = "The site's look.\n\n```css\nbody { background: #101010; }\n```\n";

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed("website/index.md", HOME);
  f.backend.seed("website/notes/a-desire-to-be-seen.md", note("a desire to be seen", "2026-01-02"));
  f.backend.seed("website/notes/lywbd.md", note("lywbd", "2026-01-01"));
  f.backend.seed("website/style.css.md", STYLES);
  await publish(f);
  await pressPublish(f);
  return f;
}

/**
 * The tree as a write through the gateway leaves it: the row holds the new
 * version, its facts the one before, until the fill reads the note. (A write
 * through the console, as `writeNote` is, reads its facts at once.)
 */
async function lag(f: Fixture, path: string): Promise<void> {
  await f.t.run(async (ctx) => {
    const row = await treeNodeAt(ctx.db, f.workspaceId, path);
    if (row === null) throw new Error(`no row at ${path}`);
    await ctx.db.patch(row._id, { parsed: "the version before" });
  });
}

/** Publish as the owner's button does, without the test's own fill pass first. */
const publishNow = (f: Fixture) =>
  asUser(f.t, f.owner).action(api.functions.websites.publish, { workspaceId: f.workspaceId });

async function home(f: Fixture) {
  const page = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
  if (page.kind !== "page") throw new Error(`expected a website page, got ${page.kind}`);
  return page;
}

describe("a website note whose facts lag its last edit", () => {
  test("stays on the list it was published on", async () => {
    const f = await site();
    expect((await home(f)).markdown).toContain("a desire to be seen");

    await writeNote(f, "website/notes/a-desire-to-be-seen.md", note("a desire to be seen", "2026-01-02", "\nmood: quiet"));
    await lag(f, "website/notes/a-desire-to-be-seen.md");
    await publishNow(f);
    await lag(f, "website/notes/a-desire-to-be-seen.md");

    const markdown = (await home(f)).markdown;
    expect(markdown).toContain("a desire to be seen");
    expect(markdown).toContain("lywbd");
  });

  test("a stylesheet edited and published again is still drawn", async () => {
    const f = await site();
    expect((await home(f)).design?.css).toContain("#101010");

    await writeNote(f, "website/style.css.md", `The site's look. ![[mark.png]]\n\n\`\`\`css\nbody { background: #202020; }\n\`\`\`\n`);
    await lag(f, "website/style.css.md");
    await publishNow(f);
    await lag(f, "website/style.css.md");

    expect((await home(f)).design?.css).toContain("#202020");
  });

  test("a note made a draft since Publish leaves the list, lagging facts or not", async () => {
    const f = await site();
    await writeNote(f, "website/notes/lywbd.md", note("lywbd", "2026-01-01", "\ndraft: true"));
    // A draft may narrow the menu, so the link catalog waits for the owner's
    // rebuild (`websiteListsFromTree.test.ts`); it runs here.
    await asUser(f.t, f.owner).action(api.functions.websites.refreshRouteStatuses, { workspaceId: f.workspaceId });
    await lag(f, "website/notes/lywbd.md");

    const markdown = (await home(f)).markdown;
    expect(markdown).toContain("a desire to be seen");
    expect(markdown).not.toContain("lywbd");
  });
});

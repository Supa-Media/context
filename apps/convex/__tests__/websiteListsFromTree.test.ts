/**
 * A public page's list block shows rows from the tree, never the notes'
 * bytes (Dev2, 2026-10-14: names and front matter go through the tree; only
 * a note's content comes from storage). Whether a listed page still publishes
 * is read from the facts' website flags, which must be as strict as the text
 * check they replaced.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser, readIntoTree } from "./fixtures.helpers";
import {
  bodyKeyOf,
  fixture,
  pressPublish,
  publish,
  writeNote,
} from "./website.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";

// Each test keys a workspace and runs the tree to its end, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => vi.unstubAllGlobals());

describe("public list blocks read the tree", () => {
  test("a list block asks the tree for its rows, and never opens the notes it lists", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\n---\n\n```list\nfrom: website/posts\nsort: title\n```\n",
    );
    f.backend.seed("website/posts/first.md", "---\ntitle: First post\n---\n\nOne\n");
    f.backend.seed("website/posts/second.md", "---\ntitle: Second post\n---\n\nTwo\n");
    await publish(f);
    await readIntoTree(f.t, f.workspaceId);
    f.backend.requests.length = 0;

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).toContain("First post");
    expect(resolved.markdown).toContain("Second post");
    const postKeys = [
      await bodyKeyOf(f.t, f.workspaceId, "website/posts/first.md"),
      await bodyKeyOf(f.t, f.workspaceId, "website/posts/second.md"),
    ];
    expect(f.backend.requests.filter((request) => postKeys.includes(request.key))).toEqual([]);
  });

  test("a lone draft key added since Publish takes the note off the list", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\n---\n\n```list\nfrom: website/posts\nsort: title\n```\n",
    );
    f.backend.seed("website/posts/open.md", "---\ntitle: Open post\n---\n\nOpen\n");
    f.backend.seed("website/posts/held.md", "---\ntitle: Held post\n---\n\nHeld\n");
    await publish(f);
    await pressPublish(f);
    // A bare `draft` line, which the front matter parser drops as a property:
    // the facts' website flags still carry it.
    await writeNote(f, "website/posts/held.md", "---\ntitle: Held post\ndraft\n---\n\nHeld\n");
    // A draft may narrow the menu, so the route link catalog is withheld until the
    // owner's rebuild lands (docs/decisions/websites.md); the rebuild runs here.
    await asUser(f.t, f.owner).action(api.functions.websites.refreshRouteStatuses, {
      workspaceId: f.workspaceId,
    });

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).toContain("Open post");
    expect(resolved.markdown).not.toContain("Held post");
  });

  test("a listed note whose facts predate the website flags is read by the list's own fill pass", async () => {
    const f = await fixture();
    f.backend.seed(
      "website/index.md",
      "---\ntitle: Home\n---\n\n```list\nfrom: website/posts\nsort: title\n```\n",
    );
    f.backend.seed("website/posts/old.md", "---\ntitle: Old facts\n---\n\nOld\n");
    await publish(f);
    await readIntoTree(f.t, f.workspaceId);
    // Facts as a fill before the flags wrote them, and a fill state from then.
    await f.t.run(async (ctx) => {
      const row = await treeNodeAt(
        ctx.db,
        f.workspaceId,
        "website/posts/old.md",
      );
      const props = JSON.parse(row!.props!) as Record<string, unknown>;
      delete props.site;
      await ctx.db.patch(row!._id, { props: JSON.stringify(props) });
      const state = await ctx.db
        .query("nodeFactState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(state!._id, { propsVersion: undefined, upgradeAfter: undefined });
    });
    // Facts that cannot be trusted are read again before the list is drawn
    // (`currentRows`), rather than the note left out until the next fill
    // (reported 2026-10-28, websiteLaggingFacts.test.ts).
    const resolved = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).toContain("Old facts");
    const state = await f.t.run((ctx) =>
      ctx.db
        .query("nodeFactState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(state).toMatchObject({ ready: true, propsVersion: 2 });
  });
});

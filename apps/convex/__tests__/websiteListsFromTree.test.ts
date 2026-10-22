/**
 * A public page's list block shows rows from the tree, never the notes'
 * bytes (Dev2, 2026-10-14: names and front matter go through the tree; only
 * a note's content comes from storage). Whether a listed page still publishes
 * is read from the facts' website flags, which must be as strict as the text
 * check they replaced.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, readIntoTree } from "./fixtures.helpers";
import { bodyKeyOf, fixture, pressPublish, publish, writeNote } from "./website.helpers";

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

  test("a listed note whose facts predate the website flags is left out until they are read", async () => {
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
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", "website/posts/old.md"))
        .unique();
      const props = JSON.parse(row!.props!) as Record<string, unknown>;
      delete props.site;
      await ctx.db.patch(row!._id, { props: JSON.stringify(props) });
      const state = await ctx.db
        .query("nodeFactState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(state!._id, { propsVersion: undefined, upgradeAfter: undefined });
    });
    const resolve = async () => {
      const resolved = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
      if (resolved.kind !== "page") throw new Error("expected a website page");
      return resolved.markdown;
    };
    expect(await resolve()).not.toContain("Old facts");

    // The next fill re-reads it, the fill staying ready throughout.
    await f.t.action(internal.functions.files.runFileOperation, {
      workspaceId: f.workspaceId,
      scope: "private" as const,
      operation: { kind: "nodesFactFill" as const },
    });
    const state = await f.t.run((ctx) =>
      ctx.db
        .query("nodeFactState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(state).toMatchObject({ ready: true, propsVersion: 2 });
    expect(await resolve()).toContain("Old facts");
  });
});

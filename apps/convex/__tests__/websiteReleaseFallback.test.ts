/**
 * What the last good release may and may not answer for.
 *
 * A website keeps serving its previous complete revision through a save that
 * is not publishable yet, so an autosave mid-frontmatter does not read as the
 * site going down. The grace has one edge: a save can be unpublishable *and*
 * restricted, and the release it would fall back to is then a public copy of
 * the page whose own bytes have just asked to stop being public. The route
 * status cannot tell the two apart — `problem` outranks both `draft` and
 * `audience` — so the controls are read from the frontmatter directly.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

describe("the last good website release", () => {
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

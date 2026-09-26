/**
 * The index may lag on widening; it must never lag on narrowing.
 *
 * A rebuild that meets a broken page publishes nothing new, and that used to
 * freeze everything: a restriction made while any page in the site was broken
 * kept its menu entry, and a page's release copy outlived the plaintext it
 * copied. Each case below makes one page narrower while another page stays
 * broken, then checks the narrowing landed anyway and the widening did not.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const SECRET = "A sentence the owner encrypted so nobody could read it.";
const BROKEN = "---\ntitle: Half typed\naudience: everyone\n---\n\nStill writing\n";
const ENCRYPTED = "---\ncontext_encryption: v1\n---\n\n```context-encrypted\nAAAA\n```\n";

const resolve = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

async function rebuild(f: Fixture): Promise<void> {
  await f.t.action(internal.functions.websites.reconcileWorkspace, {
    workspaceId: f.workspaceId,
  });
}

/** Every release object in the bucket, joined, for a plaintext search. */
function releaseBytes(f: Fixture): string {
  return Object.entries(f.backend.snapshot())
    .filter(([key]) => key.startsWith(".context/website/releases/"))
    .map(([, body]) => body)
    .join("\n");
}

async function menu(f: Fixture): Promise<string[]> {
  const page = await resolve(f, "/");
  return "navigation" in page ? page.navigation.map((item) => item.routePath) : [];
}

describe("a restriction lands even while another page is broken", () => {
  test("encrypting a published page removes its plaintext from every release", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/journal.md", `---\ntitle: Journal\n---\n\n${SECRET}\n`);
    await publish(f);
    // A second clean rebuild, so both the current and the grace release hold it.
    await rebuild(f);
    expect(releaseBytes(f)).toContain(SECRET);

    f.backend.seed("website/draft.md", BROKEN);
    f.backend.seed("website/journal.md", ENCRYPTED);
    await rebuild(f);

    expect(releaseBytes(f)).not.toContain(SECRET);
    await expect(resolve(f, "/journal")).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("encrypting a page with nothing else broken also removes it at once", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/journal.md", `---\ntitle: Journal\n---\n\n${SECRET}\n`);
    await publish(f);
    await rebuild(f);

    f.backend.seed("website/journal.md", ENCRYPTED);
    await rebuild(f);

    // The rebuild succeeds — ciphertext is simply not a page — and the release
    // it demotes to grace no longer holds the plaintext.
    expect(releaseBytes(f)).not.toContain(SECRET);
    await expect(resolve(f, "/")).resolves.toMatchObject({ kind: "page" });
  });

  test("a page made members-only outside the product leaves the public menu", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nAbout\n");
    await publish(f);
    expect(await menu(f)).toEqual(["/", "/about"]);

    // What the gateway reports: something changed, with no way to say what.
    f.backend.seed("website/draft.md", BROKEN);
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\naudience: members\n---\n\nAbout\n");
    await f.t.mutation(internal.functions.websites.invalidateRouteIndex, {
      workspaceId: f.workspaceId,
    });
    await rebuild(f);

    expect(await menu(f)).toEqual(["/"]);
  });

  test("a deleted page loses its release copies", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/old.md", `---\ntitle: Old\n---\n\n${SECRET}\n`);
    await publish(f);
    await rebuild(f);

    f.backend.seed("website/draft.md", BROKEN);
    f.backend.objects.delete("website/old.md");
    await rebuild(f);

    expect(releaseBytes(f)).not.toContain(SECRET);
    await expect(resolve(f, "/old")).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("a page privacy.md takes private leaves the menu and the releases", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", `---\ntitle: About\nnav: 2\n---\n\n${SECRET}\n`);
    await publish(f);
    await rebuild(f);

    f.backend.seed("website/draft.md", BROKEN);
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/about.md",
      visibility: "private",
    });
    await rebuild(f);

    expect(await menu(f)).toEqual(["/"]);
    expect(releaseBytes(f)).not.toContain(SECRET);
  });
});

describe("widening still waits for a clean rebuild", () => {
  test("a new page is not added to the menu while another page is broken", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await publish(f);

    f.backend.seed("website/draft.md", BROKEN);
    f.backend.seed("website/new.md", "---\ntitle: New\nnav: 2\n---\n\nNew\n");
    await rebuild(f);
    expect(await menu(f)).toEqual(["/"]);

    f.backend.objects.delete("website/draft.md");
    await rebuild(f);
    expect(await menu(f)).toEqual(["/", "/new"]);
  });

  test("an encrypted page is not a broken one, so it never holds the site back", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/journal.md", ENCRYPTED);
    await publish(f);

    f.backend.seed("website/new.md", "---\ntitle: New\nnav: 2\n---\n\nNew\n");
    await rebuild(f);
    expect(await menu(f)).toEqual(["/", "/new"]);
  });

  test("a broken page with nothing narrowed leaves the grace release alone", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await publish(f);
    await rebuild(f);
    const before = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(before?.previousReleaseId).toBeDefined();

    f.backend.seed("website/draft.md", BROKEN);
    await rebuild(f);
    const after = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(after?.previousReleaseId).toBe(before?.previousReleaseId);
  });

  test("a half-typed save of a public page keeps serving its last release", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nAbout us\n");
    await publish(f);

    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n\nAbout us, now longer\n");
    await rebuild(f);

    expect(await menu(f)).toEqual(["/", "/about"]);
    await expect(resolve(f, "/about")).resolves.toMatchObject({
      kind: "page",
      markdown: expect.stringContaining("About us"),
    });
  });
});

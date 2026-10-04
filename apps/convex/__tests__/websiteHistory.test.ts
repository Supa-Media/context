/**
 * A site keeps its last five published versions, so an agent can roll back.
 *
 * Decided by the owner, 2026-10-03 ("Keep last 5"): each Publish keeps a copy
 * of every page it released, in the customer's own `.context/`, for five
 * publishes. A deleted page's copies stay until they age out; a page
 * `privacy.md` holds back, or that is encrypted, loses its copies from every
 * kept version at once. The control plane keeps which pages each version
 * holds, by path, and never their words.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const BROKEN = "---\ntitle: Half typed\naudience: everyone\n---\n\nStill writing\n";
const ENCRYPTED = "---\ncontext_encryption: v1\n---\n\n```context-encrypted\nAAAA\n```\n";

async function publishAgain(f: Fixture): Promise<void> {
  await f.t.action(internal.functions.websites.reconcileWorkspace, {
    workspaceId: f.workspaceId,
    publish: true,
  });
}

async function rebuild(f: Fixture): Promise<void> {
  await f.t.action(internal.functions.websites.reconcileWorkspace, { workspaceId: f.workspaceId });
}

const RELEASES = ".context/website/releases/";

/** Release folders in the bucket, and every release object's bytes. */
function releases(f: Fixture): { ids: Set<string>; bytes: string } {
  const entries = Object.entries(f.backend.snapshot()).filter(([key]) => key.startsWith(RELEASES));
  return {
    ids: new Set(entries.map(([key]) => key.slice(RELEASES.length).split("/")[0]!)),
    bytes: entries.map(([, body]) => body).join("\n"),
  };
}

const history = (f: Fixture) =>
  f.t.run((ctx) =>
    ctx.db
      .query("websiteReleaseHistory")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .collect(),
  );

describe("a site keeps its last five published versions", () => {
  test("five publishes keep five versions; the sixth lets the oldest go", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await publish(f);
    for (let n = 2; n <= 5; n += 1) {
      f.backend.seed("website/index.md", `${HOME}\nVersion ${n}\n`);
      await publishAgain(f);
    }
    expect((await history(f)).length).toBe(5);
    expect(releases(f).ids.size).toBe(5);
    const oldest = (await history(f)).sort((a, b) => a.revision - b.revision)[0]!;

    f.backend.seed("website/index.md", `${HOME}\nVersion 6\n`);
    await publishAgain(f);
    const kept = await history(f);
    expect(kept.length).toBe(5);
    expect(kept.map((row) => row.releaseId)).not.toContain(oldest.releaseId);
    expect(releases(f).ids.size).toBe(5);
    expect(releases(f).ids.has(oldest.releaseId)).toBe(false);
  });

  test("the control plane keeps paths and ids, never a page's words", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", `${HOME}\nA sentence only the bucket holds.\n`);
    await publish(f);
    const rows = await history(f);
    expect(rows.length).toBe(1);
    expect(rows[0]!.pages.map((page) => page.path)).toEqual(["website/index.md"]);
    expect(JSON.stringify(rows)).not.toContain("only the bucket holds");
  });

  test("a deleted page keeps its copies, so a rollback can bring it back", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/old.md", "---\ntitle: Old\n---\n\nWords worth keeping\n");
    await publish(f);

    f.backend.objects.delete("website/old.md");
    await rebuild(f);
    await publishAgain(f);

    expect(releases(f).bytes).toContain("Words worth keeping");
    await expect(
      f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/old" }),
    ).resolves.toMatchObject({ kind: "unavailable" });
  });

  test("a page privacy.md holds back leaves every kept version at once", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nA private sentence\n");
    await publish(f);
    for (let n = 0; n < 3; n += 1) await publishAgain(f);
    expect(releases(f).bytes).toContain("A private sentence");

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/about.md",
      visibility: "private",
    });
    await rebuild(f);

    expect(releases(f).bytes).not.toContain("A private sentence");
    for (const row of await history(f)) {
      expect(row.pages.map((page) => page.path)).not.toContain("website/about.md");
    }
    expect(releases(f).bytes).toContain("Home");
  });

  test("an encrypted page leaves every kept version, even on a Publish", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/journal.md", "---\ntitle: Journal\n---\n\nA sealed sentence\n");
    await publish(f);
    await publishAgain(f);
    await publishAgain(f);

    f.backend.seed("website/journal.md", ENCRYPTED);
    await publishAgain(f);

    expect(releases(f).bytes).not.toContain("A sealed sentence");
  });

  test("held back while another page is broken still leaves every version", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nA private sentence\n");
    await publish(f);
    await publishAgain(f);

    f.backend.seed("website/draft.md", BROKEN);
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/about.md",
      visibility: "private",
    });
    await rebuild(f);

    expect(releases(f).bytes).not.toContain("A private sentence");
  });

  test("a page withheld after a failed wipe is caught by the next scan", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nA private sentence\n");
    await publish(f);
    await publishAgain(f);

    // The bucket refuses to delete release copies for one scan.
    let refuse = true;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
      if (refuse && (init.method ?? "GET") === "DELETE" && url.includes(RELEASES)) {
        return Promise.resolve(new Response("", { status: 500 }));
      }
      return f.backend.fetchImpl(input, init);
    });
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/about.md",
      visibility: "private",
    });
    await rebuild(f);
    refuse = false;
    await rebuild(f);

    expect(releases(f).bytes).not.toContain("A private sentence");
  });

  test("a site published before versions were kept adopts its current release", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await publish(f);
    await publishAgain(f);
    // What a site published before this change looks like: no history rows.
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db.query("websiteReleaseHistory").collect()) await ctx.db.delete(row._id);
    });
    const state = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );

    await publishAgain(f);
    const rows = await history(f);
    expect(rows.map((row) => row.releaseId).sort()).toEqual(
      [state!.publishedReleaseId!, (await f.t.run((ctx) => ctx.db.get(state!._id)))!.publishedReleaseId!].sort(),
    );
    // Its old grace release had no page list to keep, so it went.
    expect(releases(f).ids.has(state!.previousReleaseId!)).toBe(false);
    expect(releases(f).ids.size).toBe(2);
  });
});

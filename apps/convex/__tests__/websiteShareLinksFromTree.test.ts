/**
 * A website page's share links are checked against the tree, never by opening
 * the notes (Dev2, 2026-10-14: names, existence and front matter come from the
 * tree; storage is read only to open a note's body). A link to a shared note
 * stays while the note is visible at the publication clearance, and the page
 * is drawn without a single bucket request for that note.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser, copyTree, readIntoTree } from "./fixtures.helpers";
import { bodyKeyOf, fixture, publish } from "./website.helpers";

// Each test keys a workspace and runs its tree to the end, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => vi.unstubAllGlobals());

const HOME_PAGE = "---\ntitle: Home\n---\n\nSee [Shared project](../1-projects/shared.md) for more.\n";
const SHARED_NOTE = "---\ntitle: Shared project\n---\n\nShared\n";
const ENCRYPTED_NOTE = "---\ncontext_encryption: v1\n---\n\n```context-encrypted\nAAAA\n```\n";

async function shareSetup(sharedText = SHARED_NOTE) {
  const f = await fixture();
  f.backend.seed("website/index.md", HOME_PAGE);
  f.backend.seed("1-projects/shared.md", sharedText);
  await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: f.workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  await copyTree(f.t, f.workspaceId);
  const { token } = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path: "1-projects/shared.md",
  });
  await publish(f);
  await readIntoTree(f.t, f.workspaceId);
  return { f, token };
}

describe("website share links are checked against the tree", () => {
  test("a link to a visible shared note stays, with no bucket request for that note", async () => {
    const { f, token } = await shareSetup();
    f.backend.requests.length = 0;

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({
      kind: "page",
      markdown: expect.stringContaining(`[Shared project](/s/${token})`),
    });
    const sharedKey = await bodyKeyOf(f.t, f.workspaceId, "1-projects/shared.md");
    expect(f.backend.requests.filter((request) => request.key === sharedKey)).toEqual([]);
  }, 60_000);

  test("a link to an encrypted shared note is dropped, as the bucket read dropped it", async () => {
    const { f, token } = await shareSetup(ENCRYPTED_NOTE);

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).not.toContain(token);
  }, 60_000);

  test("a link drops once its shared note is made private", async () => {
    const { f, token } = await shareSetup();

    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      visibility: "private",
    });

    const resolved = await f.t.action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/",
    });
    expect(resolved).toMatchObject({ kind: "page" });
    if (resolved.kind !== "page") throw new Error("expected a website page");
    expect(resolved.markdown).not.toContain(token);
    expect(resolved.markdown).toContain("Shared project");
  }, 60_000);
});

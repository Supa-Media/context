/**
 * A linked page's card is its cover (owner, 2026-10-27: "Team links too").
 *
 * A `.page.md` note that the owner linked for the team or for anyone unfurls
 * with the cover Tex drew of it; a link for named people, a folder, a note
 * that is not a page, a revoked link and one whose title is off keep what
 * they had. The gateway's report is checked before a byte is written.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `isCoverable` allowing every recipient → "a link for named people keeps the title card".
 *  2. `cardLocation` checking the cover before `titleInPreview` → "turning the title off takes the cover off too".
 *  3. `livePageRow` without the `.page.md` check → "a note that is not a page never has a cover".
 *  4. `coverBytes` without the PNG check → "the gateway's report must be a PNG, and not a big one".
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { coverVersion } from "../functions/lib/shares/pageCover";
import { titleFromPath } from "../functions/lib/shareTitle";
import { coverBytes, coverLeaf, MAX_COVER_BYTES } from "../functions/lib/gatewayRoutes/pageCover";
import { asUser, setupTest, type TestConvex } from "./fixtures.helpers";
import { scenario, teamLink } from "./teamShare/fixtures.helpers";

const PAGE = "1-projects/trip/plan.page.md";
const LEAF = "cover-0123456789abcdef-89abcdef.png";

async function pageRow(t: TestConvex, workspaceId: Id<"workspaces">, path = PAGE, extra: Record<string, unknown> = {}) {
  await t.run(async (ctx) => {
    await ctx.db.insert("nodes", {
      workspaceId,
      kind: "file",
      observedAt: 1,
      path,
      name: path.split("/").pop()!,
      noteId: "note-page-0001",
      ...extra,
    });
  });
}

async function record(t: TestConvex, workspaceId: Id<"workspaces">, path = PAGE, leaf = LEAF) {
  return await t.mutation(internal.functions.pageCovers.recordCover, { workspaceId, path, leaf });
}

const preview = (t: TestConvex, path = PAGE) => t.query(api.functions.shares.previewForNote, { slug: "owner-workspace", path });
const location = (t: TestConvex, token: string) => t.query(internal.functions.shareCard.cardLocation, { token });

describe("a linked page's card", () => {
  test("a team-linked page unfurls with its cover", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await pageRow(t, workspaceId);
    const { token } = await teamLink(t, ownerId, workspaceId, PAGE);
    expect(await preview(t)).not.toHaveProperty("cover");

    expect(await record(t, workspaceId)).toBe(true);
    expect(await preview(t)).toMatchObject({ title: "Plan", cardToken: token, cover: coverVersion(LEAF) });
    expect(await location(t, token)).toEqual({ workspaceId, leaf: LEAF });
    expect(await t.query(api.functions.shares.previewTitleForToken, { token })).toMatchObject({ cover: coverVersion(LEAF) });
  });

  test("a page is titled without its .page", () => {
    expect(titleFromPath("1-projects/trip/dinner-plan.page.md")).toBe("Dinner plan");
    expect(titleFromPath("1-projects/trip/dinner-plan.md")).toBe("Dinner plan");
  });

  test("a new cover is a new card address", () => {
    expect(coverVersion(LEAF)).toMatch(/^[0-9a-f]{8}$/);
    expect(coverVersion(LEAF)).not.toBe(coverVersion(LEAF.replace("89abcdef.png", "00000000.png")));
  });

  test("a link for named people keeps the title card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await pageRow(t, workspaceId);
    await record(t, workspaceId);
    const { token } = await asUser(t, ownerId).mutation(api.functions.shares.createShare, { workspaceId, path: PAGE, recipient: "@elsewhere" });
    expect(await t.query(api.functions.shares.previewTitleForToken, { token })).not.toHaveProperty("cover");
    expect(await location(t, token)).toBeNull();
  });

  test("turning the title off takes the cover off too", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await pageRow(t, workspaceId);
    await record(t, workspaceId);
    const { token } = await teamLink(t, ownerId, workspaceId, PAGE);
    await t.run(async (ctx) => {
      const share = await ctx.db.query("noteShares").withIndex("by_token", (q) => q.eq("token", token)).unique();
      await ctx.db.patch(share!._id, { titleInPreview: false });
    });
    expect(await preview(t)).toEqual({ title: null, cardToken: null, children: [] });
    expect(await location(t, token)).toBeNull();
  });

  test("revoking takes it back, the same answer as never linked", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await pageRow(t, workspaceId);
    await record(t, workspaceId);
    const { token } = await teamLink(t, ownerId, workspaceId, PAGE);
    const [listed] = await asUser(t, ownerId).query(api.functions.shares.listShares, { workspaceId });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, { shareId: listed.shareId });
    expect(await preview(t)).toEqual({ title: null, cardToken: null, children: [] });
    expect(await location(t, token)).toBeNull();
  });

  test("a note that is not a page never has a cover", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const NOTE = "1-projects/trip/plan.md";
    await pageRow(t, workspaceId, NOTE, { pageCover: LEAF });
    expect(await record(t, workspaceId, NOTE)).toBe(false);
    const { token } = await teamLink(t, ownerId, workspaceId, NOTE);
    expect(await preview(t, NOTE)).not.toHaveProperty("cover");
    expect(await location(t, token)).toBeNull();
  });

  test("a page that is gone keeps no cover", async () => {
    const t = setupTest();
    const { workspaceId } = await scenario(t);
    await pageRow(t, workspaceId, PAGE, { goneAt: 2 });
    expect(await record(t, workspaceId)).toBe(false);
    expect(await t.query(internal.functions.pageCovers.coverTarget, { workspaceId, path: PAGE })).toBeNull();
  });
});

describe("the gateway's report", () => {
  const png = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return btoa(String.fromCharCode(...bytes));
  };

  test("the gateway's report must be a PNG, and not a big one", () => {
    expect(coverBytes(png(64))?.length).toBe(64);
    expect(coverBytes(btoa("<svg onload=alert(1)>"))).toBeNull();
    expect(coverBytes("not base64!")).toBeNull();
    expect(coverBytes(undefined)).toBeNull();
    expect(coverBytes("A".repeat(Math.ceil(MAX_COVER_BYTES / 3) * 4 + 4))).toBeNull();
  });

  test("the object's name says nothing about the note, and names the picture", async () => {
    const bytes = coverBytes(png(64))!;
    const leaf = await coverLeaf("workspace-1", "note-page-0001", bytes);
    expect(leaf).toMatch(/^cover-[0-9a-f]{16}-[0-9a-f]{8}\.png$/);
    expect(leaf).not.toContain("note-page");
    expect(await coverLeaf("workspace-1", "note-page-0001", coverBytes(png(65))!)).not.toBe(leaf);
  });
});

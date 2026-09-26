/**
 * A website's favicon is its workspace's icon, and only once the site is on.
 *
 * `websites.siteIcon` is called by anonymous visitors with nothing but a
 * handle, so what these tests hold is its security argument
 * (`docs/decisions/websites.md`, "The workspace icon is the site's favicon"):
 *
 * - a handle whose site is not enabled answers exactly what a handle nobody
 *   has claimed answers, so the call is not a way to learn that a workspace
 *   exists or what it looks like;
 * - the photo it reads is the one named on the workspace row, and the action
 *   has no argument through which any other object could be named;
 * - an unreadable photo is the same absence as no icon, never an error a
 *   visitor could reason from.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import * as websiteFunctions from "../functions/websites";
import { IMAGE_PREFIX } from "../functions/lib/fileOps";
import { asUser, captureError } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every byte value, so a stub that re-encodes cannot pass. */
const PHOTO = new Uint8Array(256);
for (let i = 0; i < PHOTO.length; i += 1) PHOTO[i] = i;

async function setEmoji(f: Fixture, emoji: string) {
  await asUser(f.t, f.owner).mutation(api.functions.workspaces.setWorkspaceIcon, {
    workspaceId: f.workspaceId,
    emoji,
  });
}

async function setPhoto(f: Fixture) {
  return await asUser(f.t, f.owner).action(api.functions.files.setWorkspaceIconPhoto, {
    workspaceId: f.workspaceId,
    bytes: PHOTO.buffer,
    contentType: "image/png",
  });
}

/** Asked the way a visitor asks: signed out, with a handle. */
async function siteIcon(f: Fixture, handle: string) {
  return await f.t.action(api.functions.websites.siteIcon, { handle });
}

describe("a site that is not on shows nobody its icon", () => {
  test("a workspace that never turned its site on answers like a handle nobody has", async () => {
    const f = await fixture();
    await setEmoji(f, "🪐");
    const unpublished = await siteIcon(f, "atlas");
    const nobody = await siteIcon(f, "no-such-handle");
    expect(unpublished).toBeNull();
    // Identical, not merely both falsy: any difference is an oracle.
    expect(JSON.stringify(unpublished)).toBe(JSON.stringify(nobody));
  });

  test("turning the site off takes the icon off with it", async () => {
    const f = await fixture();
    await setEmoji(f, "🪐");
    await publish(f);
    expect(await siteIcon(f, "atlas")).toEqual({ kind: "emoji", emoji: "🪐" });

    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { state: "disabled" });
    });
    expect(await siteIcon(f, "atlas")).toBeNull();
  });

  test("a handle that is not a handle is the same absence", async () => {
    const f = await fixture();
    await setEmoji(f, "🪐");
    await publish(f);
    expect(await siteIcon(f, "../atlas")).toBeNull();
    expect(await siteIcon(f, "")).toBeNull();
  });
});

describe("a site that is on shows the workspace's own icon", () => {
  test("an emoji is returned as the emoji", async () => {
    const f = await fixture();
    await setEmoji(f, "🪐");
    await publish(f);
    expect(await siteIcon(f, "atlas")).toEqual({ kind: "emoji", emoji: "🪐" });
    // The handle is matched the way the site's own address is.
    expect(await siteIcon(f, "@Atlas")).toEqual({ kind: "emoji", emoji: "🪐" });
  });

  test("a workspace with no icon has none, which is the Context favicon", async () => {
    const f = await fixture();
    await publish(f);
    expect(await siteIcon(f, "atlas")).toBeNull();
  });

  test("a photo is read out of the customer's bucket, byte for byte", async () => {
    const f = await fixture();
    await setPhoto(f);
    await publish(f);
    const icon = await siteIcon(f, "atlas");
    expect(icon?.kind).toBe("photo");
    if (icon?.kind !== "photo") return;
    expect(icon.contentType).toBe("image/png");
    expect(new Uint8Array(icon.bytes)).toEqual(PHOTO);
  });

  test("a photo that cannot be read is the same absence as none", async () => {
    const f = await fixture();
    const { leaf } = await setPhoto(f);
    await publish(f);
    // Removed out of the customer's own bucket, which is theirs to do.
    f.backend.objects.delete(`${IMAGE_PREFIX}${leaf}`);
    expect(await siteIcon(f, "atlas")).toBeNull();
  });
});

describe("the photo is the row's, never the caller's", () => {
  test("the action takes a handle and nothing through which an object can be named", () => {
    // Read from the validator Convex enforces, not from the source text.
    const exported = JSON.parse(
      (websiteFunctions.siteIcon as unknown as { exportArgs: () => string }).exportArgs(),
    ) as { value?: Record<string, unknown> };
    expect(Object.keys(exported.value ?? {})).toEqual(["handle"]);
  });

  test("a leaf smuggled in beside the handle is refused, not ignored", async () => {
    const f = await fixture();
    await setPhoto(f);
    await publish(f);
    const error = await captureError(() =>
      f.t.action(api.functions.websites.siteIcon, {
        handle: "atlas",
        leaf: "../../privacy.md",
      } as never),
    );
    expect(error).toBeDefined();
  });

  test("an image pasted into a note is not the icon", async () => {
    const f = await fixture();
    await publish(f);
    // An image pasted into a note, sitting in the same opaque store: it has no
    // row pointing at it as an icon, so the site has no icon.
    await asUser(f.t, f.owner).action(api.functions.files.storeNoteImage, {
      workspaceId: f.workspaceId,
      bytes: PHOTO.buffer,
      contentType: "image/png",
    });
    expect(await siteIcon(f, "atlas")).toBeNull();
  });
});

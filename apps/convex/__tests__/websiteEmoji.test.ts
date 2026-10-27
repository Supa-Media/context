/**
 * A published page carries the workspace emoji it shows.
 *
 * A site loads no images, so `:name:` on a page arrives with the page as an
 * inline picture. Publishing a page publishes the pictures in it and nothing
 * else: an emoji the page does not use, or names only inside code, never
 * leaves, and a picture over the cap shows as its name instead. Which emoji
 * the workspace has is Convex's answer; the image store is never listed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { MAX_PUBLISHED_EMOJI_BYTES } from "../functions/lib/websites/emoji";
import { fixture, publish, type Fixture } from "./website.helpers";

// Each test keys a workspace and runs its tree to the end, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => vi.stubEnv("HOME_SITE_HANDLE", "atlas"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const IMAGES = ".context/assets/images/";
const GIF = new TextEncoder().encode("GIF89a-parrot");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed(`${IMAGES}emoji-parrot.gif`, GIF);
  f.backend.seed(`${IMAGES}emoji-secret.png`, PNG);
  f.backend.seed(`${IMAGES}emoji-incode.png`, PNG);
  f.backend.seed(`${IMAGES}emoji-huge.png`, new Uint8Array(MAX_PUBLISHED_EMOJI_BYTES + 1));
  f.backend.seed(
    "website/index.md",
    "---\ntitle: Welcome\nnav: 0\n---\n\nShip it :parrot: :tada: :huge: :missing:\n\n`:incode:`\n",
  );
  // The pictures were put in the bucket by hand: their names reach Convex by the one-time import.
  await f.t.action(internal.functions.files.runFileOperation, {
    workspaceId: f.workspaceId,
    scope: "private",
    operation: { kind: "nodesSmallData" },
  });
  await publish(f);
  return f;
}

describe("a published page's emoji", () => {
  test("travel with the page, and only the ones it shows outside code", async () => {
    const f = await site();
    const resolved = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
    expect(resolved.kind).toBe("page");
    const emoji = resolved.kind === "page" ? resolved.emoji : undefined;
    expect(emoji).toEqual({ parrot: `data:image/gif;base64,${base64(GIF)}` });
  });

  test("the homepage snapshot carries the same, and nothing it does not use", async () => {
    const f = await site();
    const answer = await f.t.fetch("/site/home", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "atlas" }),
    });
    const body = (await answer.json()) as { emoji: Record<string, string> };
    expect(Object.keys(body.emoji)).toEqual(["parrot"]);
  });

  test("a page that uses none carries none", async () => {
    const f = await fixture();
    f.backend.seed(`${IMAGES}emoji-parrot.gif`, GIF);
    f.backend.seed("website/index.md", "---\ntitle: Welcome\n---\n\nNo emoji here.\n");
    await publish(f);
    const resolved = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
    expect(resolved).not.toHaveProperty("emoji");
  });
});

describe("the edge copy", () => {
  test("keeps a page's emoji, so a kept copy draws them too", async () => {
    const f = await site();
    const answer = await f.t.fetch("/site/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "atlas", routePath: "/" }),
    });
    const body = (await answer.json()) as { address: { emoji?: Record<string, string> } };
    expect(Object.keys(body.address.emoji ?? {})).toEqual(["parrot"]);
  });
});

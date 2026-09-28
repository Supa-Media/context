/**
 * A published page carries the pasted pictures it embeds.
 *
 * A site loads no images, so `![[paste-….png]]` on a page arrives with the page
 * as an inline picture, the way its emoji do. Publishing a page publishes the
 * pictures in it and nothing else: an object the page does not embed, one named
 * only inside code, a path out of the store and a picture over the cap never
 * leave.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { MAX_PUBLISHED_IMAGE_BYTES } from "../functions/lib/websites/images";
import { fixture, publish, type Fixture } from "./website.helpers";

beforeEach(() => vi.stubEnv("HOME_SITE_HANDLE", "atlas"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const IMAGES = ".context/assets/images/";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 4]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed(`${IMAGES}paste-be3b688afc175efb.png`, PNG);
  f.backend.seed(`${IMAGES}paste-0123456789abcdef.jpg`, JPG);
  f.backend.seed(`${IMAGES}paste-5ec2e75ec2e75ec2.png`, PNG);
  f.backend.seed(`${IMAGES}paste-c0dec0dec0dec0de.png`, PNG);
  f.backend.seed(`${IMAGES}paste-4444444444444444.png`, new Uint8Array(MAX_PUBLISHED_IMAGE_BYTES + 1));
  f.backend.seed("website/secret.md", "---\nvisibility: private\n---\n\nnot a picture");
  f.backend.seed(
    "website/index.md",
    [
      "---\ntitle: Welcome\nnav: 0\n---\n",
      "Onboarding",
      "![[paste-be3b688afc175efb.png|356]] <!-- context: align=center -->",
      "![a photo](paste-0123456789abcdef.jpg)",
      "![[paste-4444444444444444.png]] ![[paste-9999999999999999.png]]",
      "![[../secret.md]] ![[https://attacker.example/pixel.png]]",
      "`![[paste-c0dec0dec0dec0de.png]]`",
      "",
    ].join("\n"),
  );
  await publish(f);
  return f;
}

const EXPECTED = {
  "paste-be3b688afc175efb.png": `data:image/png;base64,${base64(PNG)}`,
  "paste-0123456789abcdef.jpg": `data:image/jpeg;base64,${base64(JPG)}`,
};

describe("a published page's pasted pictures", () => {
  test("travel with the page, and only the ones it embeds outside code", async () => {
    const f = await site();
    const resolved = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
    expect(resolved.kind).toBe("page");
    expect(resolved.kind === "page" ? resolved.images : undefined).toEqual(EXPECTED);
  });

  test("the homepage snapshot carries the same, and nothing it does not embed", async () => {
    const f = await site();
    const answer = await f.t.fetch("/site/home", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "atlas" }),
    });
    const body = (await answer.json()) as { images: Record<string, string> };
    expect(body.images).toEqual(EXPECTED);
  });

  test("the edge copy keeps them, so a kept copy draws them too", async () => {
    const f = await site();
    const answer = await f.t.fetch("/site/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "atlas", routePath: "/" }),
    });
    const body = (await answer.json()) as { address: { images?: Record<string, string> } };
    expect(body.address.images).toEqual(EXPECTED);
  });

  test("a page that embeds none carries none", async () => {
    const f = await fixture();
    f.backend.seed(`${IMAGES}paste-be3b688afc175efb.png`, PNG);
    f.backend.seed("website/index.md", "---\ntitle: Welcome\n---\n\nNo pictures here.\n");
    await publish(f);
    const resolved = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/" });
    expect(resolved).not.toHaveProperty("images");
  });
});

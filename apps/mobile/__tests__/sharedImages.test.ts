/**
 * The share page asks for a picture through the link, with the note on screen.
 *
 * Dev2 (2026-10-25): pasted pictures in a shared note drew as "Not in this
 * bucket" because the page's file browser could load no image at all. The
 * server decides what may be shown (`apps/convex/__tests__/shareImages.test.ts`);
 * this holds the page to asking with the right link and note, and to drawing
 * every refusal as the same absence.
 */

import { describe, expect, test } from "@jest/globals";
import { sharedImageLoader, type ReadSharedImage } from "../features/share/sharedImages";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

function recorder(answer: () => Promise<{ bytes: ArrayBuffer; contentType: string }>) {
  const calls: unknown[] = [];
  const read: ReadSharedImage = async (args) => {
    calls.push(args);
    return answer();
  };
  return { calls, read };
}

describe("a shared note's pictures", () => {
  test("the entry note asks with the link alone, and draws the bytes", async () => {
    const { calls, read } = recorder(async () => ({ bytes: PNG, contentType: "image/png" }));
    const load = sharedImageLoader(read, { token: "t" }, "a/entry.md", "a/entry.md", new Map());

    expect(await load("paste-1.png")).toBe("data:image/png;base64,iVBORw==");
    expect(calls).toEqual([{ token: "t", leaf: "paste-1.png" }]);
  });

  test("a linked note names itself, and a short link asks by name", async () => {
    const { calls, read } = recorder(async () => ({ bytes: PNG, contentType: "image/png" }));
    const load = sharedImageLoader(read, { handle: "atlas", slug: "fb" }, "a/other.md", "a/entry.md", new Map());

    await load("paste-2.png");
    expect(calls).toEqual([{ handle: "atlas", slug: "fb", path: "a/other.md", leaf: "paste-2.png" }]);
  });

  test("a refusal is a missing picture, and a picture is asked for once", async () => {
    let fail = true;
    const { calls, read } = recorder(async () => {
      if (fail) throw new Error("SHARE_UNAVAILABLE");
      return { bytes: PNG, contentType: "image/png" };
    });
    const load = sharedImageLoader(read, { token: "t" }, "a/entry.md", "a/entry.md", new Map());

    expect(await load("paste-3.png")).toBeNull();
    fail = false;
    await load("paste-3.png");
    await load("paste-3.png");
    expect(calls).toHaveLength(2);
  });
});

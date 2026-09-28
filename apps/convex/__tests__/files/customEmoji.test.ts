import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { parseSlackmojis } from "../../functions/emoji";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import { type Fixture, fixture } from "./fixtures.helpers";

/**
 * A workspace's emoji, through the control plane.
 *
 * Every member sees every emoji; only an editor or owner changes them; a
 * stranger learns nothing. The Slackmojis calls are held to Slackmojis: a
 * preview or import of any other host fetches nothing at all.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const GIF = new TextEncoder().encode("GIF89a-parrot");
const PARROT_URL = "https://emojis.slackmojis.com/emojis/images/1643514139/987/parrot.gif?1643514139";

/** Serve Slackmojis and one other host; everything else goes to the fixture's bucket. */
function serve(f: Fixture): string[] {
  const seen: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://slackmojis.com/") || url.startsWith("https://emojis.slackmojis.com/") || url.startsWith("https://img.example/")) {
      seen.push(url);
      if (url.startsWith("https://slackmojis.com/emojis/search.json")) {
        return Promise.resolve(
          Response.json([
            { id: 987, name: "parrot", image_url: PARROT_URL, category: { id: 7, name: "Party Parrot" } },
            { id: 1, name: "elsewhere", image_url: "https://img.example/x.gif", category: null },
            { id: 2, name: 7, image_url: PARROT_URL },
          ]),
        );
      }
      if (url === PARROT_URL) return Promise.resolve(new Response(GIF));
      return Promise.resolve(new Response(PNG));
    }
    return f.backend.fetchImpl(input as RequestInfo, init);
  });
  return seen;
}

describe("custom emoji", () => {
  test("an editor adds one, and every member lists and draws it", async () => {
    const f = await fixture();
    const added = await asUser(f.t, f.editor).action(api.functions.emoji.add, {
      workspaceId: f.workspaceId,
      name: "lgtm",
      bytes: PNG.buffer,
    });
    expect(added).toEqual({ name: "lgtm", leaf: "emoji-lgtm.png" });
    const listed = await asUser(f.t, f.reader).action(api.functions.emoji.list, { workspaceId: f.workspaceId });
    expect(listed).toEqual([{ name: "lgtm", leaf: "emoji-lgtm.png" }]);
    const read = await asUser(f.t, f.reader).action(api.functions.emoji.read, {
      workspaceId: f.workspaceId,
      name: "lgtm",
    });
    expect(new Uint8Array(read.bytes)).toEqual(PNG);
    expect(read.contentType).toBe("image/png");
  });

  test("a member cannot add, rename or remove one", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.emoji.add, { workspaceId: f.workspaceId, name: "x", bytes: PNG.buffer });
    const attempts = [
      () => asUser(f.t, f.reader).action(api.functions.emoji.add, { workspaceId: f.workspaceId, name: "y", bytes: PNG.buffer }),
      () => asUser(f.t, f.reader).action(api.functions.emoji.rename, { workspaceId: f.workspaceId, from: "x", to: "y" }),
      () => asUser(f.t, f.reader).action(api.functions.emoji.remove, { workspaceId: f.workspaceId, name: "x" }),
    ];
    for (const attempt of attempts) {
      expect(errorCode(await captureError(attempt))).toBe("INSUFFICIENT_ROLE");
    }
    const listed = await asUser(f.t, f.owner).action(api.functions.emoji.list, { workspaceId: f.workspaceId });
    expect(listed.map((emoji) => emoji.name)).toEqual(["x"]);
  });

  test("a stranger gets the answer for a workspace that does not exist", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.emoji.add, { workspaceId: f.workspaceId, name: "x", bytes: PNG.buffer });
    const listing = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.emoji.list, { workspaceId: f.workspaceId }),
    );
    const reading = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.emoji.read, { workspaceId: f.workspaceId, name: "x" }),
    );
    expect(errorCode(listing)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorCode(reading)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("reading by name never hands back a pasted image", async () => {
    const f = await fixture();
    const pasted = await asUser(f.t, f.owner).action(api.functions.files.storeNoteImage, {
      workspaceId: f.workspaceId,
      bytes: PNG.buffer,
      contentType: "image/png",
    });
    const name = pasted.leaf.replace(/\.png$/, "");
    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.emoji.read, { workspaceId: f.workspaceId, name }),
    );
    expect(errorCode(error)).toBe("FILE_NOT_FOUND");
    const listed = await asUser(f.t, f.owner).action(api.functions.emoji.list, { workspaceId: f.workspaceId });
    expect(listed).toEqual([]);
  });
});

describe("Slackmojis", () => {
  test("search keeps only results whose picture is on Slackmojis", async () => {
    const f = await fixture();
    const seen = serve(f);
    const results = await asUser(f.t, f.editor).action(api.functions.emoji.searchSlackmojis, {
      workspaceId: f.workspaceId,
      query: "parrot",
    });
    expect(results).toEqual([{ name: "parrot", url: PARROT_URL, category: "Party Parrot" }]);
    expect(seen).toEqual(["https://slackmojis.com/emojis/search.json?query=parrot"]);
  });

  test("import copies the picture into the workspace under the chosen name", async () => {
    const f = await fixture();
    serve(f);
    const added = await asUser(f.t, f.editor).action(api.functions.emoji.importSlackmoji, {
      workspaceId: f.workspaceId,
      url: PARROT_URL,
      name: "partyparrot",
    });
    expect(added).toEqual({ name: "partyparrot", leaf: "emoji-partyparrot.gif" });
    const read = await asUser(f.t, f.reader).action(api.functions.emoji.read, {
      workspaceId: f.workspaceId,
      name: "partyparrot",
    });
    expect(new Uint8Array(read.bytes)).toEqual(GIF);
  });

  test("preview and import of any other host fetch nothing", async () => {
    const f = await fixture();
    const seen = serve(f);
    for (const url of ["https://img.example/x.gif", "http://emojis.slackmojis.com/x.gif", "https://emojis.slackmojis.com.img.example/x.gif"]) {
      const preview = await captureError(() =>
        asUser(f.t, f.editor).action(api.functions.emoji.slackmojiPreview, { workspaceId: f.workspaceId, url }),
      );
      const imported = await captureError(() =>
        asUser(f.t, f.editor).action(api.functions.emoji.importSlackmoji, { workspaceId: f.workspaceId, url, name: "x" }),
      );
      expect(errorCode(preview)).toBe("SLACKMOJI_INVALID");
      expect(errorCode(imported)).toBe("SLACKMOJI_INVALID");
    }
    expect(seen).toEqual([]);
  });

  test("a member cannot search, preview or import, and nothing is fetched", async () => {
    const f = await fixture();
    const seen = serve(f);
    const errors = [
      await captureError(() =>
        asUser(f.t, f.reader).action(api.functions.emoji.searchSlackmojis, { workspaceId: f.workspaceId, query: "x" }),
      ),
      await captureError(() =>
        asUser(f.t, f.reader).action(api.functions.emoji.slackmojiPreview, { workspaceId: f.workspaceId, url: PARROT_URL }),
      ),
      await captureError(() =>
        asUser(f.t, f.reader).action(api.functions.emoji.importSlackmoji, {
          workspaceId: f.workspaceId,
          url: PARROT_URL,
          name: "x",
        }),
      ),
    ];
    expect(errors.map(errorCode)).toEqual(["INSUFFICIENT_ROLE", "INSUFFICIENT_ROLE", "INSUFFICIENT_ROLE"]);
    expect(seen).toEqual([]);
  });

  test("a malformed answer is an empty list, not an error", () => {
    expect(parseSlackmojis({ error: "x" })).toEqual([]);
    expect(parseSlackmojis([null, 3, { name: "a" }])).toEqual([]);
  });
});

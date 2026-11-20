import { APP_PICTURE_ORIGIN, MAX_APP_PICTURE_BYTES, forgetAppPicture, keepAppPicture, readAppPicture, serveAppPicture, sniffPictureType } from "./appPictures";
import { describe, expect, it } from "vitest";
import { appChatId, appLine, appUserOf, APP_TYPING_KEY, isAppChat } from "./appChat";
import { lineFor, type LineDeps } from "./line";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Fetch } from "./clients";

// A fake Convex user id: the shape the control plane issues, never a real account.
const USER = "k7m2q9x4b8n3c6v1";

describe("app chat ids", () => {
  it("names the chat after the user, and reads the user back", () => {
    expect(appChatId(USER)).toBe(`app:${USER}`);
    expect(appUserOf(`app:${USER}`)).toBe(USER);
    expect(isAppChat(`app:${USER}`)).toBe(true);
  });

  it("refuses an id that is not a user id, so no chat is named after it", () => {
    for (const bad of ["", "short", "K7M2Q9X4B8N3C6V1", "k7m2q9x4b8n3c6v1-x", "k7m2q9x4b8n3c6v1/../x", "k7m2q9x4b8n3c6v1 ", "a".repeat(65)]) {
      expect(appChatId(bad)).toBeNull();
      expect(appUserOf(`app:${bad}`)).toBeNull();
      expect(isAppChat(`app:${bad}`)).toBe(false);
    }
  });

  it("is not a phone, a Photon, a WhatsApp or a Sendblue chat", () => {
    for (const chat of [`+15555550100`, `sendblue:+15555550199:+15555550100`, `photon:+15555550199:+15555550100`, `whapi:x:y`, `${USER}`, `app-${USER}`]) {
      expect(isAppChat(chat)).toBe(false);
    }
    expect(isAppChat(undefined)).toBe(false);
    expect(isAppChat(42)).toBe(false);
    expect(appUserOf(USER)).toBeNull();
  });
});

describe("appLine", () => {
  const line = () => appLine(new MemoryStorage(), () => 1_800_000_000_000);

  it("resolves a sent text to a handle, sanitized and at most 120 characters, and sends nothing", async () => {
    const handle = await line().sendText(`app:${USER}`, "hello", "turn/1 with spaces");
    expect(handle).toBe("app-turn-1-with-spaces");
    expect(handle!.length).toBeLessThanOrEqual(120);
    expect(await line().sendText(`app:${USER}`, "hello", "k".repeat(300))).toHaveLength(120);
  });

  it("keeps no text: the only write is the typing mark", async () => {
    const storage = new MemoryStorage();
    const app = appLine(storage);
    await app.sendText(`app:${USER}`, "hi", "k1");
    await app.sendMedia(`app:${USER}`, { url: "https://example.test/x.png" }, "k2");
    await app.markRead(`app:${USER}`);
    expect(await storage.get(APP_TYPING_KEY)).toBeUndefined();
    await app.startTyping(`app:${USER}`);
    expect(await storage.get(APP_TYPING_KEY)).toEqual(expect.any(Number));
  });

  it("ends the typing mark when a text or picture goes", async () => {
    const storage = new MemoryStorage();
    const app = appLine(storage, () => 5);
    await app.startTyping(`app:${USER}`);
    await app.sendText(`app:${USER}`, "done", "k1");
    expect(await storage.get(APP_TYPING_KEY)).toBeUndefined();
  });

  it("marks typing with the time the line was asked to type", async () => {
    const storage = new MemoryStorage();
    await appLine(storage, () => 1234).startTyping(`app:${USER}`);
    expect(await storage.get(APP_TYPING_KEY)).toBe(1234);
  });

  it("answers the calls that have no Linq or Sendblue meaning with their 'nothing was sent' value", async () => {
    const app = line();
    expect(await app.acknowledge(`app:${USER}`, "m1", "👍")).toBe("👍");
    expect(await app.shareContactCard(`app:${USER}`)).toBe(false);
    expect(await app.shareProfile(`app:${USER}`)).toBe("not_yet");
    // "AAAA" is no picture: nothing is kept, and the picture is refused rather than sent empty.
    await expect(app.uploadPicture({ name: "a.png", mediaType: "image/png", data: "AAAA" })).rejects.toThrow();
    expect(app.sendAppCard).toBeUndefined();
    expect(app.sendCarousel).toBeUndefined();
  });
});

describe("lineFor an app chat", () => {
  const linq = { fetch: (async () => new Response(null, { status: 599 })) as unknown as Fetch, linqApiKey: "key" } as LineDeps;

  it("gives the app line, never Linq, when no gateway line is set", async () => {
    const line = lineFor(linq, `app:${USER}`);
    // Linq's line would call Linq's API through the fetch above and fail; the app line sends nothing and does not fail.
    await expect(line.sendText(`app:${USER}`, "hi", "k1")).resolves.toBe("app-k1");
    await expect(line.startTyping(`app:${USER}`)).resolves.toBeUndefined();
  });

  it("never sends a malformed app chat id to Linq either", async () => {
    const line = lineFor(linq, "app:NOT-A-USER");
    await expect(line.sendText("app:NOT-A-USER", "hi", "k1")).resolves.toBe("app-k1");
  });

  it("still serves a gateway's remote line for every chat when one is set", async () => {
    const seen: string[] = [];
    const remote = { sendText: async (chatId: string) => (seen.push(chatId), "remote") } as unknown as ReturnType<NonNullable<LineDeps["remote"]>>;
    const line = lineFor({ ...linq, remote: () => remote }, `app:${USER}`);
    expect(await line.sendText(`app:${USER}`, "hi", "k")).toBe("remote");
    expect(seen).toEqual([`app:${USER}`]);
  });
});

describe("an app chat's pictures", () => {
  // The first bytes of a PNG, then a few more: enough for the kind to be read from the bytes.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  it("keeps Tex's picture in the chat's own object, at an address only its fetch answers", async () => {
    const storage = new MemoryStorage();
    const { url } = (await appLine(storage, () => 5).uploadPicture({ name: "x.png", mediaType: "image/png", data: base64(PNG) })) as { url: string };
    expect(url).toMatch(/^https:\/\/app-chat\.invalid\/pic\/[0-9a-f]{32}\.png$/);
    const served = await serveAppPicture(storage, url);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("decides the kind from the bytes, never the label, and keeps none that could carry a script", async () => {
    const storage = new MemoryStorage();
    const svg = new TextEncoder().encode("<svg onload=alert(1)>");
    expect(await keepAppPicture(storage, svg, 1)).toBeNull();
    expect(sniffPictureType(PNG)).toBe("image/png");
    await expect(appLine(storage).uploadPicture({ name: "x.png", mediaType: "image/png", data: base64(svg) })).rejects.toThrow();
  });

  it("serves 404 for an id it does not keep, and for any other address", async () => {
    const storage = new MemoryStorage();
    expect((await serveAppPicture(storage, `${APP_PICTURE_ORIGIN}/pic/${"a".repeat(32)}.png`)).status).toBe(404);
    expect((await serveAppPicture(storage, "https://example.test/pic.png")).status).toBe(404);
    expect(await readAppPicture(storage, "../evil")).toBeNull();
  });

  it("keeps a picture over one stored value in pieces, and reads it back whole", async () => {
    const storage = new MemoryStorage();
    const big = new Uint8Array(4_000_000);
    big.set([0xff, 0xd8, 0xff], 0);
    big[3_999_999] = 7;
    const id = await keepAppPicture(storage, big, 1);
    expect(id).not.toBeNull();
    const kept = await readAppPicture(storage, id!);
    expect(kept?.mediaType).toBe("image/jpeg");
    expect(kept?.bytes.byteLength).toBe(4_000_000);
    expect(kept?.bytes[3_999_999]).toBe(7);
    expect(await keepAppPicture(storage, new Uint8Array(MAX_APP_PICTURE_BYTES + 1).fill(0xff), 1)).toBeNull();
    // Taken back: every piece is deleted, not only the head.
    await forgetAppPicture(storage, id!);
    expect(await readAppPicture(storage, id!)).toBeNull();
    expect([...(await storage.list({ prefix: "app:pic" })).keys()]).toEqual([]);
  });
});


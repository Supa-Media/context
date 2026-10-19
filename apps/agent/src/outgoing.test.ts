import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import { PICTURE_FAILED, readPictures, SHRINK_OVER_BYTES, shrinkPicture } from "./outgoing";
import type { ImagesLike } from "./attachments";
import type { Fetch } from "./clients";
import type { Message } from "./reply";
import { MemoryStorage } from "./memoryStorage.testing";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const msg = (text: string, channel?: "simulator"): Message => ({
  kind: "message",
  eventId: "e1",
  chatId: "chat_1",
  from: "+15555550100",
  messageId: "m_e1",
  text,
  ...(channel ? { channel } : {}),
});

type Call = { url: string; method: string; auth: string | null; body: unknown };

function world(gateway: Record<string, unknown>, opts: { mediaStatus?: number; uploadStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const auth = new Headers(init.headers).get("authorization");
    const path = new URL(url).pathname;
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ url, method: init.method ?? "GET", auth, body });
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent") return Response.json({ answer: "Here it is.", ...gateway });
    if (path.endsWith("/attachments")) {
      if (opts.uploadStatus) return new Response("{}", { status: opts.uploadStatus });
      return Response.json({
        attachment_id: "att_1",
        upload_url: "https://uploads.example/put/att_1?sig=x",
        required_headers: { "Content-Type": "image/png" },
        download_url: "https://cdn.example/att_1",
        expires_at: "",
        http_method: "PUT",
      });
    }
    if (url.startsWith("https://uploads.example/")) return new Response(null, { status: 200 });
    if (path.endsWith("/messages")) {
      const media = (body as { message: { parts: Array<{ type: string }> } }).message.parts[0].type === "media";
      return new Response("{}", { status: media ? (opts.mediaStatus ?? 200) : 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as Fetch;
  const deps: InboxDeps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => 1_000,
  };
  const sends = () =>
    calls
      .filter((call) => call.url.endsWith("/chats/chat_1/messages"))
      .map((call) => (call.body as { message: { parts: unknown[] } }).message.parts[0]);
  return { deps, calls, sends };
}

async function answer(w: ReturnType<typeof world>, message = msg("send me the frog")) {
  const storage = new MemoryStorage();
  await accept(storage, message, 1_000);
  await drain(storage, w.deps);
  return storage;
}

describe("pictures Tex texts back", () => {
  it("uploads a picture from their notes and sends it after the words", async () => {
    const w = world({ pictures: [{ name: "picture-1.png", mediaType: "image/png", data: PNG }] });
    await answer(w);
    expect(w.sends()).toEqual([{ type: "text", value: "Here it is." }, { type: "media", attachment_id: "att_1" }]);
    const create = w.calls.find((call) => call.url.endsWith("/attachments"));
    expect(create?.body).toMatchObject({ filename: "picture-1.png", content_type: "image/png", size_bytes: 70 });
    const put = w.calls.find((call) => call.url.startsWith("https://uploads.example/"));
    expect(put?.method).toBe("PUT");
    expect(put?.auth, "the API key never goes to the storage address").toBeNull();
  });

  it("sends a web picture by its address", async () => {
    const w = world({ pictures: [{ url: "https://images.example.org/dog.png" }] });
    await answer(w);
    expect(w.sends()).toEqual([{ type: "text", value: "Here it is." }, { type: "media", url: "https://images.example.org/dog.png" }]);
  });

  it("says so in a sentence when a picture can't be uploaded or Linq refuses it", async () => {
    const failed = world({ pictures: [{ name: "a.png", mediaType: "image/png", data: PNG }] }, { uploadStatus: 500 });
    await answer(failed);
    expect(failed.sends()).toEqual([{ type: "text", value: "Here it is." }, { type: "text", value: PICTURE_FAILED }]);

    const refused = world({ pictures: [{ url: "https://gone.example/x.jpg" }] }, { mediaStatus: 400 });
    const storage = await answer(refused);
    expect(refused.sends().at(-1)).toEqual({ type: "text", value: PICTURE_FAILED });
    expect((await storage.list({ prefix: "pending:" })).size, "nothing left to retry").toBe(0);
  });

  it("keeps only an attachment id, never bytes, when a send is retried", async () => {
    const w = world({ pictures: [{ name: "a.png", mediaType: "image/png", data: PNG }] }, { mediaStatus: 503 });
    const storage = await answer(w);
    const [pending] = [...(await storage.list<{ reply: unknown }>({ prefix: "pending:" })).values()];
    expect(pending.reply).toEqual(["Here it is.", { media: { attachment_id: "att_1" } }]);
    expect(JSON.stringify(pending)).not.toContain(PNG.slice(0, 30));
  });

  it("writes a simulated picture to the log, uploading nothing", async () => {
    const w = world({ pictures: [{ name: "a.png", mediaType: "image/png", data: PNG }] });
    await answer(w, msg("frog", "simulator"));
    expect(w.calls.some((call) => call.url.endsWith("/attachments"))).toBe(false);
  });

  it("drops what isn't a sendable picture", () => {
    expect(
      readPictures([
        { url: "http://plain.example/a.png" },
        { url: "https://user:pw@x.example/a.png" },
        { name: "../x", mediaType: "image/png", data: PNG },
        { name: "a.svg", mediaType: "image/svg+xml", data: PNG },
        { name: "a.png", mediaType: "image/png", data: "not base64!" },
        "nope",
      ]),
    ).toEqual([{ name: "picture", mediaType: "image/png", data: PNG }]);
  });
});

describe("shrinking a big photo before it goes", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const big = { name: "picture-1.png", mediaType: "image/png", data: btoa("x".repeat(SHRINK_OVER_BYTES + 3)) };
  const imagesAnswering = (body: Uint8Array, seen: unknown[] = []): ImagesLike => ({
    input: () =>
      ({
        transform: (t: unknown) => {
          seen.push(t);
          return { output: async (o: unknown) => (seen.push(o), { response: () => new Response(body) }) };
        },
      }) as unknown as ReturnType<ImagesLike["input"]>,
  });

  it("turns a photo over the limit into a JPEG", async () => {
    // The image model's PNGs ran past where a picture is kept for sending
    // (Dev's blue-clothes edit, 2026-10-19).
    const seen: unknown[] = [];
    const out = await shrinkPicture(imagesAnswering(JPEG, seen), big);
    expect(out).toEqual({ name: "picture-1.jpg", mediaType: "image/jpeg", data: btoa(String.fromCharCode(...JPEG)) });
    expect(seen).toEqual([{ width: 2048, height: 2048, fit: "scale-down" }, { format: "image/jpeg", quality: 85 }]);
  });

  it("leaves a small picture, a GIF, a failed conversion, and a line with no binding alone", async () => {
    const small = { name: "poster.png", mediaType: "image/png", data: btoa("small") };
    expect(await shrinkPicture(imagesAnswering(JPEG), small)).toBe(small);
    const gif = { ...big, mediaType: "image/gif" };
    expect(await shrinkPicture(imagesAnswering(JPEG), gif)).toBe(gif);
    expect(await shrinkPicture(imagesAnswering(new Uint8Array([1, 2, 3])), big)).toBe(big);
    const throwing = { input: () => { throw new Error("no"); } } as unknown as ImagesLike;
    expect(await shrinkPicture(throwing, big)).toBe(big);
    expect(await shrinkPicture(undefined, big)).toBe(big);
  });

  it("sends the shrunk JPEG, not the PNG", async () => {
    const w = world({ pictures: [big] });
    w.deps.images = imagesAnswering(JPEG);
    await answer(w);
    const create = w.calls.find((call) => call.url.endsWith("/attachments"));
    expect(create?.body).toMatchObject({ filename: "picture-1.jpg", content_type: "image/jpeg", size_bytes: JPEG.length });
  });
});

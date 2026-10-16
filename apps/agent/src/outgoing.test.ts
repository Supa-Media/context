import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import { PICTURE_FAILED, readPictures } from "./outgoing";
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

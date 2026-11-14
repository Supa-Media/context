import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "./clients";
import { isRefusal } from "./carousel";
import { lineFor, type LineDeps, type Picture } from "./line";
import { groupLineFor } from "./groupLine";
import { photonKind } from "./photonLine";
import { CARD_MEDIA_TYPE, texCard } from "./card";
import type { CountDataset } from "./textCounts";
import { photonCall } from "./photonClient";

type Call = { op: string; body: Record<string, unknown> };
type Answer = { status: number; body: unknown } | "throw";

const DM = "photon:+15550000001:+15550000002";
const DM_GUID = "any;-;+15550000002";
/** A group id as the gateway names it: `photon-group:<base64url(chatGuid)>`. */
const base64url = (value: string): string => btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const GROUP = `photon-group:${base64url("iMessage;+;chat123")}`;
const APP = { extensionBundleId: "lc.context.messages", teamId: "ABCDE12345", appStoreId: 1234 };
const NOTE = "https://context.lc/note/@alice/1-projects/launch-plan.md";

/** A fake PHOTON binding: records each op and its body, answers by `answer` or the default (a send gets a guid). */
function bridge(answer: (op: string, body: Record<string, unknown>) => Answer | undefined = () => undefined) {
  const calls: Call[] = [];
  const resolves: string[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const op = new URL(url).pathname.slice(1);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (op === "chat/resolve") resolves.push(String(body.address));
    else calls.push({ op, body });
    const chosen = answer(op, body) ?? defaultAnswer(op, body);
    if (chosen === "throw") throw new TypeError("network down");
    return new Response(JSON.stringify(chosen.body), { status: chosen.status, headers: { "content-type": "application/json" } });
  };
  return { calls, resolves, photon: { fetch } as unknown as Fetcher, ops: () => calls.map((call) => call.op) };
}

function defaultAnswer(op: string, body: Record<string, unknown>): Answer {
  if (op === "chat/resolve") return { status: 200, body: { ok: true, guid: `any;-;${String(body.address)}` } };
  if (op === "group/members") return { status: 200, body: { ok: true, participants: ["+15550000003", "+15550000004"] } };
  if (op.startsWith("send/")) return { status: 200, body: { ok: true, guid: "sent-guid" } };
  return { status: 200, body: { ok: true } };
}

const refuse = (status: number): Answer => ({ status, body: { ok: false, status, error: "refused" } });

function deps(photon: Fetcher | undefined, extra: Partial<LineDeps> = {}): LineDeps {
  return { fetch: (async () => new Response(null, { status: 200 })) as unknown as LineDeps["fetch"], linqApiKey: "", ...(photon ? { photon } : {}), ...extra };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Photon 1:1 line (photonLine.ts)", () => {
  it("a plain link goes as text with linkPreview, and no picture or 'Link:' lead-in ahead of it", async () => {
    const b = bridge();
    const link = "see https://example.com/post for the details";
    const guid = await lineFor(deps(b.photon), DM).sendText(DM, link, "k1");
    expect(guid).toBe("sent-guid");
    expect(b.calls).toEqual([{ op: "send/text", body: { line: "+15550000001", chat: DM_GUID, text: link, linkPreview: true } }]);
  });

  it("a note's link goes as our App Card, with the card's fields", async () => {
    const b = bridge();
    await lineFor(deps(b.photon, { appCard: APP }), DM).sendText(DM, NOTE, "k1", "reply-guid");
    expect(b.ops()).toEqual(["send/app"]);
    const card = b.calls[0].body;
    expect(card).toMatchObject({ line: "+15550000001", chat: DM_GUID, replyTo: "reply-guid" });
    expect(card.card).toMatchObject({ teamId: APP.teamId, extensionBundleId: APP.extensionBundleId, appStoreId: 1234, url: NOTE });
    expect(card.card).toHaveProperty("layout.caption");
    expect(card.card).toHaveProperty("layout.summary");
  });

  it("a line that refuses the card (400) gets the link as text with its preview", async () => {
    const b = bridge((op) => (op === "send/app" ? refuse(400) : undefined));
    await lineFor(deps(b.photon, { appCard: APP }), DM).sendText(DM, NOTE, "k1");
    expect(b.ops()).toEqual(["send/app", "send/text"]);
    expect(b.calls[1].body).toMatchObject({ text: NOTE, linkPreview: true });
  });

  it("a failed card (500) is not a refusal, so it is not sent as text", async () => {
    const b = bridge((op) => (op === "send/app" ? refuse(500) : undefined));
    await expect(lineFor(deps(b.photon, { appCard: APP }), DM).sendText(DM, NOTE, "k1")).rejects.toMatchObject({ service: "photon", status: 500 });
    expect(b.ops()).not.toContain("send/text");
  });

  it("a picture is hosted and sent by its address, as an attachment, with the picture's own media type", async () => {
    const b = bridge();
    const hostedAt: Picture[] = [];
    const line = lineFor(deps(b.photon, { hostPicture: async (picture) => (hostedAt.push(picture), "https://files.example.com/h/abc") }), DM);
    // A name whose extension says jpeg: a guess from the name would send image/jpeg, so the test sees the media type used.
    const picture: Picture = { name: "flyer.jpg", mediaType: "image/png", data: "iVBORw0KGgo=" };
    const media = await line.uploadPicture(picture);
    expect(media).toEqual({ url: "https://files.example.com/h/abc" });
    expect(hostedAt).toEqual([picture]);
    await line.sendMedia(DM, media, "k2", "r1");
    expect(b.calls.at(-1)).toEqual({
      op: "send/attachment",
      body: { line: "+15550000001", chat: DM_GUID, name: "flyer.jpg", mimeType: "image/png", url: "https://files.example.com/h/abc", replyTo: "r1" },
    });
  });

  it("with no host, a picture cannot be uploaded: a ServiceError with no status, and nothing is sent", async () => {
    const b = bridge();
    await expect(lineFor(deps(b.photon), DM).uploadPicture({ name: "a.png", mediaType: "image/png", data: "AAAA" })).rejects.toMatchObject({ service: "photon", status: null });
    expect(b.calls).toEqual([]);
  });

  it("a picture given by address goes to the bridge as that address, with a type from its name", async () => {
    const b = bridge();
    await lineFor(deps(b.photon), DM).sendMedia(DM, { url: "https://files.example.com/pics/beach.jpg" }, "k3");
    expect(b.calls.at(-1)?.body).toMatchObject({ name: "beach.jpg", mimeType: "image/jpeg", url: "https://files.example.com/pics/beach.jpg" });
  });

  it("a Linq attachment id is refused, since Photon cannot send it", async () => {
    const b = bridge();
    await expect(lineFor(deps(b.photon), DM).sendMedia(DM, { attachment_id: "x" }, "k4")).rejects.toMatchObject({ service: "photon", status: 400 });
    expect(b.calls.filter((c) => c.op === "send/attachment")).toEqual([]);
  });

  it("a carousel is one grouped send of attachments", async () => {
    const b = bridge();
    await lineFor(deps(b.photon), DM).sendCarousel?.(DM, ["https://a.example.com/1.png", "https://a.example.com/2.png"], "r2");
    expect(b.ops()).toEqual(["send/multipart"]);
    expect(b.calls[0].body).toEqual({
      line: "+15550000001",
      chat: DM_GUID,
      replyTo: "r2",
      parts: [
        { attachment: { name: "1.png", mimeType: "image/png", url: "https://a.example.com/1.png" } },
        { attachment: { name: "2.png", mimeType: "image/png", url: "https://a.example.com/2.png" } },
      ],
    });
  });

  it("the tapback is the emoji's kind, a like when the kind is refused, and a like for an emoji with none", async () => {
    const b = bridge();
    const line = lineFor(deps(b.photon), DM);
    await line.acknowledge(DM, "msg-1", "😂");
    expect(b.calls.at(-1)?.body).toMatchObject({ guid: "msg-1", kind: "laugh", on: true });
    await line.acknowledge(DM, "msg-1", "🫡");
    expect(b.calls.at(-1)?.body).toMatchObject({ kind: "like" });

    const refusing = bridge((op, body) => (op === "react" && body.kind === "love" ? refuse(400) : undefined));
    await lineFor(deps(refusing.photon), DM).acknowledge(DM, "msg-2", "❤️");
    expect(refusing.calls.filter((c) => c.op === "react").map((c) => c.body.kind)).toEqual(["love", "like"]);
  });

  it("the tapback never throws, even when the bridge is down", async () => {
    const b = bridge(() => "throw");
    await expect(lineFor(deps(b.photon), DM).acknowledge(DM, "msg-3", "👍")).resolves.toBeUndefined();
  });

  it("the emoji map reads each of iMessage's six tapbacks, and only them as their own kinds", () => {
    expect(photonKind("❤️")).toBe("love");
    expect(photonKind("👍")).toBe("like");
    expect(photonKind("👎")).toBe("dislike");
    expect(photonKind("😂")).toBe("laugh");
    expect(photonKind("‼️")).toBe("emphasize");
    expect(photonKind("❓")).toBe("question");
    expect(photonKind("🎨")).toBe("like");
  });

  it("a refused send is a 400 refusal and a failed one a 500 failure, both as ServiceError('photon')", async () => {
    const refused = bridge(() => refuse(400));
    const err400 = await lineFor(deps(refused.photon), DM).sendText(DM, "hello", "k5").catch((e: unknown) => e);
    expect(err400).toBeInstanceOf(ServiceError);
    expect(err400).toMatchObject({ service: "photon", status: 400 });
    expect(isRefusal(err400)).toBe(true);

    const failed = bridge((op) => (op === "send/text" ? refuse(500) : undefined));
    const err500 = await lineFor(deps(failed.photon), DM).sendText(DM, "hello", "k6").catch((e: unknown) => e);
    expect(err500).toMatchObject({ service: "photon", status: 500 });
    expect(isRefusal(err500)).toBe(false);

    const down = bridge(() => "throw");
    const errDown = await lineFor(deps(down.photon), DM).sendText(DM, "hello", "k7").catch((e: unknown) => e);
    expect(errDown).toMatchObject({ service: "photon", status: null });
  });

  it("with no PHOTON binding, a Photon chat fails to send as a ServiceError, not a Sendblue or Linq send", async () => {
    await expect(lineFor(deps(undefined), DM).sendText(DM, "hello", "k8")).rejects.toMatchObject({ service: "photon", status: null });
  });

  it("typing, read and the contact share are best effort; the contact card goes as a .vcf attachment", async () => {
    const b = bridge(() => "throw");
    const line = lineFor(deps(b.photon), DM);
    await expect(line.startTyping(DM)).resolves.toBeUndefined();
    await expect(line.markRead(DM)).resolves.toBeUndefined();
    await expect(line.shareContactCard(DM)).resolves.toBe(false);
    await expect(line.shareProfile(DM)).resolves.toBe("not_yet");

    const ok = bridge();
    const good = lineFor(deps(ok.photon), DM);
    await good.startTyping(DM);
    await good.markRead(DM);
    expect(ok.calls.slice(-2).map((c) => [c.op, c.body.on ?? null])).toEqual([["typing", true], ["read", null]]);
    expect(await good.shareContactCard(DM)).toBe(true);
    expect(ok.calls.at(-1)?.body).toMatchObject({ name: "Tex.vcf", mimeType: CARD_MEDIA_TYPE, data: btoa(texCard("+15550000001")) });
    expect(await good.shareProfile(DM)).toBe("shared");
    expect(ok.calls.at(-1)?.op).toBe("contact");
  });

  it("a 1:1 chat's guid is built from the phone, never looked up (a lookup can create an empty chat)", async () => {
    const b = bridge();
    const chat = "photon:+15550000001:+15550000009";
    const line = lineFor(deps(b.photon), chat);
    await line.sendText(chat, "one", "a");
    expect(b.resolves).toEqual([]);
    expect(b.calls.find((c) => c.op === "send/text")?.body).toMatchObject({ line: "+15550000001", chat: "any;-;+15550000009" });
  });

  it("the bridge's calls log one line each: op, time, outcome and status, never the text or a number", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const b = bridge();
    await lineFor(deps(b.photon), DM).sendText(DM, "secret words for +15550000002", "k9");
    const lines = log.mock.calls.map((args) => String(args[0]));
    const sendLine = lines.find((line) => line.includes('"op":"send/text"'));
    expect(sendLine).toBeDefined();
    expect(JSON.parse(sendLine!)).toMatchObject({ event: "photon_call", op: "send/text", ok: true, status: 200 });
    expect(lines.join("\n")).not.toContain("secret");
    expect(lines.join("\n")).not.toContain("555");
  });

  it("the typed call throws a 4xx refusal and a 5xx failure with the bridge's status", async () => {
    const b = bridge(() => refuse(422));
    await expect(photonCall(b.photon, "send/text", { text: "x" })).rejects.toMatchObject({ status: 422 });
    const c = bridge(() => ({ status: 200, body: { ok: false, status: 503, error: "stream down" } }));
    await expect(photonCall(c.photon, "send/text", { text: "x" })).rejects.toMatchObject({ status: 503 });
  });

  it("a counted line still counts each text it sends, and not one that failed", async () => {
    const points: Array<{ blobs?: string[] }> = [];
    const data: CountDataset = { writeDataPoint: (point) => void points.push(point) };
    const good = bridge();
    await lineFor(deps(good.photon, { textCounts: data }), DM).sendText(DM, "hello", "k10");
    const failed = bridge(() => refuse(500));
    await expect(lineFor(deps(failed.photon, { textCounts: data }), DM).sendText(DM, "hello", "k11")).rejects.toThrow();
    expect(points.map((p) => p.blobs)).toEqual([["out", "one", "text"]]);
  });
});

describe("Photon group line (photonLine.ts, groupLine.ts dispatch)", () => {
  it("a Photon group id is sent to by its chat guid, on the line the place names", async () => {
    const b = bridge();
    const app = groupLineFor({ fetch: globalThis.fetch, photon: b.photon }, GROUP);
    const handle = await app.sendText({ line: "+15550000001", groupId: GROUP }, "hi all", "r9");
    expect(handle).toBe("sent-guid");
    expect(b.calls).toEqual([{ op: "send/text", body: { line: "+15550000001", chat: "iMessage;+;chat123", text: "hi all", linkPreview: true, replyTo: "r9" } }]);
  });

  it("members are read as phones, null when the read fails, and the own-message read is null", async () => {
    const b = bridge();
    const app = groupLineFor({ fetch: globalThis.fetch, photon: b.photon }, GROUP);
    const place = { line: "+15550000001", groupId: GROUP };
    expect(await app.readMembers(place)).toEqual(["+15550000003", "+15550000004"]);
    expect(await app.readOwnMessage(place, "x")).toBeNull();

    const down = bridge(() => "throw");
    const broken = groupLineFor({ fetch: globalThis.fetch, photon: down.photon }, GROUP);
    expect(await broken.readMembers(place)).toBeNull();
    await expect(broken.react(place, "m1", "👍")).resolves.toBeUndefined();
  });

  it("a group's tapback falls back to a like, and a group's picture goes as an attachment by address", async () => {
    const b = bridge((op, body) => (op === "react" && body.kind === "laugh" ? refuse(400) : undefined));
    const app = groupLineFor({ fetch: globalThis.fetch, photon: b.photon }, GROUP);
    const place = { line: "+15550000001", groupId: GROUP };
    await app.react(place, "m2", "😂");
    expect(b.calls.filter((c) => c.op === "react").map((c) => c.body.kind)).toEqual(["laugh", "like"]);
    await app.sendMedia(place, "https://files.example.com/a.png", "r3");
    expect(b.calls.at(-1)?.body).toMatchObject({ chat: "iMessage;+;chat123", name: "a.png", mimeType: "image/png", replyTo: "r3" });
  });

  it("a malformed group id or line is a 400 refusal, never a send", async () => {
    const b = bridge();
    for (const groupId of ["photon-group:bad:guid:x", "photon-group:iMessage;+;chat123", `photon-group:${base64url("no:colons")}`]) {
      const app = groupLineFor({ fetch: globalThis.fetch, photon: b.photon }, groupId);
      await expect(app.sendText({ line: "+15550000001", groupId }, "hi")).rejects.toMatchObject({ service: "photon", status: 400 });
    }
    expect(b.calls).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { PhotonEvents } from "./photonEvents";
import { photonAttachmentUrl, photonChatId, photonGroupId, verifyPhotonAttachment } from "./photon";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const OTHER = "+15555550101";
const GUID = "any;+;ABCDEF0123456789";
const SECRET = "an-agent-worker-secret-long-enough";
const ORIGIN = "https://agent.example";

type Routed = { to: string; path: string; body: Record<string, unknown> };

/**
 * The Worker's env with the SenderInbox stubbed by name. `status` is what each inbox answers with; `origin` is what the
 * chat object reports as its stored origin (`/origin`), null for a chat that has never seen one.
 */
function env(over: Partial<Env> = {}, inbox: { status?: number; origin?: string | null } = {}): { env: Env; routed: Routed[]; bridge: string[] } {
  const routed: Routed[] = [];
  const bridge: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/origin") return Response.json({ origin: inbox.origin === undefined ? ORIGIN : inbox.origin });
        routed.push({ to: id.name, path, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json({ outcome: "queued" }, { status: inbox.status ?? 200 });
      },
    }),
  } as unknown as DurableObjectNamespace;
  const photon = {
    fetch: async (url: string) => {
      bridge.push(url);
      return new Response("PICTURE-BYTES", { status: 200, headers: { "content-type": "image/png", "content-length": "13" } });
    },
  } as unknown as Fetcher;
  return {
    routed,
    bridge,
    env: {
      SENDER_INBOX: namespace,
      LINQ_WEBHOOK_SECRET: "",
      LINQ_API_KEY: "k",
      AGENT_WORKER_SECRET: SECRET,
      CONTROL_PLANE_ORIGIN: "https://cp.example",
      GATEWAY_ORIGIN: "https://gw.example",
      PHOTON: photon,
      ...over,
    },
  };
}

/** The `PhotonEvents` entrypoint, as the runtime makes it for a call from the bridge. */
function entrypoint(e: Env): PhotonEvents {
  return new PhotonEvents({} as never, e);
}

/** A `PhotonEvent` as the bridge sends it (plan.md, Contract A); the overrides change one field each. */
function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    eventId: "photon:message.received:msg-1",
    type: "message.received",
    line: LINE,
    chat: { guid: `any;-;${PHONE}`, kind: "dm" },
    from: PHONE,
    fromMe: false,
    at: "2026-11-14T10:00:00.000Z",
    message: { guid: "msg-1", text: "hello", service: "iMessage" },
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("PhotonEvents.event: outcomes", () => {
  it("queues a person's text in their own inbox, and resolves 200", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event())).toEqual({ status: 200 });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/accept", body: { kind: "message", chatId: photonChatId(LINE, PHONE), text: "hello", messageId: "msg-1" } });
  });

  it("resolves 200 for a duplicate the inbox already holds, so the bridge moves on", async () => {
    const { env: e } = env({}, { status: 200 });
    expect(await entrypoint(e).event(event())).toEqual({ status: 200 });
    expect(await entrypoint(e).event(event())).toEqual({ status: 200 });
  });

  it("resolves 503 when the inbox cannot take the event, so the bridge retries it", async () => {
    const { env: e } = env({}, { status: 500 });
    expect(await entrypoint(e).event(event())).toEqual({ status: 503 });
  });

  it("resolves 400 for an event it cannot read", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event({ type: "message.received" })).toEqual({ status: 400 });
    expect(await entrypoint(e).event("not an object")).toEqual({ status: 400 });
    expect(routed).toEqual([]);
  });

  it("resolves 200 and routes nothing for Tex's own side, a read receipt, or an edit or unsend", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event({ fromMe: true }))).toEqual({ status: 200 });
    expect(await entrypoint(e).event(event({ type: "message.read", message: undefined }))).toEqual({ status: 200 });
    expect(await entrypoint(e).event(event({ type: "message.unsent", unsent: { targetGuid: "m" } }))).toEqual({ status: 200 });
    expect(await entrypoint(e).event(event({ type: "message.edited", message: { guid: "m", text: "new", service: "iMessage" }, edited: { targetGuid: "m" } }))).toEqual({ status: 200 });
    expect(routed).toEqual([]);
  });

  it("routes a tapback to the sender's inbox, carrying Tex's words it was on", async () => {
    const { env: e, routed } = env();
    const reaction = event({
      eventId: "photon:message.reactionAdded:msg-1",
      type: "message.reactionAdded",
      message: undefined,
      reaction: { kind: "like", targetGuid: "tex-1", targetText: "Book it?", targetFromMe: true },
    });
    expect(await entrypoint(e).event(reaction)).toEqual({ status: 200 });
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/react", body: { kind: "reaction", reaction: { how: "Liked", words: "Book it?", onTex: true }, chatId: photonChatId(LINE, PHONE) } });
    expect(routed[0].body).not.toHaveProperty("on");
  });

  it("routes a group's message to the group's own queue, and never to a sender's", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    const { env: e, routed } = env();
    const group = event({ chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, from: OTHER, message: { guid: "g-1", text: "hi all", service: "iMessage" } });
    expect(await entrypoint(e).event(group)).toEqual({ status: 200 });
    expect(routed).toHaveLength(1);
    expect(routed[0].to).not.toBe(PHONE);
    expect(routed[0].to).not.toBe(OTHER);
    expect(routed[0].body).toMatchObject({ kind: "group-message", groupId: photonGroupId(GUID), text: "hi all", from: OTHER });
  });

  it("resolves 503 for a group the queue cannot take", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    const { env: e } = env({}, { status: 500 });
    const group = event({ chat: { guid: GUID, kind: "group", participants: [PHONE] }, from: PHONE });
    expect(await entrypoint(e).event(group)).toEqual({ status: 503 });
  });
});

describe("PhotonEvents.event: pictures", () => {
  it("signs the picture's address under the Worker's own origin, and the turn gets that address", async () => {
    const { env: e, routed } = env({ AGENT_ORIGIN: ORIGIN });
    const withPicture = event({ message: { guid: "pic-1", text: "", service: "iMessage", attachments: [{ guid: "att-9", name: "p.png", mimeType: "image/png", size: 13 }] } });
    expect(await entrypoint(e).event(withPicture)).toEqual({ status: 200 });
    const attachments = routed[0].body.attachments as { url: string }[];
    expect(attachments).toHaveLength(1);
    const url = new URL(attachments[0].url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/photon/attachment/att-9");
    expect(await verifyPhotonAttachment(SECRET, "att-9", url.searchParams.get("s"))).toBe(true);
  });

  it("leaves a picture off when the deploy named no origin, and keeps its words", async () => {
    const { env: e, routed } = env({ AGENT_ORIGIN: undefined });
    const withPicture = event({ message: { guid: "pic-2", text: "look", service: "iMessage", attachments: [{ guid: "att-10", name: "p.png", mimeType: "image/png", size: 13 }] } });
    expect(await entrypoint(e).event(withPicture)).toEqual({ status: 200 });
    expect(routed[0].body).not.toHaveProperty("attachments");
    expect(routed[0].body).toMatchObject({ text: "look" });
  });
});

describe("GET /photon/attachment/<guid>", () => {
  it("streams a picture from the bridge, when the address carries its signature", async () => {
    const { env: e, bridge } = env();
    const address = (await photonAttachmentUrl(ORIGIN, SECRET, "att-9")) as string;
    const response = await worker.fetch(new Request(address), e);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(await response.text()).toBe("PICTURE-BYTES");
    expect(bridge).toEqual(["https://bridge/attachment/att-9"]);
  });

  it("answers the same 404 for a guid with no signature, another guid's signature, or a bad path, and never asks the bridge", async () => {
    const { env: e, bridge } = env();
    const signed = (await photonAttachmentUrl(ORIGIN, SECRET, "att-9")) as string;
    const sig = new URL(signed).searchParams.get("s");
    for (const path of [`/photon/attachment/att-9`, `/photon/attachment/att-8?s=${sig}`, `/photon/attachment/att-9?s=${"0".repeat(64)}`, `/photon/attachment/a%2Fb?s=${sig}`]) {
      expect((await worker.fetch(new Request(`${ORIGIN}${path}`), e)).status).toBe(404);
    }
    expect(bridge).toEqual([]);
  });

  it("is not there without the bridge binding", async () => {
    const { env: e } = env({ PHOTON: undefined });
    const address = (await photonAttachmentUrl(ORIGIN, SECRET, "att-9")) as string;
    expect((await worker.fetch(new Request(address), e)).status).toBe(404);
  });
});

describe("the event path has no public route", () => {
  it("answers 404 to a POST at the old address, whatever header it carries", async () => {
    const { env: e, routed } = env();
    const response = await worker.fetch(new Request(`${ORIGIN}/photon/event`, { method: "POST", headers: { "x-photon-bridge": "1" }, body: JSON.stringify(event()) }), e);
    expect(response.status).toBe(404);
    expect(routed).toEqual([]);
  });
});

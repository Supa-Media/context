import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { photonAttachmentUrl, photonBridgeToken, photonChatId, photonGroupId, PHOTON_BRIDGE_HEADER } from "./photon";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const OTHER = "+15555550101";
const GUID = "any;+;ABCDEF0123456789";
const SECRET = "an-agent-worker-secret-long-enough";
const ORIGIN = "https://agent.example";

type Routed = { to: string; path: string; body: Record<string, unknown> };

/** The Worker's env with the SenderInbox stubbed by name; `outcome` is what each inbox answers with, `status` its HTTP status. */
function env(over: Partial<Env> = {}, inbox: { status?: number } = {}): { env: Env; routed: Routed[]; bridge: string[] } {
  const routed: Routed[] = [];
  const bridge: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        routed.push({ to: id.name, path: new URL(url).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
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
      AGENT_ORIGIN: ORIGIN,
      CONTROL_PLANE_ORIGIN: "https://cp.example",
      GATEWAY_ORIGIN: "https://gw.example",
      PHOTON: photon,
      ...over,
    },
  };
}

async function token(): Promise<string> {
  return (await photonBridgeToken(SECRET)) as string;
}

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

async function send(body: unknown, headers: Record<string, string> = {}, path = "/photon/event"): Promise<Request> {
  return new Request(`https://agent.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

const authed = async (): Promise<Record<string, string>> => ({ [PHOTON_BRIDGE_HEADER]: await token() });

afterEach(() => vi.unstubAllGlobals());

describe("POST /photon/event: who may send", () => {
  it("refuses a request with no token, a guessed one, or the old flag, and reads nothing", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(await send(event()), e)).status).toBe(401);
    expect((await worker.fetch(await send(event(), { [PHOTON_BRIDGE_HEADER]: "1" }), e)).status).toBe(401);
    expect((await worker.fetch(await send(event(), { [PHOTON_BRIDGE_HEADER]: "0".repeat(64) }), e)).status).toBe(401);
    expect(routed).toEqual([]);
  });

  it("is not there at all without the bridge binding", async () => {
    const { env: e, routed } = env({ PHOTON: undefined });
    expect((await worker.fetch(await send(event(), await authed()), e)).status).toBe(404);
    expect(routed).toEqual([]);
  });

  it("answers 405 to anything but a POST", async () => {
    const { env: e } = env();
    expect((await worker.fetch(new Request(`${ORIGIN}/photon/event`, { method: "GET", headers: await authed() }), e)).status).toBe(405);
  });
});

describe("POST /photon/event: size", () => {
  it("refuses a body declared over the cap, before reading it", async () => {
    const { env: e, routed } = env();
    const request = await send(event(), { ...(await authed()), "content-length": String(300 * 1024) });
    expect((await worker.fetch(request, e)).status).toBe(413);
    expect(routed).toEqual([]);
  });

  it("refuses a body over the cap that did not declare its length", async () => {
    const { env: e, routed } = env();
    const huge = JSON.stringify(event({ message: { guid: "m", text: "x".repeat(300 * 1024), service: "iMessage" } }));
    expect((await worker.fetch(await send(huge, await authed()), e)).status).toBe(413);
    expect(routed).toEqual([]);
  });
});

describe("POST /photon/event: outcomes", () => {
  it("queues a person's text in their own inbox, and answers 200", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(await send(event(), await authed()), e)).status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/accept", body: { kind: "message", chatId: photonChatId(LINE, PHONE), text: "hello", messageId: "msg-1" } });
  });

  it("answers 200 for a duplicate the inbox already holds, so the bridge moves on", async () => {
    const { env: e } = env({}, { status: 200 });
    const request = await send(event(), await authed());
    expect((await worker.fetch(request, e)).status).toBe(200);
    expect((await worker.fetch(await send(event(), await authed()), e)).status).toBe(200);
  });

  it("answers 503 when the inbox cannot take the event, so the bridge retries it", async () => {
    const { env: e } = env({}, { status: 500 });
    expect((await worker.fetch(await send(event(), await authed()), e)).status).toBe(503);
  });

  it("answers 400 for an event it cannot read, and 400 for a body that is not JSON", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(await send({ type: "message.received" }, await authed()), e)).status).toBe(400);
    expect((await worker.fetch(await send("{not json", await authed()), e)).status).toBe(400);
    expect(routed).toEqual([]);
  });

  it("answers 200 and routes nothing for Tex's own side, a read receipt, or a side event", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(await send(event({ fromMe: true }), await authed()), e)).status).toBe(200);
    expect((await worker.fetch(await send(event({ type: "message.read", message: undefined }), await authed()), e)).status).toBe(200);
    expect((await worker.fetch(await send(event({ type: "message.unsent", unsent: { targetGuid: "m" } }), await authed()), e)).status).toBe(200);
    expect((await worker.fetch(await send(event({ type: "message.edited", message: { guid: "m", text: "new", service: "iMessage" }, edited: { targetGuid: "m" } }), await authed()), e)).status).toBe(200);
    expect(routed).toEqual([]);
  });

  it("routes a tapback to the sender's inbox, as a react", async () => {
    const { env: e, routed } = env();
    const reaction = event({ eventId: "photon:message.reactionAdded:msg-1", type: "message.reactionAdded", message: undefined, reaction: { kind: "like", targetGuid: "tex-1" } });
    expect((await worker.fetch(await send(reaction, await authed()), e)).status).toBe(200);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/react", body: { kind: "reaction", reaction: { how: "Liked", words: "" }, chatId: photonChatId(LINE, PHONE) } });
    expect(routed[0].body).not.toHaveProperty("on");
  });

  it("routes a group's message to the group's own queue, and never to a sender's", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    const { env: e, routed } = env();
    const group = event({ chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, from: OTHER, message: { guid: "g-1", text: "hi all", service: "iMessage" } });
    expect((await worker.fetch(await send(group, await authed()), e)).status).toBe(200);
    expect(routed).toHaveLength(1);
    expect(routed[0].to).not.toBe(PHONE);
    expect(routed[0].to).not.toBe(OTHER);
    expect(routed[0].body).toMatchObject({ kind: "group-message", groupId: photonGroupId(GUID), text: "hi all", from: OTHER });
  });

  it("answers 503 for a group the queue cannot take", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    const { env: e } = env({}, { status: 500 });
    const group = event({ chat: { guid: GUID, kind: "group", participants: [PHONE] }, from: PHONE });
    expect((await worker.fetch(await send(group, await authed()), e)).status).toBe(503);
  });

  it("hands the picture's signed address to the turn, not the bridge's", async () => {
    const { env: e, routed } = env();
    const withPicture = event({ message: { guid: "pic-1", text: "", service: "iMessage", attachments: [{ guid: "att-9", name: "p.png", mimeType: "image/png", size: 13 }] } });
    expect((await worker.fetch(await send(withPicture, await authed()), e)).status).toBe(200);
    const [{ body }] = routed;
    const attachments = body.attachments as { url: string }[];
    expect(attachments).toHaveLength(1);
    const url = new URL(attachments[0].url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/photon/attachment/att-9");
    expect(url.searchParams.get("s")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("leaves a picture off when no public origin is set, and answers as its words allow", async () => {
    const { env: e, routed } = env({ AGENT_ORIGIN: undefined });
    const withPicture = event({ message: { guid: "pic-2", text: "look", service: "iMessage", attachments: [{ guid: "att-10", name: "p.png", mimeType: "image/png", size: 13 }] } });
    expect((await worker.fetch(await send(withPicture, await authed()), e)).status).toBe(200);
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

describe("the bridge's token is for Photon's route alone", () => {
  it("does not stand in for Sendblue's own secret on the Sendblue route", async () => {
    const { env: e, routed } = env();
    const request = new Request(`${ORIGIN}/sendblue`, { method: "POST", headers: { "content-type": "application/json", ...(await authed()) }, body: "{}" });
    expect((await worker.fetch(request, e)).status).toBe(401);
    expect(routed).toEqual([]);
  });
});

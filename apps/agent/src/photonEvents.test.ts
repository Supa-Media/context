import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { PhotonEvents } from "./photonEvents";
import { photonAttachmentUrl, photonChatId, photonGroupId, verifyPhotonAttachment } from "./photon";
import { groupInboxName } from "./groupInbox";
import { clearGroupMoveCache } from "./groupMoves";

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
function env(over: Partial<Env> = {}, inbox: { status?: number; origin?: string | null; moves?: (path: string, body: Record<string, unknown>) => Record<string, unknown> | undefined } = {}): { env: Env; routed: Routed[]; bridge: string[] } {
  const routed: Routed[] = [];
  const bridge: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/origin") return Response.json({ origin: inbox.origin === undefined ? ORIGIN : inbox.origin });
        // The `group-moves` object (`groupMoves.ts`): no group here has moved unless a test says so.
        if (path.startsWith("/group-move/")) return Response.json(inbox.moves?.(path, JSON.parse(String(init?.body ?? "{}"))) ?? {});
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

afterEach(() => {
  vi.unstubAllGlobals();
  clearGroupMoveCache();
});

describe("PhotonEvents.event: outcomes", () => {
  it("queues a person's text in their own inbox, and resolves 200", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event())).toEqual({ status: 200 });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/accept", body: { kind: "message", chatId: photonChatId(LINE, PHONE), text: "hello", messageId: "msg-1" } });
  });

  it("carries Apple's time for the text and the lag to this Worker, for the chat's text step, on a text, a group's text and a tapback", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-14T10:00:07.000Z"), toFake: ["Date"] });
    try {
      vi.stubGlobal("fetch", async () => Response.json({}));
      const { env: e, routed } = env();
      await entrypoint(e).event(event());
      await entrypoint(e).event(event({ eventId: "photon:message.received:g-2", chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, from: OTHER, message: { guid: "g-2", text: "hi all", service: "iMessage" } }));
      await entrypoint(e).event(event({ eventId: "photon:message.reactionAdded:msg-1:3", type: "message.reactionAdded", message: undefined, reaction: { kind: "love", targetGuid: "msg-1" } }));
      const provider = { name: "photon", providerAt: Date.parse("2026-11-14T10:00:00.000Z"), receivedAt: Date.parse("2026-11-14T10:00:07.000Z"), lagMs: 7000 };
      expect(routed.map((r) => r.path)).toEqual(["/accept", "/group-accept", "/react"]);
      for (const r of routed) expect((r.body as { provider?: unknown }).provider).toEqual(provider);
    } finally {
      vi.useRealTimers();
    }
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

  it("hands Tex's own text reaching Apple, and the person reading it, to the chat's send status with Apple's times, and never as a text", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event({ fromMe: true, from: undefined, message: { guid: "tex-1", text: "Tex's words", service: "iMessage" } }))).toEqual({ status: 200 });
    expect(await entrypoint(e).event(event({ type: "message.read", eventId: "photon:message.read:tex-1:4", message: undefined, read: { targetGuid: "tex-1" }, at: "2026-11-14T10:05:00.000Z" }))).toEqual({ status: 200 });
    expect(await entrypoint(e).event(event({ fromMe: true, from: undefined, chat: { guid: GUID, kind: "group" }, message: { guid: "tex-2", text: "hi all", service: "iMessage" } }))).toEqual({ status: 200 });
    expect(routed.map((r) => [r.to, r.path])).toEqual([[PHONE, "/send-status"], [PHONE, "/send-status"], [groupInboxName(photonGroupId(GUID)), "/send-status"]]);
    expect(routed[0].body).toMatchObject({ handle: "tex-1", status: "SENT", chat: photonChatId(LINE, PHONE), report: { name: "photon", handle: "tex-1", status: "sent", providerAt: Date.parse("2026-11-14T10:00:00.000Z") } });
    expect(routed[1].body).toMatchObject({ handle: "tex-1", status: "READ", report: { status: "read", providerAt: Date.parse("2026-11-14T10:05:00.000Z") } });
    expect(routed[2].body).toMatchObject({ handle: "tex-2", chat: photonGroupId(GUID), object: { kind: "group", groupId: photonGroupId(GUID) } });
    expect(JSON.stringify(routed)).not.toContain("Tex's words");
  });

  it("routes nothing for Tex's own side reading the person's text", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event({ type: "message.read", fromMe: true, message: undefined, read: { targetGuid: "msg-1" } }))).toEqual({ status: 200 });
    expect(routed).toEqual([]);
  });

  it("resolves 200 and routes nothing for a read receipt that names no message", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event({ type: "message.read", message: undefined }))).toEqual({ status: 200 });
    expect(routed).toEqual([]);
  });

  it("routes an unsend to the sender's chat's edit step, with no words", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event({ eventId: "photon:message.unsent:m:9", type: "message.unsent", message: undefined, unsent: { targetGuid: "m" } }))).toEqual({ status: 200 });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/edit", body: { kind: "unsent", messageId: "m", chatId: photonChatId(LINE, PHONE) } });
    expect(routed[0].body).not.toHaveProperty("text");
  });

  it("routes an edit to the sender's chat's edit step, with its new words, its old ones and Apple's time", async () => {
    const { env: e, routed } = env();
    const edit = event({ eventId: "photon:message.edited:m:7", type: "message.edited", message: { guid: "m", text: "dinner at 7 not 6", service: "iMessage" }, edited: { targetGuid: "m", previousText: "dinner at 6" } });
    expect(await entrypoint(e).event(edit)).toEqual({ status: 200 });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/edit", body: { kind: "edited", chatId: photonChatId(LINE, PHONE), messageId: "m", text: "dinner at 7 not 6", previous: "dinner at 6", provider: { name: "photon" } } });
  });

  it("routes a group's edit to the group's own object, never a sender's", async () => {
    const { env: e, routed } = env();
    const edit = event({ eventId: "photon:message.edited:g-1:8", type: "message.edited", chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, from: OTHER, message: { guid: "g-1", text: "friday works", service: "iMessage" }, edited: { targetGuid: "g-1" } });
    expect(await entrypoint(e).event(edit)).toEqual({ status: 200 });
    expect(routed.map((r) => [r.to, r.path])).toEqual([[groupInboxName(photonGroupId(GUID)), "/edit"]]);
    expect(routed[0].body).toMatchObject({ groupId: photonGroupId(GUID), from: OTHER, text: "friday works" });
  });

  it("asks the bridge to send an edit again when its chat could not take it", async () => {
    const { env: e } = env({}, { status: 503 });
    expect(await entrypoint(e).event(event({ type: "message.edited", message: { guid: "m", text: "new", service: "iMessage" }, edited: { targetGuid: "m" } }))).toEqual({ status: 503 });
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

describe("PhotonEvents.event: messages the line drops", () => {
  // 2026-11-17: a 1:1 link sent with Apple's preview was dropped as another app's card, and nothing in the chat showed it.
  it("queues a 1:1 link sent with Apple's preview as the person's words", async () => {
    const { env: e, routed } = env();
    const link = "https://shop.example/products/hoodie";
    const preview = { guid: "m-link", text: link, service: "iMessage", balloonBundleId: "com.apple.messages.URLBalloonProvider" };
    expect(await entrypoint(e).event(event({ message: preview }))).toEqual({ status: 200 });
    expect(routed).toEqual([expect.objectContaining({ to: PHONE, path: "/accept", body: expect.objectContaining({ text: link, messageId: "m-link" }) })]);
  });

  it("tells the chat a message it dropped, with the reason and never the words", async () => {
    const { env: e, routed } = env();
    const card = { guid: "m-app", text: "Poll: lunch?", service: "iMessage", balloonBundleId: "com.example.polls", appUrl: "https://x.example" };
    expect(await entrypoint(e).event(event({ message: card }))).toEqual({ status: 200 });
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ to: PHONE, path: "/dropped", body: { chat: photonChatId(LINE, PHONE), kind: "one", reason: "app_card", provider: { name: "photon" } } });
    expect(JSON.stringify(routed[0]!.body)).not.toContain("lunch");
  });

  it("tells a group's own object a message dropped there, never a sender's", async () => {
    const { env: e, routed } = env();
    const empty = event({ chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, message: { guid: "g-0", text: " ", service: "iMessage" } });
    expect(await entrypoint(e).event(empty)).toEqual({ status: 200 });
    expect(routed).toEqual([expect.objectContaining({ to: groupInboxName(photonGroupId(GUID)), path: "/dropped", body: expect.objectContaining({ chat: photonGroupId(GUID), kind: "group", reason: "empty" }) })]);
  });

  it("files a drop in a moved group under the old group, and never takes it for the old number's swap note", async () => {
    const asked: Record<string, unknown>[] = [];
    const moves = (_path: string, body: Record<string, unknown>) => (asked.push(body), body.from === "" ? { from: { line: OTHER, groupId: "old-group" } } : { from: { line: OTHER, groupId: "old-group" }, matched: { groupKey: "k" } });
    const { env: e, routed } = env({}, { moves });
    const empty = event({ chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, from: OTHER, message: { guid: "g-0", text: " ", service: "iMessage" } });
    expect(await entrypoint(e).event(empty)).toEqual({ status: 200 });
    expect(asked).toEqual([expect.objectContaining({ from: "", participants: [] })]);
    expect(routed).toEqual([expect.objectContaining({ to: groupInboxName("old-group"), path: "/dropped", body: expect.objectContaining({ chat: "old-group" }) })]);
  });

  it("still resolves 200 when the chat could not note the drop, so the bridge never sends it again", async () => {
    const { env: e } = env({}, { status: 500 });
    const card = { guid: "m-app", text: "Poll", service: "iMessage", balloonBundleId: "com.example.polls", appUrl: "https://x.example" };
    expect(await entrypoint(e).event(event({ message: card }))).toEqual({ status: 200 });
  });

  it("notes nothing for a drop that names no chat", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(event({ from: "person@example.com" }))).toEqual({ status: 200 });
    expect(routed).toEqual([]);
  });
});

describe("PhotonEvents.event: a group staff moved to the new number", () => {
  const OLD_LINE = "+15555550188";
  const OLD = { line: OLD_LINE, groupId: "sb-group-1" };

  it("files the new line's message under the old group, with the old line in the new one's place", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    const { env: e, routed } = env({}, { moves: (path) => (path === "/group-move/arrive" ? { from: OLD } : undefined) });
    const group = event({ chat: { guid: GUID, kind: "group", participants: [LINE, PHONE, OTHER] }, from: OTHER, message: { guid: "g-9", text: "hi all", service: "iMessage" } });
    expect(await entrypoint(e).event(group)).toEqual({ status: 200 });
    expect(routed.map((r) => [r.to, r.path])).toEqual([[groupInboxName("sb-group-1"), "/group-accept"]]);
    expect(routed[0].body).toMatchObject({ groupId: "sb-group-1", line: OLD_LINE, messageId: "g-9", from: OTHER });
    expect((routed[0].body.participants as string[]).sort()).toEqual([OLD_LINE, PHONE, OTHER].sort());
  });

  it("on the old number's swap note, takes the old number out and reports the group moved, and the note takes no turn", async () => {
    const reports: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/agent-texts/move-report") reports.push(JSON.parse(String(init?.body)));
      return Response.json({ outcome: "noted" });
    });
    const removed: unknown[] = [];
    const photon = { fetch: async (url: string, init?: RequestInit) => (removed.push([new URL(url).pathname, JSON.parse(String(init?.body))]), Response.json({ ok: true, participants: [] })) } as unknown as Fetcher;
    const matched = { groupKey: "a".repeat(64), line: OLD_LINE, groupId: "sb-group-1", askedAt: 7 };
    const { env: e, routed } = env({ PHOTON: photon }, { moves: (path) => (path === "/group-move/arrive" ? { from: OLD, matched } : undefined) });
    const note = event({ chat: { guid: GUID, kind: "group", participants: [LINE, OLD_LINE, PHONE] }, from: OLD_LINE, message: { guid: "g-10", text: "swapping numbers", service: "iMessage" } });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await entrypoint(e).event(note)).toEqual({ status: 200 });
    expect(routed).toEqual([]);
    expect(removed).toEqual([["/group/remove", { line: LINE, chat: GUID, address: OLD_LINE }]]);
    expect(reports).toEqual([{ kind: "group", key: "a".repeat(64), status: "moved" }]);
  });

  it("reads the group's people from the bridge when the note's event lists only the old number (Dev2's first group move)", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ outcome: "noted" }));
    const calls: [string, unknown][] = [];
    const photon = { fetch: async (url: string, init?: RequestInit) => (calls.push([new URL(url).pathname, JSON.parse(String(init?.body))]), Response.json({ ok: true, participants: [OLD_LINE, PHONE] })) } as unknown as Fetcher;
    const matched = { groupKey: "a".repeat(64), line: OLD_LINE, groupId: "sb-group-1", askedAt: 7 };
    const asked: unknown[] = [];
    const moves = (path: string, body: Record<string, unknown>) => {
      if (path !== "/group-move/arrive") return undefined;
      asked.push(body.participants);
      return (body.participants as string[]).includes(PHONE) ? { from: OLD, matched } : { waiting: true, people: 0 };
    };
    const { env: e, routed } = env({ PHOTON: photon }, { moves });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await entrypoint(e).event(event({ chat: { guid: GUID, kind: "group" }, from: OLD_LINE, message: { guid: "g-12", text: "swapping numbers", service: "iMessage" } }));
    expect(asked).toEqual([[OLD_LINE], [OLD_LINE, PHONE]]);
    expect(calls.map(([path]) => path)).toEqual(["/group/members", "/group/remove"]);
    expect(routed).toEqual([]);
  });

  it("reports the move failed when the new line could not take the old number out", async () => {
    const reports: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => (reports.push(JSON.parse(String(init?.body))), Response.json({ outcome: "noted" })));
    const photon = { fetch: async () => Response.json({ ok: false, error: "refused" }, { status: 502 }) } as unknown as Fetcher;
    const matched = { groupKey: "a".repeat(64), line: OLD_LINE, groupId: "sb-group-1", askedAt: 7 };
    const { env: e } = env({ PHOTON: photon }, { moves: (path) => (path === "/group-move/arrive" ? { from: OLD, matched } : undefined) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await entrypoint(e).event(event({ chat: { guid: GUID, kind: "group", participants: [LINE, OLD_LINE, PHONE] }, from: OLD_LINE, message: { guid: "g-11", text: "swapping numbers", service: "iMessage" } }));
    expect(reports).toEqual([{ kind: "group", key: "a".repeat(64), status: "failed", detail: "remove_failed", askedAt: 7 }]);
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
    expect(await verifyPhotonAttachment(SECRET, "att-9", url.searchParams.get("s"), url.searchParams.get("e"))).toBe(true);
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

describe("PhotonEvents.event: a group's name and its people", () => {
  const OLD = { line: "+15555550188", groupId: "sb-group-1" };
  /** The control plane's calls, by path and body. */
  function controlPlane(): { calls: { path: string; body: Record<string, unknown> }[] } {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json({});
    });
    return { calls };
  }
  const change = (group: Record<string, unknown>) => event({ type: "group.changed", eventId: "photon:group.changed:x:7", message: undefined, chat: { guid: GUID, kind: "group", name: "Band" }, from: OTHER, group });

  it("sends a group text's name to the app, as Sendblue's webhook gave it with every message", async () => {
    const cp = controlPlane();
    const { env: e } = env();
    await entrypoint(e).event(event({ chat: { guid: GUID, kind: "group", name: " Gig\u202e night ", participants: [PHONE, OTHER] }, from: OTHER, message: { guid: "g-n", text: "hi", service: "iMessage" } }));
    expect(cp.calls.find((c) => c.path === "/agent-texts/group/name")?.body).toEqual({ line: LINE, groupId: photonGroupId(GUID), name: "Gig night" });
  });

  it("a rename goes to the app under the group Tex files it as, and takes no turn", async () => {
    const cp = controlPlane();
    const { env: e, routed } = env({}, { moves: (path) => (path === "/group-move/arrive" ? { from: OLD } : undefined) });
    expect(await entrypoint(e).event(change({ change: "displayNameChanged", displayName: "Tour 2027" }))).toEqual({ status: 200 });
    expect(cp.calls.filter((c) => c.path === "/agent-texts/group/name").map((c) => c.body)).toEqual([{ line: OLD.line, groupId: OLD.groupId, name: "Tour 2027" }]);
    expect(routed).toEqual([]);
  });

  it("somebody added, removed or leaving marks the group's kept people changed, and never asks a move to match", async () => {
    controlPlane();
    const arrivals: Record<string, unknown>[] = [];
    const { env: e, routed } = env({}, { moves: (path, body) => (path === "/group-move/arrive" ? (arrivals.push(body), {}) : undefined) });
    for (const kind of ["participantAdded", "participantRemoved", "participantLeft"]) {
      expect(await entrypoint(e).event(change({ change: kind, address: OTHER }))).toEqual({ status: 200 });
    }
    expect(routed.map((r) => [r.to, r.path])).toEqual(Array(3).fill([groupInboxName(photonGroupId(GUID)), "/group-members-changed"]));
    expect(arrivals.every((a) => a.from === "")).toBe(true);
  });

  it("a group change it does not read, or a 1:1 chat's, is ignored with its own reason", async () => {
    const { env: e, routed } = env();
    expect(await entrypoint(e).event(change({ change: "groupIconChanged" }))).toEqual({ status: 200 });
    expect(routed).toEqual([]);
  });
});

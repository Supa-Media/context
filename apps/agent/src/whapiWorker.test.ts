import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { WHAPI_SECRET_HEADER } from "./whapi";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const GROUP = "120363012345678901@g.us";
const SECRET = "a-webhook-secret-long-enough";

function env(): { env: Env; routed: { to: string; body: Record<string, unknown>; path?: string }[] } {
  const routed: { to: string; body: Record<string, unknown>; path?: string }[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name: name.replace(/^enam:/, "") }), // inboxes live under `enam:<name>` (`inboxByName`); kept here by name
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        // A group's members changed (`groupMembers.ts`) is named by its path; every other route by its body, as before.
        routed.push({ to: id.name, body: JSON.parse(String(init?.body ?? "{}")), ...(path === "/group-members-changed" ? { path } : {}) });
        return Response.json({ outcome: "queued" });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return {
    routed,
    env: {
      SENDER_INBOX: namespace,
      LINQ_WEBHOOK_SECRET: "",
      LINQ_API_KEY: "k",
      AGENT_WORKER_SECRET: "s",
      CONTROL_PLANE_ORIGIN: "https://cp.example",
      GATEWAY_ORIGIN: "https://gw.example",
      WHAPI_TOKEN: "token",
      WHAPI_LINE: LINE,
      WHAPI_WEBHOOK_SECRET: SECRET,
    },
  };
}

const post = (messages: unknown[], secret: string | null = SECRET) =>
  new Request("https://agent.example/whapi", {
    method: "POST",
    headers: secret === null ? {} : { [WHAPI_SECRET_HEADER]: secret },
    body: JSON.stringify({ messages, event: { type: "messages", event: "post" }, channel_id: "CHAN-1" }),
  });

const text = (over: Record<string, unknown> = {}) => ({
  id: "PsobWy36679._7w-wKmB9tMeGQ",
  type: "text",
  chat_id: "15555550100@s.whatsapp.net",
  from: "15555550100",
  from_me: false,
  timestamp: 1_800_000_000,
  text: { body: "hello" },
  ...over,
});

/** Whapi's GET /messages/{id}, answering with the message given. */
function whapiServes(message: Record<string, unknown> | null) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return message === null ? new Response(null, { status: 404 }) : Response.json(message);
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("whapi webhook", () => {
  it("refuses a delivery without our secret, and routes nothing", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(post([text()], null), e)).status).toBe(401);
    expect((await worker.fetch(post([text()], "a-different-secret-entirely"), e)).status).toBe(401);
    e.WHAPI_WEBHOOK_SECRET = "";
    expect((await worker.fetch(post([text()]), e)).status).toBe(401);
    expect(routed).toEqual([]);
  });

  it("queues a person's text in their own inbox, on a WhatsApp chat id", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(post([text()]), e)).status).toBe(200);
    expect(routed.map(({ to }) => to)).toEqual([PHONE]);
    expect(routed[0].body).toMatchObject({ kind: "message", chatId: `whapi:${LINE}:${PHONE}`, from: PHONE, text: "hello" });
  });

  it("never reads a WhatsApp private id (@lid) as a phone number", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(post([text({ chat_id: "15555550100@lid", from: "15555550100@lid" })]), e)).status).toBe(200);
    expect(routed).toEqual([]);
  });

  it("takes and drops a signed delivery while no line is set up", async () => {
    const { env: e, routed } = env();
    e.WHAPI_TOKEN = "";
    expect((await worker.fetch(post([text()]), e)).status).toBe(200);
    expect(routed).toEqual([]);
  });

  it("sends a group's message to the group's own queue, never a sender's", async () => {
    const { env: e, routed } = env();
    expect((await worker.fetch(post([text({ chat_id: GROUP, text: { body: "@15555550199 what's on today" } })]), e)).status).toBe(200);
    expect(routed.map(({ to }) => to)).toEqual([`sendblue-group:whapi:${GROUP}`]);
    expect(routed[0].body).toMatchObject({ kind: "group-message", groupId: `whapi:${GROUP}`, line: LINE, from: PHONE, text: "Tex what's on today" });
  });

  it("reads a group 👍's words only from a text Tex itself sent in that group", async () => {
    const reaction = text({ chat_id: GROUP, type: "action", text: undefined, action: { type: "reaction", target: "TEXASK-0001", emoji: "👍" } });

    const own = env();
    whapiServes({ id: "TEXASK-0001", chat_id: GROUP, from_me: true, text: { body: "Give this a 👍 and I'll send it." } });
    await worker.fetch(post([reaction]), own.env);
    expect(own.routed.map(({ to }) => to)).toEqual([`sendblue-group:whapi:${GROUP}`]);
    expect(own.routed[0].body).toMatchObject({ reaction: { how: "Liked", words: "Give this a 👍 and I'll send it." } });
    expect(own.routed[0].body).not.toHaveProperty("reactionOn");

    for (const served of [
      { id: "TEXASK-0001", chat_id: GROUP, from_me: false, text: { body: "Give this a 👍 and I'll send it." } },
      { id: "TEXASK-0001", chat_id: "120363099999999999@g.us", from_me: true, text: { body: "Give this a 👍 and I'll send it." } },
      null,
    ]) {
      const other = env();
      whapiServes(served);
      await worker.fetch(post([reaction]), other.env);
      // Since 2026-11-01 (Dev2) it still reaches the group, as context on somebody's message, naming no ask.
      expect(other.routed[0].body).toMatchObject({ reaction: { how: "Liked", words: "", onOther: true } });
    }
  });

  it("reads a 1:1 reaction's words only from Tex's own text in that person's chat", async () => {
    const reaction = text({ type: "action", text: undefined, action: { type: "reaction", target: "TEXASK-0002", emoji: "👍" } });

    const own = env();
    const asked = whapiServes({ id: "TEXASK-0002", chat_id: "15555550100@s.whatsapp.net", from_me: true, text: { body: "Book it?" } });
    await worker.fetch(post([reaction]), own.env);
    expect(asked).toEqual(["https://gate.whapi.cloud/messages/TEXASK-0002"]);
    expect(own.routed[0]).toMatchObject({ to: PHONE, body: { kind: "reaction", reaction: { how: "Liked", words: "Book it?" } } });
    expect(own.routed[0].body).not.toHaveProperty("on");

    const elsewhere = env();
    whapiServes({ id: "TEXASK-0002", chat_id: "15555550111@s.whatsapp.net", from_me: true, text: { body: "Someone else's ask" } });
    await worker.fetch(post([reaction]), elsewhere.env);
    expect(elsewhere.routed[0].body).toMatchObject({ reaction: { words: "", onOther: true } });
  });

  // Without it, a like on one's own message reaches `onTheAsk` as one whose
  // words could not be read, and is taken for the ask still armed
  // (`askThumbUnnamed.test.ts`).
  it("marks a 1:1 reaction read and found not to be Tex's, so it names no ask", async () => {
    const reaction = text({ type: "action", text: undefined, action: { type: "reaction", target: "THEIRS-0001", emoji: "👍" } });

    const theirs = env();
    whapiServes({ id: "THEIRS-0001", chat_id: "15555550100@s.whatsapp.net", from_me: false, text: { body: "my own earlier text" } });
    await worker.fetch(post([reaction]), theirs.env);

    expect(theirs.routed[0].body).toMatchObject({ reaction: { how: "Liked", words: "", onOther: true } });
  });

  it("leaves a 1:1 reaction whose message could not be read unmarked, so the fallback stands", async () => {
    const reaction = text({ type: "action", text: undefined, action: { type: "reaction", target: "GONE-0001", emoji: "👍" } });

    const unread = env();
    await worker.fetch(post([reaction]), unread.env);

    expect(unread.routed[0].body).toMatchObject({ reaction: { how: "Liked", words: "" } });
    expect(unread.routed[0].body.reaction).not.toHaveProperty("onOther");
  });

  it("reads every message in one delivery", async () => {
    const { env: e, routed } = env();
    await worker.fetch(post([text(), text({ id: "SECOND-0001", chat_id: "15555550111@s.whatsapp.net", from: "15555550111" })]), e);
    expect(routed.map(({ to }) => to)).toEqual([PHONE, "+15555550111"]);
  });
});

/**
 * Every event the channel is subscribed to (`.github/workflows/whapi-setup.yml`) that is not a new message: taken
 * with 200, described by its shape only, never queued. Sabotage: drop the `event` gate in `parseWhapiWebhook` and
 * the edit and the `messages.put` are queued; log `JSON.stringify(payload)` in `logEventShape` and the values leak;
 * answer bad JSON with 400 again and "a body that is not JSON" fails.
 */
describe("whapi events that are not new messages", () => {
  const VALUES = /5555550100|PsobWy36679|hello|secret words|example\.com|CHAN-1|1800000000/;
  const raw = (body: string) => new Request("https://agent.example/whapi", { method: "POST", headers: { [WHAPI_SECRET_HEADER]: SECRET }, body });
  const deliver = (type: string, method: string, body: Record<string, unknown>) =>
    raw(JSON.stringify({ ...body, event: { type, event: method }, channel_id: "CHAN-1" }));
  const edited = text({ text: { body: "hello, secret words, edited" } });
  const EVENTS: [string, string, Record<string, unknown>][] = [
    ["messages", "patch", { messages_updates: [{ id: edited.id, trigger: edited, before_update: text(), after_update: edited, changes: ["text"] }] }],
    ["messages", "delete", { messages_removed: [{ id: edited.id, chat_id: edited.chat_id, from: edited.from }] }],
    // `messages.put` carries a `messages` array like a new message does; it is still not one.
    ["messages", "put", { messages: [edited] }],
    ["statuses", "post", { statuses: [{ id: edited.id, status: "read", recipient_id: "15555550100", timestamp: 1_800_000_000 }] }],
    ["statuses", "put", { statuses: [{ id: edited.id, status: "read", viewer_id: "15555550100@s.whatsapp.net" }] }],
    ["groups", "post", { groups: [{ id: GROUP, name: "hello group", participants: [{ id: "15555550100", rank: "member" }] }] }],
    ["groups", "put", { groups_participants: [{ group_id: GROUP, participants: ["15555550100"], action: "add" }] }],
    ["groups", "patch", { groups_updates: [{ before_update: { id: GROUP, name: "hello" }, after_update: { id: GROUP, name: "secret words" }, changes: ["name"] }] }],
    ["calls", "post", { calls: [{ id: "CALL-1", chat_id: edited.chat_id, from: "15555550100", status: "offer" }] }],
    ["chats", "post", { chats: [{ id: edited.chat_id, name: "hello", last_message: edited }] }],
    ["chats", "delete", { chats_removed: [edited.chat_id] }],
    ["channel", "post", { health: { status: { code: 4, text: "AUTH" }, uptime: 1_800_000_000 } }],
    ["channel", "patch", { qr: { status: "OK", base64: "aGVsbG8=" } }],
    ["users", "post", { user: { id: "15555550100", name: "hello" } }],
    ["users", "delete", { user: { id: "15555550100" } }],
  ];

  for (const [type, method, body] of EVENTS) {
    it(`takes ${type}.${method} with 200, logs its shape without a value, and queues nothing`, async () => {
      const { env: e, routed } = env();
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
      expect((await worker.fetch(deliver(type, method, body), e)).status).toBe(200);
      // A groups event queues nothing, and marks the group's kept member list changed (`groupMembers.ts`).
      expect(routed).toEqual(type === "groups" ? [{ to: `sendblue-group:whapi:${GROUP}`, path: "/group-members-changed", body: {} }] : []);
      const shape = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "whapi_event_shape");
      expect(shape).toMatchObject({ outcome: "not_a_message", type, method });
      expect(shape.shape).toEqual(expect.arrayContaining([expect.stringMatching(/^event\.type:string$/)]));
      expect(lines.join("\n")).not.toMatch(VALUES);
    });
  }

  it("marks every group a groups event names, wherever Whapi puts its id, and none for one that names no group", async () => {
    const { env: e, routed } = env();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const OTHER = "120363099999999999@g.us";
    await worker.fetch(deliver("groups", "patch", { changes: [{ deep: { deeper: { chat: GROUP } } }, { group_id: OTHER }, { id: GROUP }] }), e);
    expect(routed.map((entry) => entry.to).sort()).toEqual([`sendblue-group:whapi:${GROUP}`, `sendblue-group:whapi:${OTHER}`].sort());
    routed.length = 0;
    await worker.fetch(deliver("groups", "patch", { changes: [{ id: "15555550100@s.whatsapp.net" }] }), e);
    expect(routed).toEqual([]);
    // A message delivery that names a group is never read as a change to its people.
    await worker.fetch(deliver("chats", "post", { chats: [{ id: GROUP }] }), e);
    expect(routed).toEqual([]);
  });

  it("never treats an edit with the same message id as a new message, after the original was queued", async () => {
    const { env: e, routed } = env();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.fetch(post([text()]), e);
    await worker.fetch(deliver("messages", "patch", { messages_updates: [{ id: text().id, after_update: edited }], messages: [edited] }), e);
    expect(routed).toHaveLength(1);
    expect(routed[0].body).toMatchObject({ text: "hello" });
  });

  it("writes a key that could be a value, such as a phone number, as *", async () => {
    const { env: e } = env();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    await worker.fetch(deliver("messages", "patch", { messages_updates: [{ votes: { "15555550100": ["x"] } }] }), e);
    expect(lines.join("\n")).toContain("messages_updates[].votes.*:array");
    expect(lines.join("\n")).not.toMatch(VALUES);
  });

  it("takes a body that is not JSON with 200, so Whapi does not retry it", async () => {
    const { env: e, routed } = env();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    expect((await worker.fetch(raw("hello 15555550100 {"), e)).status).toBe(200);
    expect(routed).toEqual([]);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: "whapi_event_shape", outcome: "not_json" }));
    expect(lines.join("\n")).not.toMatch(VALUES);
  });
});

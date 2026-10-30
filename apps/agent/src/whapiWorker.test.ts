import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { WHAPI_SECRET_HEADER } from "./whapi";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const GROUP = "120363012345678901@g.us";
const SECRET = "a-webhook-secret-long-enough";

function env(): { env: Env; routed: { to: string; body: Record<string, unknown> }[] } {
  const routed: { to: string; body: Record<string, unknown> }[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (_url: string, init?: RequestInit) => {
        routed.push({ to: id.name, body: JSON.parse(String(init?.body ?? "{}")) });
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

  it("counts a group 👍 only on a text Tex itself sent in that group", async () => {
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
      expect(other.routed).toEqual([]);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const RAW_KEY = new Uint8Array(32).map((_, i) => 200 - i);
const SECRET = `whsec_${btoa(String.fromCharCode(...RAW_KEY))}`;

async function signedRequest(body: string, opts: { id?: string; key?: Uint8Array; path?: string } = {}) {
  const id = opts.id ?? "evt_1";
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", opts.key ?? RAW_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return new Request(`https://agent.example${opts.path ?? "/linq"}`, {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
    },
    body,
  });
}

function env(): { env: Env; routedTo: string[] } {
  const routedTo: string[] = [];
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async () => {
        routedTo.push(id.name);
        return Response.json({ outcome: "queued" });
      },
    }),
  } as unknown as DurableObjectNamespace;
  return {
    routedTo,
    env: {
      SENDER_INBOX: namespace,
      LINQ_WEBHOOK_SECRET: SECRET,
      LINQ_API_KEY: "k",
      AGENT_WORKER_SECRET: "s",
      CONTROL_PLANE_ORIGIN: "https://cp.example",
      GATEWAY_ORIGIN: "https://gw.example",
    },
  };
}

const received = (from: string, isGroup = false) =>
  JSON.stringify({
    event_type: "message.received",
    event_id: "evt_1",
    data: {
      chat: { id: "chat_1", is_group: isGroup },
      id: "m1",
      sender_handle: { handle: from, service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "hello" }],
    },
  });

describe("worker", () => {
  it("logs each webhook's outcome and why one was dropped, never the number or the text", async () => {
    const { env: e } = env();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
    try {
      await worker.fetch(await signedRequest(received("+15555550100")), e);
      await worker.fetch(await signedRequest(received("+15555550100", true), { id: "evt_2" }), e);
      await worker.fetch(await signedRequest(received("someone@example.com"), { id: "evt_3" }), e);
    } finally {
      spy.mockRestore();
    }
    const events = lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === "linq_webhook");
    expect(events).toEqual([
      { event: "linq_webhook", outcome: "accepted" },
      { event: "linq_webhook", outcome: "ignored", reason: "group" },
      { event: "linq_webhook", outcome: "ignored", reason: "sender" },
    ]);
    expect(lines.join("\n")).not.toMatch(/5555550100|example\.com|hello/);
  });

  it("queues a signed direct message in the sender's own inbox", async () => {
    const { env: e, routedTo } = env();
    const response = await worker.fetch(await signedRequest(received("+15555550100")), e);
    expect(response.status).toBe(200);
    expect(routedTo).toEqual(["+15555550100"]);
  });

  it("refuses an unsigned or wrongly signed webhook before reading it", async () => {
    const { env: e, routedTo } = env();
    const forged = await signedRequest(received("+15555550100"), { key: new Uint8Array(32) });
    expect((await worker.fetch(forged, e)).status).toBe(401);
    const unsigned = new Request("https://agent.example/linq", { method: "POST", body: received("+15555550100") });
    expect((await worker.fetch(unsigned, e)).status).toBe(401);
    expect(routedTo).toEqual([]);
  });

  describe("sendblue webhook", () => {
    const SB_SECRET = "0123456789abcdef0123456789abcdef";
    const sbEnv = () => {
      const made = env();
      const urls: string[] = [];
      const queued: Record<string, unknown>[] = [];
      made.env.SENDBLUE_WEBHOOK_SECRET = SB_SECRET;
      made.env.SENDER_INBOX = {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          fetch: async (url: string, init?: RequestInit) => {
            made.routedTo.push(id.name);
            urls.push(url);
            queued.push(JSON.parse(String(init?.body)));
            return Response.json({ outcome: "queued" });
          },
        }),
      } as unknown as DurableObjectNamespace;
      return { ...made, urls, queued };
    };
    const inbound = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        content: "hello",
        is_outbound: false,
        message_handle: "mh_1",
        from_number: "+15555550100",
        sendblue_number: "+15555550199",
        media_url: "",
        message_type: "message",
        group_id: "",
        service: "iMessage",
        ...over,
      });
    const post = (body: string, secret?: string) =>
      new Request("https://agent.example/sendblue", {
        method: "POST",
        headers: secret === undefined ? {} : { "sb-signing-secret": secret },
        body,
      });

    it("queues an iMessage carrying our secret in the sender's inbox, with the Worker's own address", async () => {
      const { env: e, routedTo, urls } = sbEnv();
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect((await worker.fetch(post(inbound(), SB_SECRET), e)).status).toBe(200);
      expect(routedTo).toEqual(["+15555550100"]);
      expect(urls).toEqual(["https://inbox/accept?origin=https%3A%2F%2Fagent.example"]);
    });

    it("queues an inline reply with the words it answers, read from Sendblue, and never the handle", async () => {
      const { env: e, queued } = sbEnv();
      e.SENDBLUE_API_KEY_ID = "kid";
      e.SENDBLUE_API_SECRET = "ksecret";
      vi.spyOn(console, "log").mockImplementation(() => {});
      const asked: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        asked.push(url);
        return Response.json({
          status: "OK",
          data: { content: "Want me to book it?", number: "+15555550100", from_number: "+15555550199", is_outbound: true, group_id: "" },
        });
      });
      try {
        const body = inbound({ content: "yes", reply_to: { message_handle: "mh_0" } });
        expect((await worker.fetch(post(body, SB_SECRET), e)).status).toBe(200);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(asked).toEqual(["https://api.sendblue.com/api/v2/messages/mh_0"]);
      expect(queued[0]).toMatchObject({ text: "yes", quoted: "Want me to book it?", threaded: true });
      expect(queued[0]).not.toHaveProperty("replyTo");
    });

    it("an inline reply is queued as one even when its words can't be read", async () => {
      const { env: e, queued } = sbEnv();
      e.SENDBLUE_API_KEY_ID = "kid";
      e.SENDBLUE_API_SECRET = "ksecret";
      const logged: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
      vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
      try {
        expect((await worker.fetch(post(inbound({ content: "try again", reply_to: { message_handle: "mh_0" } }), SB_SECRET), e)).status).toBe(200);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(queued[0]).toMatchObject({ text: "try again", threaded: true });
      expect(queued[0]).not.toHaveProperty("quoted");
      expect(logged.some((line) => line.includes('"sendblue_reply_context"') && line.includes('"unread"'))).toBe(true);
    });

    it("refuses a wrong or missing secret, and everything when ours is not set", async () => {
      const { env: e, routedTo } = sbEnv();
      vi.spyOn(console, "log").mockImplementation(() => {});
      expect((await worker.fetch(post(inbound(), "wrong-secret-wrong-secret"), e)).status).toBe(401);
      expect((await worker.fetch(post(inbound()), e)).status).toBe(401);
      // A Linq signature does not open the Sendblue route.
      expect((await worker.fetch(await signedRequest(inbound(), { path: "/sendblue" }), e)).status).toBe(401);
      e.SENDBLUE_WEBHOOK_SECRET = undefined;
      expect((await worker.fetch(post(inbound(), ""), e)).status).toBe(401);
      expect(routedTo).toEqual([]);
    });

    it("answers 200 and drops an unknown service, logging why but never the number or text", async () => {
      const { env: e, routedTo } = sbEnv();
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
      expect((await worker.fetch(post(inbound({ service: "RCS" }), SB_SECRET), e)).status).toBe(200);
      expect((await worker.fetch(post(inbound({ group_id: "g", service: "RCS" }), SB_SECRET), e)).status).toBe(200);
      expect(routedTo).toEqual([]);
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { event: "sendblue_webhook", outcome: "ignored", reason: "service" },
        { event: "sendblue_webhook", outcome: "ignored", reason: "group_service" },
      ]);
      expect(lines.join("\n")).not.toMatch(/5555550100|hello/);
    });

    it("queues a group message in the group's own inbox, never the sender's", async () => {
      const { env: e, routedTo, urls } = sbEnv();
      vi.spyOn(console, "log").mockImplementation(() => {});
      const body = inbound({ group_id: "g-1", participants: ["+15555550100", "+15555550101"], content: "Tex, hi" });
      expect((await worker.fetch(post(body, SB_SECRET), e)).status).toBe(200);
      expect(routedTo).toEqual(["sendblue-group:g-1"]);
      expect(urls).toEqual(["https://inbox/group-accept"]);
    });
  });

  describe("hosted pictures", () => {
    const ID = "b".repeat(64);
    const TOKEN = "c".repeat(64);
    const mediaEnv = () => {
      const made = env();
      const asked: string[] = [];
      made.env.SENDER_INBOX = {
        idFromString: (hex: string) => {
          if (hex !== ID) throw new Error("not an id of this namespace");
          return { hex };
        },
        get: () => ({
          fetch: async (url: string) => {
            asked.push(url);
            return new Response("bytes", { headers: { "content-type": "image/png" } });
          },
        }),
      } as unknown as DurableObjectNamespace;
      return { env: made.env, asked };
    };

    it("asks the object named in the address for its picture", async () => {
      const { env: e, asked } = mediaEnv();
      const response = await worker.fetch(new Request(`https://agent.example/media/${ID}/${TOKEN}.png`), e);
      expect(response.status).toBe(200);
      expect(asked).toEqual([`https://inbox/media/${TOKEN}`]);
    });

    it("is a 404 for any address that is not one, without asking any object", async () => {
      const { env: e, asked } = mediaEnv();
      for (const path of [
        `/media/${"d".repeat(64)}/${TOKEN}.png`,
        `/media/${ID}/${TOKEN}`,
        `/media/${ID}/../routine-text`,
        `/media/${ID.toUpperCase()}/${TOKEN}.png`,
      ]) {
        expect((await worker.fetch(new Request(`https://agent.example${path}`), e)).status).toBe(404);
      }
      expect((await worker.fetch(new Request(`https://agent.example/media/${ID}/${TOKEN}.png`, { method: "POST" }), e)).status).toBe(405);
      expect(asked).toEqual([]);
    });
  });

  it("reports which settings are present, and never a secret's value", async () => {
    const { env: e } = env();
    e.LINQ_WEBHOOK_SECRET = "";
    const response = await worker.fetch(new Request("https://agent.example/health"), e);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      ok: true,
      webhook: false,
      replies: true,
      sendblueWebhook: false,
      sendblueReplies: false,
      workerSecret: true,
      controlPlane: true,
      gatewayOrigin: "https://gw.example",
      simulator: false,
    });
    expect(body).not.toContain("cp.example");
    expect((await worker.fetch(new Request("https://agent.example/health", { method: "POST" }), e)).status).toBe(404);
  });

  it("refuses everything when the deployment has no webhook secret", async () => {
    const { env: e, routedTo } = env();
    e.LINQ_WEBHOOK_SECRET = "";
    expect((await worker.fetch(await signedRequest(received("+15555550100")), e)).status).toBe(401);
    expect(routedTo).toEqual([]);
  });

  it("acknowledges signed events it does not act on, without queueing them", async () => {
    const { env: e, routedTo } = env();
    expect((await worker.fetch(await signedRequest(received("+15555550100", true)), e)).status).toBe(200);
    expect((await worker.fetch(await signedRequest(received("someone@example.com")), e)).status).toBe(200);
    expect(routedTo).toEqual([]);
  });

  it("answers 404 off the webhook path and 405 for other methods", async () => {
    const { env: e } = env();
    expect((await worker.fetch(new Request("https://agent.example/"), e)).status).toBe(404);
    expect((await worker.fetch(new Request("https://agent.example/linq"), e)).status).toBe(405);
  });

  it("refuses an oversized body", async () => {
    const { env: e } = env();
    const big = await signedRequest("x".repeat(300 * 1024));
    expect((await worker.fetch(big, e)).status).toBe(413);
  });

  describe("the routine cron", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    async function tick(e: Env) {
      const waiting: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waiting.push(p) } as unknown as ExecutionContext;
      await worker.scheduled({} as ScheduledController, e, ctx);
      await Promise.all(waiting);
    }

    it("asks nobody anything without a control plane", async () => {
      const { env: e } = env();
      e.CONTROL_PLANE_ORIGIN = "";
      const fetched = vi.fn();
      vi.stubGlobal("fetch", fetched);
      vi.spyOn(console, "log").mockImplementation(() => {});
      await tick(e);
      expect(fetched).not.toHaveBeenCalled();
    });

    it("texts each phone through that phone's own inbox", async () => {
      const inboxCalls: { name: string; url: string; body: unknown }[] = [];
      const reported: unknown[] = [];
      const { env: e } = env();
      e.SENDER_INBOX = {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          fetch: async (url: string, init: RequestInit) => {
            inboxCalls.push({ name: id.name, url, body: JSON.parse(String(init.body)) });
            return Response.json({ status: "texted" });
          },
        }),
      } as unknown as DurableObjectNamespace;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/routines/due") {
          return Response.json({
            runs: [{ runId: "r1", accessToken: "g", path: "routines/daily/a.md", timeZone: "UTC", send: "text", phones: ["+15555550100"] }],
          });
        }
        if (path === "/agent") return Response.json({ outcome: "answered", answer: "hi", send: "text" });
        // The same tick asks for dreams, check-ins and housekeeping too (`dreams.ts`, `heartbeats.ts`, `housekeeping.ts`); none are due here.
        if (path === "/agent-texts/dreams/due") return Response.json({ dreams: [] });
        if (path === "/agent-texts/heartbeats/due") return Response.json({ heartbeats: [] });
        if (path === "/agent-texts/housekeeping/due") return Response.json({ runs: [] });
        reported.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      });
      vi.spyOn(console, "log").mockImplementation(() => {});
      await tick(e);
      expect(inboxCalls).toEqual([
        { name: "+15555550100", url: "https://inbox/routine-text", body: { text: "hi", idempotencyKey: "routine:r1:+15555550100" } },
      ]);
      expect(reported).toEqual([{ runId: "r1", outcome: "answered", texted: 1 }]);
    });

    it("texts a check-in to the person's own phone through its inbox, with the text it continues", async () => {
      const inboxCalls: { name: string; url: string; body: unknown }[] = [];
      const reported: unknown[] = [];
      const { env: e } = env();
      e.SENDER_INBOX = {
        idFromName: (name: string) => ({ name }),
        get: (id: { name: string }) => ({
          fetch: async (url: string, init: RequestInit) => {
            inboxCalls.push({ name: id.name, url, body: JSON.parse(String(init.body)) });
            return Response.json({ status: "texted" });
          },
        }),
      } as unknown as DurableObjectNamespace;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/routines/due") return Response.json({ runs: [] });
        if (path === "/agent-texts/dreams/due") return Response.json({ dreams: [] });
        if (path === "/agent-texts/heartbeats/due") {
          return Response.json({
            heartbeats: [{ runId: "b1", accessToken: "g", timeZone: "UTC", since: null, phones: ["+15555550100"] }],
          });
        }
        if (path === "/agent-texts/housekeeping/due") return Response.json({ runs: [] });
        if (path === "/agent") return Response.json({ outcome: "speak", answer: "Found it.", continues: "can you find it?" });
        reported.push(JSON.parse(String(init.body)));
        return Response.json({ status: "recorded" });
      });
      vi.spyOn(console, "log").mockImplementation(() => {});
      await tick(e);
      expect(inboxCalls).toEqual([
        { name: "+15555550100", url: "https://inbox/routine-text", body: { text: "Found it.", idempotencyKey: "heartbeat:b1:+15555550100", continues: "can you find it?" } },
      ]);
      expect(reported).toEqual([{ runId: "b1", outcome: "texted" }]);
    });
  });
});

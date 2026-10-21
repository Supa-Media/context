import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";

const msg = (eventId: string, text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  text,
  ...extra,
});

/**
 * A gateway whose first turn waits until `release()`, so a text can arrive
 * while it runs, and which takes in whatever was steered into it.
 */
function world(opts: { takes?: boolean; steerStatus?: number } = {}) {
  const asks: { question: string; turn?: string }[] = [];
  const steers: { turn: string; id: string; text: string; token: string }[] = [];
  const sent: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing") || path.endsWith("/share_contact_card")) return new Response(null, { status: 204 });
    if (path.endsWith("/read")) return new Response("{}");
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "token" });
    if (path === "/agent/steer") {
      steers.push({ ...body, token: new Headers(init.headers).get("authorization") ?? "" });
      return Response.json({ queued: true }, { status: opts.steerStatus ?? 200 });
    }
    if (path === "/agent") {
      asks.push({ question: body.question, turn: body.turn });
      if (asks.length === 1) {
        started();
        await held;
      }
      const took = opts.takes === false ? [] : steers.filter((steer) => steer.turn === body.turn);
      return Response.json({
        answer: `answer to ${[body.question, ...took.map((steer) => steer.text)].join(" + ")}`,
        ...(took.length > 0 ? { steered: took.map((steer) => steer.id) } : {}),
      });
    }
    if (path.endsWith("/messages")) {
      sent.push(body.message.parts[0].value);
      return new Response("{}");
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  const deps: InboxDeps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => 1_000,
  };
  return { asks, steers, sent, deps, release, running };
}

const pendingKeys = (storage: MemoryStorage) => [...storage.data.keys()].filter((key) => key.startsWith("pending:"));

describe("steer", () => {
  it("a text sent while Tex works joins that turn and is not answered again", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await accept(storage, msg("e1", "book a table"), 1_000);
    const draining = drain(storage, w.deps);
    await w.running;
    expect(await accept(storage, msg("e2", "make it Friday"), 1_100)).toBe("queued");
    w.release();
    await draining;

    expect(w.steers).toEqual([{ turn: w.asks[0].turn, id: "e2", text: "make it Friday", token: "Bearer token" }]);
    expect(w.asks[0].turn).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(w.sent).toEqual(["answer to book a table + make it Friday"]);
    expect(pendingKeys(storage)).toEqual([]);
    await drain(storage, w.deps);
    expect(w.asks).toHaveLength(1);
  });

  it("a text the turn never took in is answered on its own", async () => {
    const storage = new MemoryStorage();
    const w = world({ takes: false });
    await accept(storage, msg("e1", "book a table"), 1_000);
    const draining = drain(storage, w.deps);
    await w.running;
    await accept(storage, msg("e2", "make it Friday"), 1_100);
    w.release();
    await draining;
    expect(w.steers).toHaveLength(1);
    await drain(storage, w.deps);
    expect(w.sent).toEqual(["answer to book a table", "answer to make it Friday"]);
    expect(w.asks[1].turn).not.toBe(w.asks[0].turn);
  });

  it("a reply, a tapback, a photo or a text behind another is never steered", async () => {
    for (const late of [
      msg("e2", "this one", { quoted: "their words" }),
      msg("e2", "Loved", { quoted: "their words", tapback: "love" as Message["tapback"] }),
      msg("e2", "", { attachments: [{ url: "https://cdn.example/a.jpg", mimeType: "image/jpeg" }] as Message["attachments"] }),
    ]) {
      const storage = new MemoryStorage();
      const w = world();
      await accept(storage, msg("e1", "book a table"), 1_000);
      const draining = drain(storage, w.deps);
      await w.running;
      await accept(storage, late, 1_100);
      w.release();
      await draining;
      expect(w.steers).toEqual([]);
    }
    // Two texts ahead that are not one burst: the second waits its turn, so the third does too.
    const storage = new MemoryStorage();
    const w = world();
    await accept(storage, msg("e1", "one"), 1_000);
    await accept(storage, msg("e2", "two", { quoted: "their words" }), 1_000);
    const draining = drain(storage, w.deps);
    await w.running;
    await accept(storage, msg("e3", "three"), 1_100);
    w.release();
    await draining;
    expect(w.steers).toEqual([]);
  });

  it("no turn running, no steer: a text arriving while idle is queued as before", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await accept(storage, msg("e1", "hi"), 1_000);
    expect(w.steers).toEqual([]);
    expect(pendingKeys(storage)).toHaveLength(1);
  });
});

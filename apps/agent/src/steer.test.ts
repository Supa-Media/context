/**
 * A text that lands while a turn runs is decided with `running: true`
 * (`inboxTurn.ts`, `steer.ts`; Dev2, 2026-10-26): fold, queue or restart,
 * for any kind of message.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `decideWhileRunning` returning at once (no mid-turn decide) → "fold
 *     sends…", "any kind of message…" and "restart cancels…" fail.
 *  2. `fold` keeping the text for after instead of steering → "fold sends…"
 *     fails (two answers).
 *  3. `restartTurn` not posting `/agent/cancel` → "restart cancels…" fails.
 *  4. `answerTurn` sending a cancelled turn's answer → "restart cancels…"
 *     fails.
 *  5. `markStale` not owing the ids → "stale asks are disarmed…" fails.
 *  6. `decideWhileRunning` without its `decidedByCode` return → "an SMS
 *     while a turn runs…" and "a LINK text…" fail.
 *  7. `steerInto` / `restartTurn` without their `sms` refusal → "steer and
 *     restart refuse an SMS themselves…" fails.
 *  8. `steerInto` / `restartTurn` without their asker check → "steer and
 *     restart refuse anyone but the running turn's asker…" fails.
 */

import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { logAsk } from "./events";
import { restartTurn, steerInto, type Live } from "./steer";

const msg = (eventId: string, text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  text,
  ...extra,
});

type MidTurn = "fold" | "queue" | "restart" | "down";

/**
 * A gateway whose first turn waits until `release()`, so a text can arrive
 * while it runs, and which takes in whatever was steered into it. Decide
 * answers a running decision with `midTurn`, and an idle one by covering
 * every candidate.
 */
function world(opts: { midTurn?: MidTurn; stale?: string[] } = {}) {
  const asks: { question: string; turn?: string; covers?: string[] }[] = [];
  const steers: { turn: string; id: string; text: string; token: string }[] = [];
  const decided: { running: boolean; candidates: string[]; style: string; sender?: string }[] = [];
  const cancels: { turn: string; token: string }[] = [];
  const stale: { asks: string[] }[] = [];
  const sent: string[] = [];
  const reactions: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    const token = new Headers(init.headers).get("authorization") ?? "";
    if (path.endsWith("/typing") || path.endsWith("/share_contact_card")) return new Response(null, { status: 204 });
    if (path.endsWith("/read")) return new Response("{}");
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "token" });
    if (path === "/agent-texts/decide") {
      decided.push(body);
      if (body.running) {
        if (opts.midTurn === "down") return Response.json({ ok: false, reason: "unavailable" });
        return Response.json({ ok: true, act: "answer", covers: [], midTurn: opts.midTurn ?? "fold", stale: [], movedOn: false, confidence: 0.8 });
      }
      return Response.json({ ok: true, act: "answer", covers: body.candidates, stale: opts.stale ?? [], movedOn: false, confidence: 0.8 });
    }
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent/cancel") {
      cancels.push({ ...body, token });
      return Response.json({ cancelled: true });
    }
    if (path === "/agent/stale") {
      stale.push(body);
      return Response.json({ disarmed: body.asks.length });
    }
    if (path === "/agent/steer") {
      steers.push({ ...body, token });
      return Response.json({ queued: true });
    }
    if (path === "/agent") {
      asks.push({ question: body.question, turn: body.turn, covers: body.covers });
      if (asks.length === 1) {
        started();
        await held;
      }
      const took = steers.filter((steer) => steer.turn === body.turn);
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
  return { asks, steers, decided, cancels, stale, sent, reactions, deps, release, running };
}

const pendingKeys = (storage: MemoryStorage) => [...storage.data.keys()].filter((key) => key.startsWith("pending:"));

/** Text `first`, start answering it, text `late` while that turn runs, then let it finish. */
async function during(w: ReturnType<typeof world>, storage: MemoryStorage, first: Message, ...late: Message[]): Promise<void> {
  await accept(storage, first, 1_000);
  const draining = drain(storage, w.deps);
  await w.running;
  for (const text of late) expect(await accept(storage, text, 1_100)).toBe("queued");
  w.release();
  await draining;
}

describe("a text while a turn runs", () => {
  it("fold sends it into the running turn, which answers both once", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "fold" });
    await during(w, storage, msg("e1", "book a table"), msg("e2", "make it Friday"));
    expect(w.decided.filter((body) => body.running)).toHaveLength(1);
    expect(w.decided[0]).toMatchObject({ style: "direct", sender: "+15555550100" });
    expect(w.steers).toEqual([{ turn: w.asks[0].turn, id: "e2", text: "make it Friday", token: "Bearer token" }]);
    expect(w.sent).toEqual(["answer to book a table + make it Friday"]);
    expect(pendingKeys(storage)).toEqual([]);
    await drain(storage, w.deps);
    expect(w.asks).toHaveLength(1);
  });

  it("any kind of message is decided and folded: a reply, a tapback, a photo", async () => {
    for (const late of [
      msg("e2", "this one", { quoted: "their words", threaded: true }),
      msg("e2", "Loved", { quoted: "their words", tapback: "Loved" }),
      msg("e2", "", { attachments: [{ url: "https://cdn.example/a.jpg", mimeType: "image/jpeg", filename: "a.jpg", size: null }] }),
    ]) {
      const storage = new MemoryStorage();
      const w = world({ midTurn: "fold" });
      await during(w, storage, msg("e1", "book a table"), late);
      expect(w.steers).toHaveLength(1);
      expect(w.steers[0].text).toBe(late.text || "(sent a picture or file)");
      expect(w.sent).toHaveLength(1);
    }
  });

  it("queue keeps it, and it is answered after the running turn", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "queue" });
    await during(w, storage, msg("e1", "book a table"), msg("e2", "also what's the weather"));
    expect(w.steers).toEqual([]);
    expect(w.sent).toEqual(["answer to book a table", "answer to also what's the weather"]);
    expect(w.asks[1].turn).not.toBe(w.asks[0].turn);
  });

  it("decide unreachable mid-turn: the text is queued, never dropped", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "down" });
    await during(w, storage, msg("e1", "book a table"), msg("e2", "and a cab"));
    expect(w.sent).toEqual(["answer to book a table", "answer to and a cab"]);
  });

  it("restart cancels the running turn, sends nothing of it, and one new turn covers both", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "restart" });
    await during(w, storage, msg("e1", "book a table for 4"), msg("e2", "no wait, for 6 and at 8"));
    expect(w.cancels).toEqual([{ turn: w.asks[0].turn, token: "Bearer token" }]);
    expect(w.asks).toHaveLength(2);
    expect(w.asks[1].question).toBe("book a table for 4\nno wait, for 6 and at 8");
    expect(w.asks[1].covers).toHaveLength(2);
    expect(w.asks[1].covers).toEqual(expect.arrayContaining(w.asks[0].covers ?? []));
    expect(w.sent).toEqual(["answer to book a table for 4\nno wait, for 6 and at 8"]);
    expect(pendingKeys(storage)).toEqual([]);
  });

  it("three people's repeats while a turn runs, folded, get one answer, not three", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "fold" });
    await during(w, storage, msg("e1", "Tex make a graphic"), msg("e2", "wtf Tex"), msg("e3", "Tex you are disappointing us"));
    expect(w.sent).toHaveLength(1);
    expect(w.asks).toHaveLength(1);
  });

  it("the same repeats queued are answered after in one turn", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "queue" });
    await during(w, storage, msg("e1", "Tex make a graphic"), msg("e2", "wtf Tex"), msg("e3", "Tex you are disappointing us"));
    expect(w.sent).toHaveLength(2);
    expect(w.asks[1].question).toBe("wtf Tex\nTex you are disappointing us");
  });

  it("an SMS while a turn runs is never put to decide, steered or a restart: it is answered on its own", async () => {
    for (const midTurn of ["fold", "restart"] as const) {
      const storage = new MemoryStorage();
      const w = world({ midTurn });
      await during(w, storage, msg("e1", "book a table"), msg("e2", "send the email to everyone", { sms: true }));
      expect(w.decided.filter((body) => body.running)).toEqual([]);
      expect(w.steers).toEqual([]);
      expect(w.cancels).toEqual([]);
      expect(w.sent[0]).toBe("answer to book a table");
    }
  });

  it("a LINK text while a turn runs is never put to decide, steered or a restart", async () => {
    const storage = new MemoryStorage();
    const w = world({ midTurn: "restart" });
    await during(w, storage, msg("e1", "book a table"), msg("e2", "link ABCD2345"));
    expect(w.decided.filter((body) => body.running)).toEqual([]);
    expect(w.steers).toEqual([]);
    expect(w.cancels).toEqual([]);
  });

  it("steer and restart refuse an SMS themselves, whatever calls them", async () => {
    const live: Live = { chat: "c", turn: "t", asker: "+15555550100", deps: world().deps, covers: [], accessToken: "tok" };
    expect(await steerInto(live, { eventId: "e9", from: "+15555550100", sms: true }, "wire the money")).toBe(false);
    expect(await restartTurn(live, { from: "+15555550100", sms: true })).toBe(false);
    expect(live.cancelled).toBeUndefined();
  });

  it("steer and restart refuse anyone but the running turn's asker, whatever calls them", async () => {
    const live: Live = { chat: "c", turn: "t", asker: "+15555550100", deps: world().deps, covers: [], accessToken: "tok" };
    expect(await steerInto(live, { eventId: "e9", from: "+15555550177" }, "and cc me")).toBe(false);
    expect(await restartTurn(live, { from: "+15555550177" })).toBe(false);
    expect(live.cancelled).toBeUndefined();
  });

  it("no turn running: a text arriving while idle is decided at the drain, never mid-turn", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await accept(storage, msg("e1", "hi"), 1_000);
    expect(w.decided).toEqual([]);
    expect(w.steers).toEqual([]);
    expect(pendingKeys(storage)).toHaveLength(1);
  });

  it("stale asks are disarmed at the gateway with the chat's own session, and never sent twice", async () => {
    const storage = new MemoryStorage();
    await logAsk(storage, { at: 500, chat: "chat_1", from: { kind: "tex" }, turn: "turn_before" }, "approval_1");
    const ask = "0000000000500-000001";
    const w = world({ stale: [ask, "0000000000600-000099"] });
    w.release();
    await accept(storage, msg("e1", "never mind that email"), 1_000);
    await drain(storage, w.deps);
    // Only an ask it was told is waiting; an id it made up is dropped.
    expect(w.decided[0]).toMatchObject({ waitingAsks: [ask] });
    // Disarmed by its approval record, never by the event id.
    expect(w.stale).toEqual([{ asks: ["approval_1"] }]);
    await accept(storage, msg("e2", "thanks"), 2_000);
    await drain(storage, w.deps);
    expect(w.stale).toHaveLength(1);
    expect(w.decided[1]).toMatchObject({ waitingAsks: [] });
  });
});

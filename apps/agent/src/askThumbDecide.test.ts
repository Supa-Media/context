/**
 * A like or love held as the yes to an ask is never put to decide
 * (`inboxTurn.ts` `decidedByCode`, `askYes`): it reaches the gateway intact,
 * as the tapback it is with the ask's words, and only the gateway's check
 * against what is armed (`thumbsUpIsYes`) says whether it is the yes.
 *
 * Found 2026-10-28 from the source, after a controlled test's 👍 on Tex's
 * email ask got no answer: the held 👍 was queued as a tapback, which
 * `pureAck` counts as asking nothing, so decide's "silent" or "react" dropped
 * it, an answer whose `covers` left it out dropped it, and a mid-turn decide
 * could fold it into a running turn as words. The existing thumbs tests
 * never stubbed decide, so its fallback answered everything.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `decidedByCode` without `askYes` → every test in "held as the yes"
 *     and "while a turn runs" fails.
 *  2. `react` not setting `askYes` → "held as the yes" fails (decide is
 *     asked, and silent drops it).
 *  3. `askYes` set on every tapback in `react` → "an ordinary tapback is
 *     still decide's" fails.
 */

import { describe, expect, it } from "vitest";
import { accept, drain, react, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000;
const ASK = "Here's the email I'd send:\n\nTo: jo@example.com\nSubject: Thursday\n\nThursday works.\n\nGive it a 👍 and I'll send it.";

type Decision = "silent" | "react" | "omit";

const msg = (eventId: string, text: string, extra: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  text,
  ...extra,
});

const tapback = (eventId: string, how: "Liked" | "Loved" | "Disliked", words: string, removed = false) => ({
  kind: "reaction" as const,
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  reaction: { how, words, ...(removed ? { removed: true as const } : {}) },
});

/**
 * A gateway and a decide that would drop a tapback every way it could: idle,
 * `silent`, `react`, or an answer whose `covers` leaves it out; running,
 * `fold`. With `holdFirst`, the first turn waits until `release()`.
 */
function world(decision: Decision, opts: { holdFirst?: boolean } = {}) {
  const agent: Record<string, unknown>[] = [];
  const decided: { running: boolean; candidates: string[] }[] = [];
  const steers: unknown[] = [];
  const stale: unknown[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "token" });
    if (path === "/agent-texts/decide") {
      decided.push(body);
      if (body.running) return Response.json({ ok: true, act: "answer", covers: [], midTurn: "fold", stale: [], movedOn: false, confidence: 0.9 });
      const act = decision === "omit" ? "answer" : decision;
      // "omit": an answer that covers only the words, never the tapback.
      const covers = decision === "omit" ? body.candidates.slice(0, 1) : [];
      return Response.json({ ok: true, act, covers, stale: body.waitingAsks ?? [], movedOn: false, confidence: 0.9 });
    }
    if (path === "/agent/events") return Response.json({ written: (body.events ?? []).map((event: { id: string }) => event.id) });
    if (path === "/agent/steer") return (steers.push(body), Response.json({ queued: true }));
    if (path === "/agent/stale") return (stale.push(body), Response.json({ disarmed: body.asks.length }));
    if (path === "/agent") {
      agent.push(body);
      if (opts.holdFirst && agent.length === 1) {
        started();
        await held;
      }
      return Response.json({ answer: body.tapback ? "Sent." : `answer to ${body.question}` });
    }
    return Response.json({ id: "x", status: "OK", sent: true });
  }) as unknown as Fetch;
  const deps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => NOW,
  } as InboxDeps;
  return { deps, agent, decided, steers, stale, release, running };
}

const tapbacksAsked = (w: ReturnType<typeof world>) => w.agent.filter((body) => body.tapback !== undefined);

describe("a like held as the yes to an ask", () => {
  for (const decision of ["silent", "react", "omit"] as const) {
    it(`reaches the gateway intact, never decided, when decide would say ${decision}`, async () => {
      const storage = new MemoryStorage();
      const w = world(decision);
      expect(await react(storage, tapback("t1", "Liked", ASK), NOW)).toBe("held");
      await drain(storage, w.deps);
      expect(w.decided).toEqual([]);
      expect(w.stale).toEqual([]);
      expect(tapbacksAsked(w)).toEqual([expect.objectContaining({ question: "👍", quoted: ASK, tapback: "Liked" })]);
    });
  }

  it("a love does too, and so does one beside other words, each answered apart", async () => {
    const storage = new MemoryStorage();
    const w = world("omit");
    await accept(storage, msg("e1", "also what time is it"), NOW);
    expect(await react(storage, tapback("t1", "Loved", ASK), NOW)).toBe("held");
    await drain(storage, w.deps);
    // The words were decided; the love never was, and was never joined to them.
    expect(w.decided.every((body) => body.candidates.length === 1)).toBe(true);
    expect(tapbacksAsked(w)).toEqual([expect.objectContaining({ question: "❤️", quoted: ASK, tapback: "Loved" })]);
    expect(w.agent.some((body) => body.question === "also what time is it" && body.tapback === undefined)).toBe(true);
  });
});

describe("while a turn runs", () => {
  it("a held yes is never folded into the running turn: it is answered on its own after", async () => {
    const storage = new MemoryStorage();
    const w = world("silent", { holdFirst: true });
    await accept(storage, msg("e1", "book a table"), NOW);
    const draining = drain(storage, w.deps);
    await w.running;
    const yes = msg("t1", "👍", { quoted: ASK, tapback: "Liked", askYes: true });
    expect(await accept(storage, yes, NOW + 100)).toBe("queued");
    w.release();
    await draining;
    expect(w.decided.filter((body) => body.running)).toEqual([]);
    expect(w.steers).toEqual([]);
    expect(tapbacksAsked(w)).toEqual([expect.objectContaining({ question: "👍", quoted: ASK, tapback: "Liked" })]);
  });
});

describe("an ordinary tapback is still decide's", () => {
  it("a like on other words, a dislike or a take-back is never marked the yes", async () => {
    for (const reaction of [
      tapback("t1", "Liked", "Dinner is booked for 7. Want me to add it to your calendar?"),
      tapback("t2", "Disliked", ASK),
      tapback("t3", "Liked", ASK, true),
    ]) {
      const storage = new MemoryStorage();
      const w = world("silent");
      await react(storage, reaction, NOW);
      await drain(storage, w.deps);
      // Decide's silent leaves it unanswered, as before.
      expect(tapbacksAsked(w)).toEqual([]);
      for (const [, value] of storage.data) expect(JSON.stringify(value)).not.toContain("askYes");
    }
  });
});

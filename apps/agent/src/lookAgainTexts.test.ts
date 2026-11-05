/**
 * A 1:1 REPLY GETS THE SAME LAST LOOK A GROUP'S DOES (`lookAgain.ts`, Dev2's
 * one-door plan, 2026-11-05: "make them the same as much as possible so that
 * people have the same experience").
 *
 * A text that lands while Tex works and is queued, not folded in (`steer.ts`),
 * used to leave the reply to the older ask going out as written. Now the
 * control plane is asked whether the draft still answers them; held, nothing
 * is sent and one turn answers both.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `answerTurn` without `lookAgainTexts` → "a draft overtaken ..." fails (the old reply is sent).
 *  2. `mark` without `rechecked` → "looked at once" fails (asked again, held forever).
 *  3. `byCode` ignoring tapbacks → "a tapback after it" fails (a 👍 is rechecked).
 */

import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000;
const PHONE = "+15555550100";

const msg = (eventId: string, text: string, extra: Partial<Message> = {}): Message => ({ kind: "message", eventId, chatId: "chat_1", from: PHONE, messageId: `m_${eventId}`, text, ...extra });

/** A gateway whose first turn waits for `release()`, a decide that queues mid-turn texts, and a recheck answering `fits`. */
function world(fits: boolean | "down", holdTurns = 1) {
  const agent: Record<string, unknown>[] = [];
  const rechecks: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const gates = Array.from({ length: holdTurns }, () => {
    let release = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const running = new Promise<void>((resolve) => (started = resolve));
    return { release: () => release(), started: () => started(), held, running };
  });
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "token" });
    if (path === "/agent-texts/decide") return Response.json({ ok: true, act: "answer", covers: body.candidates, ...(body.running ? { midTurn: "queue" } : {}), stale: [], movedOn: false, confidence: 0.9 });
    if (path === "/agent-texts/recheck") {
      rechecks.push(body);
      return fits === "down" ? new Response("no", { status: 500 }) : Response.json({ ok: true, fits, confidence: fits ? 0.9 : 0.1 });
    }
    if (path === "/agent/events") return Response.json({ written: (body.events ?? []).map((event: { id: string }) => event.id) });
    if (path === "/agent/steer") return Response.json({ queued: true });
    if (path === "/agent") {
      agent.push(body);
      const gate = gates[agent.length - 1];
      if (gate !== undefined) {
        gate.started();
        await gate.held;
      }
      return Response.json({ answer: `answer to ${body.question}` });
    }
    for (const part of body.message?.parts ?? []) if (part.type === "text") sent.push(part.value);
    return Response.json({ id: "x", status: "OK", sent: true });
  }) as unknown as Fetch;
  const deps = { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", now: () => NOW } as InboxDeps;
  return { deps, agent, rechecks, sent, release: () => gates[0].release(), running: gates[0].running, gates };
}

/** "save the playbook" starts a turn; `second` lands while it runs and is queued. */
async function overtaken(fits: boolean | "down", second: Message = msg("e2", "actually why is the build red?")) {
  const storage = new MemoryStorage();
  const w = world(fits);
  await accept(storage, msg("e1", "save the playbook"), NOW);
  const draining = drain(storage, w.deps);
  await w.running;
  expect(await accept(storage, second, NOW + 100)).toBe("queued");
  w.release();
  await draining;
  await drain(storage, w.deps);
  return { storage, w };
}

const answered = (w: ReturnType<typeof world>) => w.agent.map((body) => body.question);

describe("a 1:1 reply's last look", () => {
  it("a draft overtaken by their newer text is held, and one turn answers both", async () => {
    const { w } = await overtaken(false);
    expect(w.rechecks).toHaveLength(1);
    expect(w.rechecks[0]).toMatchObject({ style: "direct", sender: PHONE, chat: "chat_1", draft: "answer to save the playbook" });
    expect(w.rechecks[0].line).toBeUndefined();
    expect(w.sent).not.toContain("answer to save the playbook");
    // The next turn answers the old ask and the newer words together, and is never held again.
    expect(answered(w).at(-1)).toContain("save the playbook");
    expect(answered(w).at(-1)).toContain("why is the build red");
    expect(w.sent.some((text) => text.includes("why is the build red"))).toBe(true);
  });

  it("looked at once: the turn that answers both is sent even when they keep typing and the recheck would hold it", async () => {
    const storage = new MemoryStorage();
    const w = world(false, 2);
    await accept(storage, msg("e1", "save the playbook"), NOW);
    const draining = drain(storage, w.deps);
    await w.gates[0].running;
    await accept(storage, msg("e2", "actually why is the build red?"), NOW + 100);
    w.gates[0].release();
    await w.gates[1].running; // the turn answering both
    await accept(storage, msg("e3", "and the tests too"), NOW + 200);
    w.gates[1].release();
    await draining;
    await drain(storage, w.deps);
    // The first draft was held once; the turn answering e1 and e2 went out though e3 came after it.
    expect(w.rechecks).toHaveLength(1);
    expect(w.sent.some((text) => text.includes("save the playbook") && text.includes("why is the build red"))).toBe(true);
  });

  it("a draft that still fits is sent as written", async () => {
    const { w } = await overtaken(true);
    expect(w.rechecks).toHaveLength(1);
    expect(w.sent.some((text) => text.includes("answer to save the playbook"))).toBe(true);
  });

  it("a recheck that can't answer sends the draft, as before", async () => {
    const { w } = await overtaken("down");
    expect(w.sent.some((text) => text.includes("answer to save the playbook"))).toBe(true);
  });

  it("a tapback after it never holds the reply", async () => {
    const { w } = await overtaken(false, msg("e2", "Liked “hi”", { tapback: "Liked", quoted: "hi" }));
    expect(w.rechecks).toEqual([]);
    expect(w.sent.some((text) => text.includes("answer to save the playbook"))).toBe(true);
  });
});

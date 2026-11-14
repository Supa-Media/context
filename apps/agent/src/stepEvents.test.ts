/**
 * The Worker's own steps reach the chat's ledger (Dev2, 2026-11-13: "every
 * step should log its input output time and stuff, we need to be able to
 * replay everything and track bugs and regressions"): a person's own chat's
 * judging and every tapback are `step` events in the outbox, posted with the
 * chat's other events, and never a line any reader of the chat shows.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-13).
 *
 *  1. `ask` in `inboxTurn.ts` not calling `logStep` -> "the judge's verdict
 *     and its tapback are kept" and "a judge that is down is kept as a failed
 *     step" fail.
 *  2. `chatLine` in `events.ts` keeping steps -> "never a line of the chat"
 *     fails (the next judge's transcript holds the step).
 *  3. `tapback` logging before the send, as went -> "a tapback that will not
 *     send is kept as failed" fails.
 *  4. `flushOutbox` putting steps in the chat's own calls -> "a gateway that
 *     refuses steps still takes the chat's texts" fails.
 */

import { describe, expect, it } from "vitest";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { addEvent, flushEvents, keptEvents, recentEvents, unwritten, type TexEvent } from "./events";
import { sendblueChatId } from "./sendblue";
import { logStep, tapback } from "./stepEvents";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const CHAT = sendblueChatId(LINE, PHONE);

const msg = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: CHAT, from: PHONE, messageId: `m_${eventId}`, text });

type Decided = { candidates: string[]; transcript: string };

function world(decision: (body: Decided) => unknown, decideStatus = 200) {
  const decided: Decided[] = [];
  const posted: TexEvent[] = [];
  const reactions: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "tok" });
    if (path === "/agent-texts/decide") return decided.push(body), decideStatus === 200 ? Response.json(decision(body)) : new Response("{}", { status: decideStatus });
    if (path === "/agent/events") return posted.push(...body.events), Response.json({ written: body.events.map((event: TexEvent) => event.id) });
    if (path === "/agent") return Response.json({ answer: `answer to ${body.question}` });
    if (path === "/api/send-reaction") return reactions.push(body.reaction), Response.json({ status: "OK", sent: true });
    if (path === "/api/send-message") return Response.json({ status: "QUEUED", message_handle: "h_1", sent: true });
    return new Response("{}", { status: 200 });
  }) as unknown as Fetch;
  const deps: InboxDeps = { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "k", sendblue: { keyId: "id", secret: "key" }, now: () => 5_000 };
  return { deps, decided, posted, reactions };
}

const steps = (events: readonly TexEvent[]) => events.filter((event) => event.kind === "step");

describe("the Worker's own steps", () => {
  it("one text that code sends straight to Tex is a Triage step of its own: what it looked at, where it went, and why", async () => {
    // Dev2, 2026-11-14: "I told you everything needs a node but I dont see a code node that sends it to tex?". Sabotage:
    // drop `triage` on the front-door return in `chooseTurn` and no step is kept.
    const storage = new MemoryStorage();
    const w = world(() => ({ ok: true, act: "answer", covers: [], stale: [], movedOn: false, confidence: 0.9 }));
    await accept(storage, msg("e1", "whats on the cal tomorrow"), 1_000);
    await drain(storage, w.deps);
    expect(w.decided).toEqual([]);
    const [triaged, ...rest] = steps([...w.posted, ...(await unwritten(storage))]);
    // Decide never ran, so it logged nothing: only what ran is kept.
    expect(rest).toEqual([]);
    expect(triaged.step).toMatchObject({ name: "triage", of: "tex", ok: true, ms: 0, output: { to: "tex" } });
    expect(triaged.step?.input?.texts).toHaveLength(1);
    expect(String(triaged.step?.output?.why)).toContain("straight to Tex");
    // Ids and reasons only: never the text's words.
    expect(JSON.stringify(triaged)).not.toContain("cal tomorrow");
  });

  it("the judge's verdict and its tapback are kept, with what each was given and gave", async () => {
    const storage = new MemoryStorage();
    const w = world(() => ({ ok: true, act: "react", covers: [], stale: [], movedOn: false, confidence: 0.8, emoji: "🙏", why: "pure_ack" }));
    await accept(storage, msg("e1", "thanks"), 1_000);
    await drain(storage, w.deps);
    expect(w.reactions).toEqual(["🙏"]);
    const all = steps(await unwritten(storage));
    expect(all.map((event) => [event.step?.name, event.step?.of, event.step?.ok])).toEqual([["triage", "judge", true], ["decide", "waiting", true], ["react", "decide", true]]);
    expect(String(all[0].step?.output?.why)).toContain("thanks");
    const kept = all.slice(1);
    const [judged, tapped] = kept;
    expect(judged.from).toEqual({ kind: "system" });
    expect(judged.text).toBeUndefined();
    expect(judged.step?.input).toMatchObject({ style: "direct", running: false, candidates: w.decided[0].candidates, newest: w.decided[0].candidates[0], waitingAsks: 0 });
    expect(judged.step?.input?.transcriptChars).toBe(w.decided[0].transcript.length);
    expect(judged.step?.output).toMatchObject({ act: "react", emoji: "🙏", why: "pure_ack", confidence: 0.8 });
    expect(Number.isFinite(judged.step?.ms)).toBe(true);
    expect(tapped.step?.input).toEqual({ by: "decide", asked: "🙏" });
    expect(tapped.step?.output).toEqual({ emoji: "🙏" });
    // Ids, codes and emoji only: never the person's words.
    expect(JSON.stringify(kept)).not.toContain("thanks");
    // Still waiting to be posted, and in no reader's view of the chat: the next judging reads the text alone.
    const shown = await keptEvents(storage, CHAT);
    expect(shown.map((event) => event.kind)).toEqual(["text"]);
    expect(steps(await recentEvents(storage, CHAT))).toEqual([]);
    await accept(storage, msg("e2", "ok"), 2_000);
    await drain(storage, w.deps);
    expect(w.decided[1].transcript).not.toMatch(/step|decide|🙏/);
  });

  it("a judge that is down is kept as a failed step, and the texts are still answered", async () => {
    const storage = new MemoryStorage();
    const w = world(() => ({}), 503);
    await accept(storage, msg("e1", "what's on today"), 1_000);
    await accept(storage, msg("e2", "and tomorrow"), 1_500);
    await drain(storage, w.deps);
    const judged = w.posted.find((event) => event.kind === "step" && event.step?.name === "decide");
    expect(judged?.step).toMatchObject({ name: "decide", ok: false, cause: "http_503", output: { reason: "unavailable" } });
  });

  it("is posted to the ledger with the chat's events, and is never a line of the chat", async () => {
    const storage = new MemoryStorage();
    const w = world((body) => ({ ok: true, act: "answer", covers: body.candidates, stale: [], movedOn: false, confidence: 0.9 }));
    await accept(storage, msg("e1", "what's on today"), 1_000);
    await accept(storage, msg("e2", "and tomorrow"), 1_500);
    await drain(storage, w.deps);
    expect(steps(w.posted).map((event) => event.step?.name)).toEqual(["triage", "decide"]);
    expect(steps(w.posted)[0].chat).toBe(CHAT);
    // The next judging reads the chat: the step is in no reader's view of it.
    await accept(storage, msg("e3", "thanks"), 2_000);
    await accept(storage, msg("e4", "ok"), 2_500);
    await drain(storage, w.deps);
    expect(w.decided).toHaveLength(2);
    expect(w.decided[1].transcript).not.toMatch(/step|decide|triage/);
    expect(steps(await keptEvents(storage, CHAT))).toEqual([]);
    expect(steps(await recentEvents(storage, CHAT))).toEqual([]);
  });

  it("a tapback that will not send is kept as failed, and the failure still reaches its caller", async () => {
    const storage = new MemoryStorage();
    const send = async () => {
      throw new TypeError("line down");
    };
    await expect(tapback(storage, { chat: CHAT, now: () => 9_000, by: "classifier", asked: "not-one-of-the-64", turn: "turn-0000-0001" }, "see you at 5", send)).rejects.toThrow("line down");
    const [kept] = steps(await unwritten(storage));
    expect(kept.turn).toBe("turn-0000-0001");
    expect(kept.step).toMatchObject({ name: "react", of: "classifier", ok: false, cause: "TypeError", input: { by: "classifier", asked: "not-one-of-the-64" } });
    // An emoji not on the list is never sent: the one picked from the words is, and that is what is kept.
    expect(kept.step?.output?.emoji).not.toBe("not-one-of-the-64");
  });

  it("a gateway that refuses steps (an older one, mid-deploy) still takes the chat's texts", async () => {
    const storage = new MemoryStorage();
    await addEvent(storage, { at: 4_000, chat: CHAT, from: { kind: "person" }, kind: "text", text: "see you then" });
    await logStep(storage, CHAT, { name: "react", ok: true, output: { emoji: "👍" } }, 4_100);
    const taken: TexEvent[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const { events } = JSON.parse(String(init?.body)) as { events: TexEvent[] };
      const refused = events.findIndex((event) => event.kind === "step");
      if (refused >= 0) return Response.json({ error: "invalid_request", error_description: `events[${refused}].kind` }, { status: 400 });
      return taken.push(...events), Response.json({ written: events.map((event) => event.id) });
    }) as unknown as Fetch;
    await flushEvents(storage, { fetch: fetcher, gatewayOrigin: "https://gw.example", now: () => 5_000 }, "tok", "texts");
    expect(taken.map((event) => event.text)).toEqual(["see you then"]);
    expect(await unwritten(storage)).toEqual([]);
  });

  it("an input or output too big for the gateway is kept as its size, and a turn id it would refuse is left off", async () => {
    const storage = new MemoryStorage();
    await logStep(storage, CHAT, { name: "decide", ok: true, input: { candidates: Array.from({ length: 400 }, (_, i) => `id-${i}`) } }, 4_000, "bad turn id!");
    const [kept] = await unwritten(storage);
    expect(kept.step?.input).toEqual({ cut: expect.any(Number) });
    expect(kept.turn).toBeUndefined();
  });
});

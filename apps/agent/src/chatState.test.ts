/**
 * The chat's conversation state (`chatState.ts`, Jhonatan 2026-11-01): every
 * (phase, event) pair, and the guards that keep a model from looping.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `canWait` without the waits cap: "at most MAX_CHAT_WAITS waits" fails;
 *  - `step` "redraft" without `canRedraft`: "at most MAX_REDRAFTS redrafts" fails.
 */
import { describe, expect, it } from "vitest";
import { BURST_DEADLINE_MS, chatEvent, MAX_CHAT_WAITS, MAX_REDRAFTS, readChatState, step, stillGathering, type ChatEvent, type ChatPhase, type ChatState } from "./chatState";
import { MemoryStorage } from "./memoryStorage.testing";

const PHASES: ChatPhase[] = ["idle", "gathering", "drafting", "sending"];
const EVENTS: ChatEvent[] = ["message", "wait", "start", "silent", "redraft", "send", "cancelled", "done", "failed"];
/** The expected next phase for each pair; `null`: refused. */
const EXPECTED: Record<ChatPhase, Record<ChatEvent, ChatPhase | null>> = {
  idle: { message: "idle", wait: "gathering", start: "drafting", silent: "idle", redraft: null, send: null, cancelled: null, done: null, failed: null },
  gathering: { message: "gathering", wait: "gathering", start: "drafting", silent: "idle", redraft: null, send: null, cancelled: null, done: null, failed: null },
  drafting: { message: "drafting", wait: null, start: null, silent: null, redraft: "drafting", send: "sending", cancelled: "idle", done: "idle", failed: "idle" },
  sending: { message: "sending", wait: null, start: null, silent: null, redraft: "drafting", send: "sending", cancelled: "idle", done: "idle", failed: "idle" },
};

const at = (phase: ChatPhase, more: Partial<ChatState> = {}): ChatState => ({ phase, version: 3, waits: 0, redrafts: 0, burstAt: 1_000, ...more });

describe("every phase and event", () => {
  for (const phase of PHASES) {
    for (const event of EVENTS) {
      it(`${event} in ${phase}`, () => {
        const next = step(at(phase), event, { now: 2_000, seconds: 2 });
        const want = EXPECTED[phase][event];
        if (want === null) expect(next.ok, `${event} in ${phase} is refused`).toBe(false);
        else {
          expect(next.ok).toBe(true);
          if (next.ok) expect(next.state.phase).toBe(want);
        }
      });
    }
  }
});

describe("the guards", () => {
  it("a message bumps the version, and only a queued one starts the burst's clock", () => {
    const quiet = step({ phase: "idle", version: 0, waits: 0, redrafts: 0 }, "message", { now: 5 });
    expect(quiet.ok && quiet.state).toMatchObject({ version: 1 });
    expect(quiet.ok && quiet.state.burstAt).toBeUndefined();
    const queued = step({ phase: "idle", version: 0, waits: 0, redrafts: 0 }, "message", { now: 5, burst: true });
    expect(queued.ok && queued.state.burstAt).toBe(5);
  });

  it("at most MAX_CHAT_WAITS waits per burst", () => {
    let state = at("idle");
    for (let i = 0; i < MAX_CHAT_WAITS; i += 1) {
      const next = step(state, "wait", { now: 1_000 + i, seconds: 1 });
      expect(next.ok).toBe(true);
      if (next.ok) state = next.state;
    }
    expect(step(state, "wait", { now: 1_500, seconds: 1 })).toEqual({ ok: false, reason: "wait_cap" });
  });

  it("a wait never runs past the burst's deadline, and none starts after it", () => {
    const next = step(at("idle"), "wait", { now: 7_000, seconds: 8 });
    expect(next.ok && next.state.until).toBe(1_000 + BURST_DEADLINE_MS);
    expect(step(at("idle"), "wait", { now: 1_000 + BURST_DEADLINE_MS, seconds: 2 })).toEqual({ ok: false, reason: "deadline" });
  });

  it("decide's seconds are clamped to 0 to 8", () => {
    const next = step(at("idle", { burstAt: 2_000 }), "wait", { now: 2_000, seconds: 40 });
    expect(next.ok && next.state.until).toBe(2_000 + 8_000);
    expect(step(at("idle"), "wait", { now: 2_000, seconds: -3 }).ok).toBe(false);
  });

  it("a wait holds until its end, and a new message ends it at once", () => {
    const held = step(at("idle"), "wait", { now: 2_000, seconds: 3 });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    expect(stillGathering(held.state, 4_000)).toBe(true);
    expect(stillGathering(held.state, 5_000)).toBe(false);
    const moved = step(held.state, "message", { now: 3_000, burst: true });
    expect(moved.ok && stillGathering(moved.state, 3_500)).toBe(false);
  });

  it("at most MAX_REDRAFTS redrafts per burst, kept across a restart's cancelled turn", () => {
    let state = at("drafting");
    for (let i = 0; i < MAX_REDRAFTS; i += 1) {
      const redraft = step(state, "redraft", { now: 2_000 });
      expect(redraft.ok).toBe(true);
      if (!redraft.ok) return;
      // A restart cancels the turn and the next one starts: the count goes on.
      const cancelled = step(redraft.state, "cancelled", { now: 2_000 });
      const started = cancelled.ok ? step(cancelled.state, "start", { now: 2_000 }) : cancelled;
      expect(started.ok).toBe(true);
      if (started.ok) state = started.state;
    }
    expect(step(state, "redraft", { now: 2_000 })).toEqual({ ok: false, reason: "redraft_cap" });
  });

  it("done, failed or silent end the burst: waits, redrafts and its clock start over", () => {
    for (const event of ["done", "failed"] as const) {
      const next = step(at("drafting", { waits: 2, redrafts: 3 }), event, { now: 9_000 });
      expect(next.ok && next.state).toEqual({ phase: "idle", version: 3, waits: 0, redrafts: 0 });
    }
    const silent = step(at("gathering", { waits: 1 }), "silent", { now: 9_000 });
    expect(silent.ok && silent.state).toEqual({ phase: "idle", version: 3, waits: 0, redrafts: 0 });
  });
});

describe("persisted", () => {
  it("survives the object restarting: the state is read back from storage, and a refused event changes nothing", async () => {
    const storage = new MemoryStorage();
    await chatEvent(storage, "message", "queued", { now: 1_000, burst: true });
    await chatEvent(storage, "start", "turn", { now: 1_100 });
    // A new object over the same storage (an eviction mid-turn) reads where it was.
    expect(await readChatState(storage)).toMatchObject({ phase: "drafting", burstAt: 1_000, version: 1 });
    expect((await chatEvent(storage, "wait", "decide", { now: 1_200, seconds: 2 })).ok).toBe(false);
    expect(await readChatState(storage)).toMatchObject({ phase: "drafting" });
  });
});

/**
 * A sweep that fails says why, and stops early instead of spending the day.
 *
 * Dev2's sort showed "The last sort didn't finish" with nothing else to go on,
 * and the live score against the real model was 100% the same hour, so the
 * failure was on the way to the model, not in it. `askEach` is the loop the
 * sweep runs; these pin what it reports for each way a sweep can come back
 * empty, and that a dead service stops the sweep after a handful of tries
 * rather than burning the workspace's daily cap (failed calls count toward it).
 */

import { describe, expect, test } from "vitest";
import { DEAD_AFTER, askEach } from "../functions/lib/organizer/ask";

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ request: { state: `note ${i}`, questions: {} } }));

function session(answer: (i: number) => Record<string, unknown> | null, remaining = 250) {
  let sent = 0;
  let left = remaining;
  return {
    get sent() {
      return sent;
    },
    jev: {
      get remaining() {
        return left;
      },
      async decide() {
        if (left <= 0) return null;
        left -= 1;
        return answer(sent++);
      },
    },
  };
}

describe("askEach", () => {
  test("answers every item and reports no reason", async () => {
    const s = session(() => ({ ok: true }));
    const seen: number[] = [];
    const out = await askEach(s.jev, null, items(12), { concurrency: 4, onAnswer: (_item, _answers) => void seen.push(1) });
    expect(out).toEqual({ read: 12, answered: 12, why: null });
    expect(seen).toHaveLength(12);
  });

  test("no session says what refused it", async () => {
    for (const refusal of ["daily_cap", "switched_off", "not_premium", "disabled", "unconfigured"] as const) {
      const out = await askEach(null, refusal, items(5), { concurrency: 4, onAnswer: () => {} });
      expect(out).toEqual({ read: 0, answered: 0, why: refusal });
    }
  });

  test("nothing to ask is not a failure, refused or not", async () => {
    expect(await askEach(null, "daily_cap", [], { concurrency: 4, onAnswer: () => {} })).toEqual({ read: 0, answered: 0, why: null });
  });

  test("a service that answers nothing stops after a handful and says so", async () => {
    const s = session(() => null);
    const out = await askEach(s.jev, null, items(100), { concurrency: 4, onAnswer: () => {} });
    expect(out.why).toBe("no_answers");
    expect(out.answered).toBe(0);
    // Up to one lane's worth past the mark may already be in flight.
    expect(s.sent).toBeGreaterThanOrEqual(DEAD_AFTER);
    expect(s.sent).toBeLessThan(DEAD_AFTER + 4);
  });

  test("some failures do not stop a sweep that is getting answers", async () => {
    const s = session((i) => (i % 3 === 0 ? { ok: true } : null));
    const out = await askEach(s.jev, null, items(30), { concurrency: 4, onAnswer: () => {} });
    expect(out.read).toBe(30);
    expect(out.answered).toBe(10);
    expect(out.why).toBeNull();
  });

  test("running into the day's cap before any answer says daily_cap, and stops asking", async () => {
    const s = session(() => ({ ok: true }), 0);
    const out = await askEach(s.jev, null, items(20), { concurrency: 4, onAnswer: () => {} });
    expect(out).toEqual({ read: 0, answered: 0, why: "daily_cap" });
  });

  test("the cap running out part-way keeps what was answered", async () => {
    const s = session(() => ({ ok: true }), 7);
    const out = await askEach(s.jev, null, items(20), { concurrency: 4, onAnswer: () => {} });
    expect(out.answered).toBe(7);
    expect(out.why).toBeNull();
  });
});

/**
 * Two wires between the same two steps bow apart instead of drawing over each other (Dev, 2026-11-26: "lets try to have
 * overlapping lines like this, let them bow over each other"): Intake to Front door and back drew one straight line
 * with an arrow at each end.
 *
 * Sabotage record (temporary local edits, reverted):
 *   wireBows giving every wire of a pair the same side           "a wire and its return bow to opposite sides" fails
 *   wirePath ignoring bow                                          "a bowed wire leaves the straight line" fails
 *   wireBows skipping the behind-a-card check                      "arcs clear of it" fails
 */
import { describe, expect, test } from "@jest/globals";
import { wireBows, wirePath } from "@context/lab/app/views/canvas/wires";

// Three cards in a row and one under the first: checkFinish -> intake runs behind frontDoor.
const at: Record<string, { x: number; y: number }> = { intake: { x: 0, y: 0 }, frontDoor: { x: 400, y: 0 }, checkFinish: { x: 800, y: 0 }, text: { x: 0, y: 300 } };
const centre = (id: string) => (at[id] ? { ...at[id]!, w: 180, h: 64 } : null);

describe("wires between the same two steps", () => {
  test("a wire and its return bow to opposite sides of the line", () => {
    const bows = wireBows(
      [
        { from: "intake", to: "frontDoor", mode: "wait" },
        { from: "frontDoor", to: "intake", mode: "wait" },
        { from: "text", to: "intake", mode: "wait" },
      ],
      centre,
    );
    const there = bows.get(0)!.mid,
      back = bows.get(1)!.mid;
    expect(Math.abs(there.y)).toBeGreaterThan(10);
    expect(Math.sign(there.y)).toBe(-Math.sign(back.y));
    expect(there.x).toBeCloseTo(0);
    // A pair with one wire stays straight.
    expect(bows.has(2)).toBe(false);
  });

  test("a send-back loop takes no lane, and a lone wire none either", () => {
    const bows = wireBows(
      [
        { from: "intake", to: "frontDoor", mode: "wait" },
        { from: "frontDoor", to: "intake", mode: "loop" },
      ],
      centre,
    );
    expect(bows.size).toBe(0);
  });

  test("a bowed wire leaves the straight line, and an unbowed one is drawn as before", () => {
    const a = { x: 0, y: 0 },
      b = { x: 400, y: 0 };
    expect(wirePath(a, b, "wait").d).toBe("M180,32 C290,32 290,32 400,32");
    const d = wirePath(a, b, "wait", undefined, undefined, { mid: { x: 0, y: -24 }, ends: { x: 0, y: -8 } }).d;
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeLessThan(32 - 20);
  });
});

describe("folded boxes", () => {
  test("wires the same way and of the same kind share one lane; a pair with one lane stays straight", () => {
    const same = wireBows(
      [
        { from: "intake", to: "frontDoor", mode: "wait" },
        { from: "intake", to: "frontDoor", mode: "wait" },
      ],
      centre,
    );
    expect(same.size).toBe(0);
    const bows = wireBows(
      [
        { from: "intake", to: "frontDoor", mode: "wait" },
        { from: "intake", to: "frontDoor", mode: "wait" },
        { from: "frontDoor", to: "intake", mode: "wait" },
      ],
      centre,
    );
    expect(bows.get(0)).toEqual(bows.get(1));
    expect(Math.sign(bows.get(0)!.mid.y)).toBe(-Math.sign(bows.get(2)!.mid.y));
  });
});

describe("a wire behind another card", () => {
  test("arcs clear of it like send back: going back right to left over the row, going on under it", () => {
    const bows = wireBows(
      [
        { from: "checkFinish", to: "intake", mode: "generator" },
        { from: "intake", to: "checkFinish", mode: "wait" },
        { from: "intake", to: "frontDoor", mode: "wait" },
      ],
      centre,
    );
    const back = bows.get(0)!.arc!,
      on = bows.get(1)!.arc!;
    expect(back).toBeLessThan(0);
    expect(on).toBeGreaterThan(0);
    // Drawn as send back is: from the top of one card to the top of the other, its handles past both (Dev: "can the
    // bow be smoother? I like the sendback bow").
    const d = wirePath(at.checkFinish!, at.intake!, "generator", 180, 180, bows.get(0)).d;
    expect(d).toBe(`M890,0 C890,${back} 90,${back} 90,0`);
    expect(wirePath(at.intake!, at.checkFinish!, "wait", 180, 180, bows.get(1)).d).toBe(`M90,64 C90,${64 + on} 890,${64 + on} 890,64`);
    // The neighbours' own wire has nothing behind it and stays straight.
    expect(bows.has(2)).toBe(false);
  });
});

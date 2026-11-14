/**
 * Real step times for one of the person's own texts on the Lab's canvas (Dev2, 2026-11-14: "when we play through a
 * real text, show the real time instead of the estimate"), and Haiku's speed fitted to Tex's real calls ("keep it as
 * estimates but make it accurate").
 *
 * Sabotage checks: drop the judge branch in `realTimes` and "a turn's reply timing..." fails on the reviewer; put
 * Haiku back to the artifact's 1400 ms + 4.1 ms per token and "Haiku's estimate..." fails on the median miss.
 */
import { describe, expect, jest, test } from "@jest/globals";
import { BASE_MODELS } from "../features/tex/lab/data/models";
import { realTimes, roundUsd, withReal, withWorkerSteps } from "../features/tex/lab/engine/realTimes";
import { simulate, type Sim } from "../features/tex/lab/engine/sim";

const turn = "t1";
const reply = {
  id: "r1",
  at: 2,
  kind: "reply",
  turn,
  timing: {
    waitMs: 400,
    replyMs: 6300,
    rounds: [
      { at: 700, ms: 1500, output: 100 },
      { at: 2850, ms: 1200, output: 97 },
    ],
    tools: [{ at: 2200, ms: 650, name: "search_web" }],
  },
};

describe("realTimes", () => {
  test("a turn's reply timing, reviewer and model steps become the canvas steps they measure", () => {
    const r = realTimes(
      [
        reply,
        { id: "j1", at: 3, kind: "judge", turn, by: "review", ms: 2100 },
        { id: "s1", at: 4, kind: "step", turn, step: "classifier", ms: 900 },
        { id: "s2", at: 4, kind: "step", turn, step: "timing", name: "model", ms: 5000 },
        { id: "o1", at: 5, kind: "judge", turn: "other", by: "review", ms: 9999 },
      ],
      turn,
    )!;
    expect(r.reply).toBe(6700);
    expect(r.ms).toEqual({ lanes: 400, door: 700, fd: 2700, tools: 650, reviewer: 2100, classifier: 900, send: 150 });
    expect(r.calls).toEqual({ fd: 2, reviewer: 1, classifier: 1 });
  });

  test("no turn, or a reply with no timing, measures nothing", () => {
    expect(realTimes([reply], null)).toBeNull();
    expect(realTimes([{ id: "r2", at: 1, kind: "reply", turn }], turn)).toBeNull();
  });

  test("withReal places a measured step the run did not reach where it ran, and marks what was measured", () => {
    const sim = { T: { door: { start: 900, end: 1600, ms: 700, usd: 0, calls: 0, parts: [], lane: "reply" }, fd: { start: 1600, end: 4300, ms: 2700, usd: 0, calls: 2, parts: [], lane: "reply" } }, reply: 17600, usd: 0, replyCalls: 5, jobEnd: 0, reach: new Map(), inside: new Set() } as Sim;
    const out = withReal(sim, { reply: 6700, ms: { door: 700, fd: 2700, tools: 650 }, calls: { fd: 2 }, at: { tools: 1500 } });
    expect(out.reply).toBe(6700);
    expect(out.T.fd).toBe(sim.T.fd);
    expect(out.T.tools).toMatchObject({ start: 2400, end: 3050, ms: 650 });
    expect([...out.real!]).toEqual(["door", "fd", "tools"]);
    expect(withReal(sim, null)).toBe(sim);
  });

  test("a real run takes measured times, skips steps that log when they run but logged nothing, and adds no send-backs", () => {
    const { G } = jest.requireActual<typeof import("../features/tex/lab/engine/state")>("../features/tex/lab/engine/state");
    const real = { reply: 6700, ms: { lanes: 450, door: 700, fd: 2700, tools: 650, send: 150 }, calls: { fd: 2 } };
    const sim = simulate(G(), "own", null, real);
    expect(sim.T.fd.ms).toBe(2700 + 650);
    expect(sim.T.reviewer).toBeUndefined();
    expect(sim.T.fd.parts.some((p) => p.id === "sendback")).toBe(false);
    expect(sim.T.door.start).toBe(sim.T.lanes.end);
  });
});

// Tex's real front-door calls (Dev2's 1:1, 2026-11-13): [ms, tokens out, input tokens not read from the cache].
const CALLS: Array<[number, number, number]> = [
  [3784, 141, 46861], [1473, 100, 31475], [1210, 97, 1177], [3731, 159, 94593], [1060, 103, 995], [3013, 312, 216], [1859, 206, 723],
  [3215, 273, 89742], [1305, 122, 394], [795, 91, 146], [3347, 225, 45358], [1066, 82, 249], [9725, 1486, 93573], [1312, 18, 6440],
  [3834, 149, 93569], [1381, 110, 1159], [893, 2, 744], [4019, 423, 14220], [1194, 79, 1566], [918, 90, 1724], [1840, 157, 924],
  [1466, 192, 206], [1174, 99, 700], [1698, 167, 3082], [1457, 168, 5007], [1388, 100, 7711], [2605, 302, 7670], [5053, 971, 10084],
  [3015, 587, 10747], [2672, 511, 10480], [3094, 276, 9848], [1909, 182, 3196], [3446, 537, 8709], [2423, 277, 10705], [1830, 155, 10483],
  [4772, 948, 10385], [1739, 131, 4944], [2901, 297, 5252], [4028, 662, 754], [8301, 1687, 6718], [3734, 741, 2378],
];

test("Haiku's estimate misses Tex's real calls by a median of under 300 ms", () => {
  const m = BASE_MODELS["haiku-5-5"];
  const miss = CALLS.map(([ms, out, cold]) => Math.abs((m.base ?? 0) + out * (m.perTok ?? 0) + cold * (m.perIn ?? 0.006) - ms)).sort((a, b) => a - b);
  expect(miss[Math.floor(miss.length / 2)]).toBeLessThan(300);
});

test("the wire key offers Next, Helper, Background and Send back: after-sending wires are drawn as Background", () => {
  // Dev2, 2026-11-14: "next, and background is really all we need".
  const { keywHtml } = jest.requireActual<typeof import("../features/tex/lab/views/canvas/render")>("../features/tex/lab/views/canvas/render");
  const { WIRES } = jest.requireActual<typeof import("../features/tex/lab/data/graph")>("../features/tex/lab/data/graph");
  expect([...keywHtml().matchAll(/<\/svg>([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(["Next", "Helper", "Background", "Send back"]);
  expect({ ...WIRES.background, folded: undefined, tip: "" }).toEqual({ ...WIRES.job, folded: undefined, tip: "" });
});

describe("what a turn really cost, and turns that kept no reply timing (Dev2, 2026-11-14)", () => {
  test("the front door's cost is read from its logged tokens at Haiku 5.5's prices", () => {
    // $0.10 in, $0.125 cache write, $0.01 cache read, $0.50 out, per million.
    const r = { model: "anthropic/claude-haiku-5-5", input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 };
    expect(roundUsd(r)).toBeCloseTo(0.1 + 0.125 + 0.01 + 0.5, 6);
    const timed = { ...reply, timing: { ...reply.timing, rounds: [{ at: 700, ms: 1500, model: "anthropic/claude-haiku-5-5", cacheWrite: 94_593, output: 159 }] } };
    expect(realTimes([timed], turn)?.usd).toBeCloseTo((94_593 * 0.125 + 159 * 0.5) / 1e6, 8);
    expect(realTimes([reply], turn)?.usd).toBeUndefined();
  });

  test("a routine's turn is measured from its own entries", () => {
    const es = [
      { id: "a", at: 10_000, kind: "thinking", turn: "gw", ms: 4_000, text: "…" },
      { id: "b", at: 11_000, kind: "tool", turn: "gw", name: "fetch", ms: 900 },
      { id: "c", at: 15_000, kind: "judge", turn: "gw", by: "review", ms: 3_000 },
      { id: "d", at: 15_100, kind: "note", turn: "gw", text: "x" },
    ];
    expect(realTimes(es, "gw")).toEqual({ reply: 9_100, ms: { fd: 4_000, tools: 900, reviewer: 3_000 }, calls: { fd: 1, reviewer: 1 } });
  });

  test("the texting Worker's judgings, logged with no turn, count as the turn's Decide step", () => {
    const es = [
      { id: "w", at: 1_000, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 280, input: { texts: 1 }, output: { act: "answer" } } },
      { id: "late", at: 99_000, kind: "step", step: { name: "decide", of: "waiting", ok: true, ms: 280 } },
      { ...reply, at: 5_000 },
    ];
    const got = withWorkerSteps(es, turn, 0, 5_000);
    const decide = got.find((e) => e.id === "w")!;
    expect([decide.turn, decide.step, decide.ms, decide.output]).toEqual([turn, "decide", 280, { act: "answer" }]);
    expect(got.some((e) => e.id === "late")).toBe(false);
    expect(realTimes(got, turn)?.ms.decide).toBe(280);
  });
});

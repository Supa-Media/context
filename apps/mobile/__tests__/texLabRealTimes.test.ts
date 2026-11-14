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
import { realTimes, withReal } from "../features/tex/lab/engine/realTimes";
import type { Sim } from "../features/tex/lab/engine/sim";

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

  test("withReal puts measured times in and marks what was measured", () => {
    const sim = { T: { fd: { start: 0, end: 9, ms: 9400, usd: 0, calls: 3, parts: [], lane: "reply" } }, reply: 17600, usd: 0, replyCalls: 5, jobEnd: 0, reach: new Map(), inside: new Set() } as Sim;
    const out = withReal(sim, { reply: 6700, ms: { fd: 2700, tools: 650 }, calls: { fd: 2 } });
    expect(out.reply).toBe(6700);
    expect(out.T.fd.ms).toBe(2700);
    expect(out.T.tools.ms).toBe(650);
    expect([...out.real!]).toEqual(["fd", "tools"]);
    expect(withReal(sim, null)).toBe(sim);
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
  expect({ ...WIRES.behind, folded: undefined, tip: "" }).toEqual({ ...WIRES.job, folded: undefined, tip: "" });
});

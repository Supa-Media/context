/**
 * @jest-environment jsdom
 */

/**
 * Repeated Front door runs in the Lab (Dev2, 2026-11-19): each test runs N times (default 3, max 5), a run's score is
 * the mean with its min–max band, a draft "wins" only when its worst repeat beats main's best, and a run on Claude Code
 * is "model family only". What it proves: the score and cost words say the band and the repeats; the cc label reaches
 * the Runs panel and the run list; the repeats menu sets the next run's repeats; the Compare view's verdict is wins,
 * within noise, no run or no base; a draft with rows on both runs is decided by the paired rule (the 95% interval of its
 * per-row difference excludes 0), and the min..max band only when there are no rows; the tex_dev line carries repeats.
 *
 * Every name and number here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-19):
 *   (a) Compare.web.tsx `verdictOf` returning bandVerdict of the means (a draft's mean against main's mean) for every
 *       pair -> "a draft whose worst repeat beats main's best wins" and "overlapping bands are within noise" fail;
 *   (a2) Compare.web.tsx `verdictOf` returning bandVerdict even when both runs have rows -> "a draft better on the same
 *       rows wins on the paired interval" fails (the band says within noise there);
 *   (b) Runs.web.tsx `useStartRun` dropping `repeats` -> "the repeats menu sets the next run's repeats" fails.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => (args === "skip" ? undefined : mockAnswers.get(getFunctionName(reference))),
    useMutation: (reference: never) => async (args: Record<string, unknown>) => {
      mockCalls.push({ fn: getFunctionName(reference), args });
      return { runId: "run9", status: "ok", rev: 1 };
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { Compare } from "@context/lab/app/views/Compare.web";
import { RunSplit } from "@context/lab/app/views/bar/TopBar.web";
import { RunsPanel } from "@context/lab/app/views/runs/Runs.web";
import { clone, MAIN, set as setLab } from "@context/lab/app/engine/state";
import { costWords, CC_FIDELITY, CC_FIDELITY_WHY, DEFAULT_REPEATS, fidelityWords, mcpLines, MAX_REPEATS, rowRate, runsUi, scoreWords, setRunsUi, type LabRun, type RunScore } from "@context/lab/app/engine/labRuns";

const band = (mean: number, min: number, max: number, repeats = 3, total = 30): RunScore => ({ mean, min, max, lo: mean, hi: mean, repeats, total });
const RUN = (id: string, versionId: string, models: "gw" | "cc", score: RunScore, extra: Partial<LabRun> = {}): LabRun => ({
  id,
  versionId,
  kind: "dev",
  models,
  repeats: score.repeats,
  stage: "done",
  startedAt: 1,
  finishedAt: 2,
  results: { pass: score.mean, total: score.total, costUsd: 0.012, ms: 1, score, repeats: score.repeats },
  ...extra,
});
const ONE: LabRun = { id: "one", versionId: "main", kind: "dev", models: "gw", stage: "done", startedAt: 1, results: { pass: 1, total: 2, costUsd: 0.01, ms: 1 } };

const roots: Array<() => void> = [];
function render(el: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(el));
}
const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
const qa = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)];
function click(s: string) {
  const el = q(s);
  if (!el) throw new Error(`expected ${s}`);
  act(() => el.click());
}
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockCalls.length = 0;
  act(() => setRunsUi({ open: false, run: null, models: "gw", ver: "main", repeats: DEFAULT_REPEATS }));
});
beforeEach(() => {
  MAIN.results = [];
  act(() => setLab({ cur: clone(MAIN), versions: [MAIN], view: "compare" }));
  mockAnswers.set("functions/texLabRuns:list", []);
});

describe("a run's score and cost say the repeats", () => {
  test("a run that repeated reads its mean with its band; one repeat reads as before", () => {
    expect(scoreWords(RUN("a", "main", "gw", band(13.3, 11, 15)))).toBe("13.3/30 right (11–15 over 3 repeats)");
    expect(scoreWords(RUN("b", "main", "gw", band(12, 10, 14)))).toBe("12/30 right (10–14 over 3 repeats)");
    expect(scoreWords(ONE)).toBe("1/2 right");
  });

  test("a gw run's cost covers every repeat; a cc run costs nothing on the subscription", () => {
    expect(costWords(RUN("a", "main", "gw", band(13.3, 11, 15)))).toBe("$0.012 (AI gateway) for 3 repeats");
    expect(costWords(ONE)).toBe("$0.010 (AI gateway)");
    expect(costWords(RUN("c", "main", "cc", band(13.3, 11, 15)))).toBe("$0.00 (subscription)");
  });

  test("fidelityWords: a cc run is model family only; a gw run has no label", () => {
    expect(fidelityWords({ models: "cc" })).toBe(CC_FIDELITY);
    expect(CC_FIDELITY).toBe("model family only");
    expect(fidelityWords({ models: "gw" })).toBe("");
    expect(CC_FIDELITY_WHY).toContain("gw");
  });

  test("mcpLines gives the repeats on the run line, and the same line as before when the run has none", () => {
    expect(mcpLines(RUN("a", "main", "gw", band(13.3, 11, 15)))).toContain('tex_dev { action: "run", draft: "main", kind: "dev", models: "gw", repeats: 3 }');
    expect(mcpLines({ ...ONE, repeats: 1 })).toContain('models: "gw", repeats: 1 }');
    expect(mcpLines(ONE).split("\n")[0]).toBe('tex_dev { action: "run", draft: "main", kind: "dev", models: "gw" }');
  });

  test("rowRate: a row that ran more than once says how many repeats passed", () => {
    expect(rowRate({ runs: 3, passes: 2 })).toBe("2/3 passed");
    expect(rowRate({ runs: 1, passes: 1 })).toBe("");
    expect(rowRate({})).toBe("");
  });

  test("the repeats the Lab offers run from 1 to 5, and 3 by default", () => {
    expect(DEFAULT_REPEATS).toBe(3);
    expect(MAX_REPEATS).toBe(5);
    expect(runsUi.repeats).toBe(3);
  });
});

describe("the Runs panel shows a repeated run's band and its cc label", () => {
  test("a cc run says model family only with the reason, shows each node's band, and lists a row that passed some repeats", () => {
    const cc = RUN("cc1", "main", "cc", band(13.3, 11, 15), {
      results: {
        pass: 13.3,
        total: 30,
        costUsd: 0,
        ms: 1,
        score: band(13.3, 11, 15),
        repeats: 3,
        perNode: [{ node: "decide", pass: 13.3, total: 30, min: 11, max: 15 }],
        rows: [{ convId: "picnic", msgIndex: 0, node: "decide", ok: true, got: "respond", want: "respond", runs: 3, passes: 2 }],
      },
    });
    mockAnswers.set("functions/texLabRuns:list", [cc]);
    mockAnswers.set("functions/texLabRuns:get", cc);
    render(createElement(RunsPanel));
    act(() => setRunsUi({ open: true, run: "cc1" }));
    expect(q("#runFidelity")?.textContent).toContain(CC_FIDELITY);
    expect(q("#runFidelity .small.muted")?.textContent).toBe(CC_FIDELITY_WHY);
    expect(q("#runsPanel .pernode")?.textContent).toMatch(/13\.3\/30 \(11–15\)/);
    expect(q("#runsPanel .miss")?.textContent).toContain("2/3 passed");
    expect(qa("#runsPanel .runrow")[0].textContent).toContain("model family only");
  });

  test("a gw run has no cc label", () => {
    const gw = RUN("gw1", "main", "gw", band(13.3, 11, 15));
    mockAnswers.set("functions/texLabRuns:list", [gw]);
    mockAnswers.set("functions/texLabRuns:get", gw);
    render(createElement(RunsPanel));
    act(() => setRunsUi({ open: true, run: "gw1" }));
    expect(q("#runFidelity")).toBeNull();
    expect(q("#runsPanel")?.textContent).toContain("13.3/30 right (11–15 over 3 repeats)");
  });
});

describe("Compare: a draft wins only when its band clears main's", () => {
  const draftView = () => ({ ...clone(MAIN), id: "v-draft", name: "Simpler graph" });

  function rowOf(id: string) {
    return q(`[data-cv="${id}"]`)!.closest("tr")!;
  }

  test("a draft whose worst repeat beats main's best wins, with the band as its reason", () => {
    const main = RUN("m", "main", "gw", band(5, 2, 5));
    const draft = RUN("d", "v-draft", "gw", band(13.3, 11, 15));
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    const verdict = rowOf("v-draft").querySelector<HTMLElement>("[data-verdict]")!;
    expect(verdict.dataset.verdict).toBe("wins");
    expect(verdict.textContent).toBe("wins");
    expect(verdict.title).toContain("worst repeat beats the base's best");
    expect(rowOf("v-draft").textContent).toContain("13.3/30 (11–15 ×3)");
  });

  test("overlapping bands are within noise", () => {
    const main = RUN("m", "main", "gw", band(12, 10, 14));
    const draft = RUN("d", "v-draft", "gw", band(13.3, 11, 15));
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).toBe("within noise");
  });

  test("a higher mean is not a win: a draft whose worst repeat is under main's best is within noise", () => {
    const main = RUN("m", "main", "gw", band(5, 2, 5));
    const draft = RUN("d", "v-draft", "gw", band(6, 3, 9));
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).toBe("within noise");
  });

  test("a base on other models is no base, even when its numbers are lower", () => {
    const main = RUN("m", "main", "gw", band(5, 2, 5));
    const draft = RUN("d", "v-draft", "cc", band(13.3, 11, 15));
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).toBe("no base");
    expect(rowOf("v-draft").textContent).toContain("model family only");
  });

  test("main is the base, and a draft without a run says so", () => {
    mockAnswers.set("functions/texLabRuns:list", []);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("main").textContent).toContain("base");
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).toBe("no run");
  });

  test("the PageHead says vs main is paired with a 95% interval and the detectable change, and cc is model family only", () => {
    render(createElement(Compare));
    const head = document.body.textContent ?? "";
    expect(head).toContain("vs main is paired on the rows both runs scored, clustered by conversation");
    expect(head).toContain("the 95% interval of its difference from main excludes 0");
    expect(head).toContain("smallest change this comparison could detect at 80% power");
    expect(head).toContain("pass^k");
    expect(head).toContain("model family only");
  });
});

describe("Compare: the paired rule on the rows both runs scored", () => {
  const rowsOf = (passes: Record<string, number[]>) =>
    Object.entries(passes).flatMap(([convId, turns]) => turns.map((p, msgIndex) => ({ convId, msgIndex, node: "decide", ok: p > 0, got: "", want: "", runs: 3, passes: p })));
  const withRows = (score: RunScore, rows: ReturnType<typeof rowsOf>): LabRun["results"] => ({ pass: score.mean, total: score.total, costUsd: 0.01, ms: 1, score, repeats: 3, rows });
  const draftView = () => ({ ...clone(MAIN), id: "v-draft", name: "Simpler graph" });
  const rowOf = (id: string) => q(`[data-cv="${id}"]`)!.closest("tr")!;
  // Four conversations, three turns each: main's passes per turn, and the draft's.
  const mainRows = rowsOf({ a: [0, 1, 2], b: [1, 1, 1], c: [0, 0, 1], d: [1, 2, 2] });

  test("a draft better on the same rows in every conversation wins on the paired interval, even where the bands overlap", () => {
    const main = RUN("m", "main", "gw", band(12, 10, 14), { results: withRows(band(12, 10, 14), mainRows) });
    const draft = RUN("d", "v-draft", "gw", band(13.3, 11, 15), { results: withRows(band(13.3, 11, 15), rowsOf({ a: [2, 2, 3], b: [2, 2, 2], c: [1, 2, 2], d: [3, 3, 2] })) });
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).toBe("wins");
    const paired = rowOf("v-draft").querySelector<HTMLElement>("[data-paired]");
    expect(paired?.textContent).toContain("12 rows / 4 chats");
    expect(paired?.textContent).toContain("detectable");
  });

  test("a draft whose band wins but whose gains sit in one conversation is not a win on the paired rule", () => {
    const main = RUN("m", "main", "gw", band(12, 10, 14), { results: withRows(band(12, 10, 14), mainRows) });
    const draft = RUN("d", "v-draft", "gw", band(17, 16, 18), { results: withRows(band(17, 16, 18), rowsOf({ a: [3, 3, 3], b: [0, 0, 0], c: [0, 0, 0], d: [0, 0, 0] })) });
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).not.toBe("wins");
    expect(rowOf("v-draft").querySelector("[data-paired]")).not.toBeNull();
  });

  test("the Dev set run cell says pass^k and the Wilson interval when the run repeated", () => {
    const main = RUN("m", "main", "gw", band(12, 10, 14));
    const draft = RUN("d", "v-draft", "gw", band(13.3, 11, 15), { results: withRows(band(13.3, 11, 15), rowsOf({ a: [2, 2, 3], b: [2, 2, 2], c: [1, 2, 2], d: [3, 3, 2] })) });
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    const stats = rowOf("v-draft").querySelector<HTMLElement>("[data-stats]");
    expect(stats?.textContent).toContain("pass^3");
    expect(stats?.textContent).toContain("Wilson");
    expect(stats?.textContent).toContain("4 chats");
  });

  test("with no rows on either run there is no paired line, and the band still decides", () => {
    const main = RUN("m", "main", "gw", band(5, 2, 5));
    const draft = RUN("d", "v-draft", "gw", band(13.3, 11, 15));
    mockAnswers.set("functions/texLabRuns:list", [draft, main]);
    act(() => setLab({ versions: [MAIN, draftView()] }));
    render(createElement(Compare));
    expect(rowOf("v-draft").querySelector("[data-verdict]")?.textContent).toBe("wins");
    expect(rowOf("v-draft").querySelector("[data-paired]")).toBeNull();
    expect(rowOf("v-draft").querySelector("[data-stats]")).toBeNull();
  });
});

describe("the repeats menu sets how many times the next run repeats", () => {
  test("the menu shows 1 to 5 with 3 chosen, and ▶ Run Dev set starts with the one picked", async () => {
    act(() => setLab({ cur: clone(MAIN) }));
    render(createElement(RunSplit));
    click("#runMore");
    expect(qa("[data-repeats]").map((b) => b.dataset.repeats)).toEqual(["1", "2", "3", "4", "5"]);
    expect(q('[data-repeats="3"]')?.getAttribute("aria-checked")).toBe("true");
    click('[data-repeats="5"]');
    expect(q('[data-repeats="5"]')?.getAttribute("aria-checked")).toBe("true");
    expect(runsUi.repeats).toBe(5);
    expect(q("#runModels")?.textContent).toContain("Each Front door test runs this many times");
    click("#labRunDev");
    await tick();
    expect(mockCalls.filter((c) => c.fn === "functions/texLabRuns:start").map((c) => c.args)).toEqual([{ versionId: "main", kind: "dev", models: "gw", repeats: 5 }]);
  });

  test("the cc option says model family only", () => {
    render(createElement(RunSplit));
    click("#runMore");
    expect(q('[data-models="cc"]')?.textContent).toContain("model family only");
  });
});

/**
 * @jest-environment jsdom
 */
/**
 * A text Tex sent from a background job opens to everything that led up to it (Dev2, 2026-11-14: "I'm not able to see
 * any insight into what the background job did, any tool calls that he did"). Made-up texts throughout.
 */
import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { jobsOf, jobWork } from "../features/tex/lab/engine/jobRuns";
import { JobRuns } from "../features/tex/lab/views/replay/JobRuns";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const J = "job-0001";
const e = (x: Partial<LedgerEntry> & { id: string; kind: string }) => ({ at: 1_000, ...x }) as LedgerEntry;
const entries: LedgerEntry[] = [
  // Run 1: read a page, then the job check says keep going.
  e({ id: "a1", seq: 1, at: 10_000, kind: "thinking", turn: "run1", ms: 900, text: "I'll read the inbox code first.", jobId: J, jobTitle: "Check the roster" }),
  e({ id: "a2", seq: 2, at: 13_000, kind: "tool", turn: "run1", name: "open_page", ok: true, ms: 3_000, args: { urls: ["https://example.invalid/inbox.ts"] }, result: "export function keepNames() {}", jobId: J }),
  e({ id: "a3", seq: 3, at: 20_000, kind: "reply", turn: "run1", ms: 12_000, model: "anthropic/claude-haiku-5-5", text: "Probably real.", jobId: J }),
  e({ id: "a4", seq: 4, at: 22_000, kind: "job", turn: "run1", job: J, title: "Check the roster", state: "keep_going", advice: "Open the caller next.", jobId: J }),
  // Run 2: a failed read.
  e({ id: "b1", seq: 5, at: 40_000, kind: "tool", turn: "run2", name: "open_page", ok: false, ms: 500, args: { urls: ["https://example.invalid/x"] }, error: "blocked", jobId: J }),
  e({ id: "b2", seq: 6, at: 45_000, kind: "job", turn: "run2", job: J, title: "Check the roster", state: "stuck", jobId: J }),
  // The report turn: what was texted, its job entry naming the job, with no jobId on the rest.
  e({ id: "c1", seq: 7, at: 50_000, kind: "job", turn: "rep", job: J, title: "Check the roster", state: "stuck", report: "Nothing records who left." }),
  e({ id: "c2", seq: 8, at: 60_000, kind: "reply", turn: "rep", ms: 9_000, text: "The roster check stalled." }),
  e({ id: "c3", seq: 9, at: 61_000, kind: "text", turn: "rep", from: { kind: "tex" }, text: "The roster check stalled." }),
  // Another job's run, not this one's.
  e({ id: "z1", seq: 10, at: 30_000, kind: "tool", turn: "other", name: "search", jobId: "job-0002" }),
];

describe("a background job's runs", () => {
  test("the report turn names its job, and the job's runs come back in order with their checks", () => {
    expect(jobsOf(entries, ["rep"])).toEqual([{ id: J, title: "Check the roster" }]);
    const w = jobWork(entries, J);
    expect(w.title).toBe("Check the roster");
    expect(w.runs.map((r) => [r.turn, r.state])).toEqual([["run1", "keep_going"], ["run2", "stuck"], ["rep", "stuck"]]);
    expect(w.runs[0].tools).toEqual([{ at: 13_000, name: "open_page", ok: true, ms: 3_000, args: { urls: ["https://example.invalid/inbox.ts"] }, result: "export function keepNames() {}" }]);
    expect(w.runs[0].advice).toBe("Open the caller next.");
    expect(w.runs[0].said).toBe("Probably real.");
    expect(w.runs[1].tools[0]).toMatchObject({ ok: false, result: "blocked" });
    expect(w.runs[2].report).toBe("Nothing records who left.");
    expect(w.runs.flatMap((r) => r.tools.map((t) => t.name))).not.toContain("search");
  });

  test("the panel lists each run, opening to every tool call's arguments and result", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(JobRuns, { id: J, entries })));
    const runs = Array.from(host.querySelectorAll<HTMLElement>(".jrun"));
    expect(runs.map((r) => r.querySelector("summary")!.textContent)).toEqual([
      expect.stringMatching(/^Run 1 · .* · 1 tool call · kept going$/),
      expect.stringMatching(/^Run 2 · .* · 1 tool call · stuck$/),
      expect.stringMatching(/^Report · .* · 0 tool calls · stuck$/),
    ]);
    expect(runs[0].textContent).toContain("Open the caller next.");
    expect(runs[0].querySelector(".jtool")!.textContent).toContain("https://example.invalid/inbox.ts");
    expect(runs[0].querySelector(".jtool")!.textContent).toContain("export function keepNames() {}");
    expect(runs[1].querySelector(".jtool summary")!.textContent).toContain("failed");
    act(() => root.unmount());
  });
});

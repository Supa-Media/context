/**
 * Every step on the canvas logs what went in, what came out and what it ran with (Dev2, 2026-11-14: "Every single
 * block should have proper logging of what's going in and out and what parameters were set"). Fails when a step is
 * drawn with no logging contract, or when a turn that logged every record the contract names still leaves a step's
 * panel without both sides.
 */
import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { G } from "../features/tex/lab/engine/state";
import { STEP_LOGS, nodeOfStep } from "../features/tex/lab/engine/stepLogs";
import { momentAsSteps, stepIO } from "../features/tex/lab/engine/stepIO";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const T = "t1";
let n = 0;
const e = (x: Partial<LedgerEntry> & { kind: string }) => ({ id: `e${++n}`, at: 1_000 + n, seq: n, ...x }) as LedgerEntry;
const step = (name: string, extra: Record<string, unknown> = {}) => e({ kind: "step", turn: T, step: name, ok: true, ms: 120, input: { got: name }, output: { gave: name }, ...extra });

/** One turn that logged every record `STEP_LOGS` names. */
const entries: LedgerEntry[] = [
  e({ kind: "text", eid: "1000-000001", from: { kind: "person", name: "seyi" }, text: "can you plan the trip" }),
  e({ kind: "judge", by: "moment", model: "@cf/cloudflare/clef", verdict: "respond", went: true, event: "1000-000001", why: "asks_tex", confidence: 0.9, ms: 900, input: { candidates: ["1000-000001"], running: false } }),
  e({ kind: "note", turn: T, about: "(Not a text from them. This was your own check-in: you looked through their workspace.)", text: "Payroll is due." }),
  e({ kind: "note", turn: T, routine: "tex/routines/daily/news.md", outcome: "answered", text: "Nothing new." }),
  e({ kind: "note", turn: T, about: "(Not a text from them. Another of their agents asked you to get their attention, and you texted them what follows.)", text: "Deploy done." }),
  step("react", { input: { on: "1000-000001" }, output: { emoji: "👍" } }),
  step("lane", { name: "write_note", output: { before: "t0" } }),
  step("door", { input: { chat: "group", kind: "text", covers: ["1000-000001"] }, output: { model: "anthropic/claude-haiku-5-5", effort: "medium", reviewer: "on", advisor: "on", planner: "off" } }),
  e({ kind: "brief", turn: T, asker: "seyi", ask: "plan the trip", tools: [], waiting: [] }),
  step("router", { input: "plan the trip", output: { tier: "fast" }, model: "@cf/cloudflare/clef" }),
  step("fallback", { input: { from: "haiku", status: 529 }, output: { model: "glm" } }),
  e({ kind: "thinking", turn: T, ms: 2_000, text: "Planning." }),
  e({ kind: "tool", turn: T, name: "plan_big_ask", ms: 400, args: { ask: "plan the trip", folder: "1-projects/trip/" }, result: "Started 3 jobs" }),
  e({ kind: "tool", turn: T, name: "read_note", ms: 300, args: { path: "about.md" }, result: "# About" }),
  e({ kind: "tool", turn: T, name: "ask_advisor", ms: 9_000, args: { question: "which first?" }, result: "Flights first." }),
  step("checks", { input: "Started.", output: null }),
  e({ kind: "mail_check", turn: T, to: "a@example.com", subject: "Trip", verdict: "send", why: "fine" }),
  step("card", { input: { tool: "draw_visual" }, output: { ok: true } }),
  e({ kind: "judge", turn: T, by: "review", model: "anthropic/claude-haiku-5-5", round: 1, went: true, ms: 1_500, draft: "Started." }),
  e({ kind: "text", turn: T, from: { kind: "tex" }, delivered: true, text: "Started." }),
  step("classifier", { input: "plan the trip", output: { thread: "trip" } }),
  step("selfreview", { input: "the chat", output: { better: "shorter" } }),
  e({ kind: "job", turn: T, job: "j1", title: "Flights", state: "keep_going", advice: "Check prices." }),
  e({ kind: "advisor", turn: T, check: true, jobTitle: "Flights", question: "Done?", answer: "Not yet.", ms: 8_000 }),
  step("mailadv", { input: { question: "reply?", from: "airline" }, output: "Tell them." }),
  step("handback", { input: "Here are flights.", output: null }),
  e({ kind: "reply", turn: T, text: "Started.", timing: { v: 2, waitMs: 1_200, replyMs: 9_000, steps: [{ name: "history", at: 10, ms: 300 }], rounds: [{ at: 900, ms: 4_000, model: "anthropic/claude-haiku-5-5", output: 200, prompt: { modules: [{ id: "stable/texting", n: 90_000, h: "aa" }] } }] } }),
];

describe("every canvas step logs what went in and what came out", () => {
  test("every step drawn has a logging contract, and every contract is a step drawn", () => {
    const drawn = G()
      .nodes.map((x) => x.id)
      .filter((id) => !["lanes"].includes(id) || true)
      .sort();
    expect(Object.keys(STEP_LOGS).sort()).toEqual(drawn);
    for (const [id, c] of Object.entries(STEP_LOGS)) for (const side of ["got", "gave", "settings"] as const) expect([id, side, c[side].length > 0]).toEqual([id, side, true]);
  });

  test("a turn that logged every record leaves no step without both what it got and what it gave", () => {
    const io = stepIO([...entries, ...momentAsSteps(entries[1], T)], T, "can you plan the trip", "Started.", "seyi's text");
    const thin = Object.keys(STEP_LOGS).filter((id) => (io[id]?.length ?? 0) < 2);
    expect(thin).toEqual([]);
  });

  test("a step logged under another name lands on its canvas step; timing is Door steps' gathering", () => {
    expect(nodeOfStep("lane")).toBe("lanes");
    expect(nodeOfStep("recheck")).toBe("decide");
    expect(nodeOfStep("timing")).toBeNull();
    expect(nodeOfStep("checks")).toBe("checks");
  });

  // The other way (Dev2, 2026-11-14: "Everything that's running should have a node"): every step the gateway writes to a
  // chat's ledger, and every one the Worker keeps, lands on a drawn step. Timing lines are Door steps' gathering.
  test("every step name the gateway or the Worker logs lands on a canvas step", () => {
    const ledger = readFileSync(join(__dirname, "../../mcp/src/agent/ledger.js"), "utf8");
    const names = JSON.parse(/export const STEP_NAMES = new Set\((\[[^\]]*\])\)/.exec(ledger)![1]) as string[];
    const worker = readFileSync(join(__dirname, "../../agent/src/stepEvents.ts"), "utf8");
    for (const m of worker.matchAll(/name: "([a-z]+)"/g)) names.push(m[1]);
    const nowhere = [...new Set(names)].filter((name) => name !== "timing" && nodeOfStep(name) === null);
    expect(nowhere).toEqual([]);
  });
});

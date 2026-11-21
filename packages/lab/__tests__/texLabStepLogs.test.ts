/**
 * Every step on the canvas logs what went in, what came out and what it ran with (Dev2, 2026-11-14: "Every single
 * block should have proper logging of what's going in and out and what parameters were set"). Fails when a step is
 * drawn with no logging contract, or when a turn that logged every record the contract names still leaves a step's
 * panel without both sides.
 */
import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { G, stepsOf } from "@context/lab/app/engine/state";
import { STEP_LOGS, nodeOfStep } from "@context/lab/app/engine/stepLogs";
import { momentAsSteps, stepIO } from "@context/lab/app/engine/stepIO";
import type { LedgerEntry } from "../../../apps/mobile/features/tex/page/texPageTypes";

const T = "t1";
let n = 0;
const e = (x: Partial<LedgerEntry> & { kind: string }) => ({ id: `e${++n}`, at: 1_000 + n, seq: n, ...x }) as LedgerEntry;
/** A run the config's graph runner logged (`ledger.js` `nodeEntry`): its input and output. */
const run = (name: string, input: unknown, output: unknown) => e({ kind: "step", turn: T, step: "node", name, ok: true, ms: 80, own: 80, input, output });
const step = (name: string, extra: Record<string, unknown> = {}) => e({ kind: "step", turn: T, step: name, ok: true, ms: 120, input: { got: name }, output: { gave: name }, ...extra });

/** One turn that logged every record `STEP_LOGS` names. */
const entries: LedgerEntry[] = [
  e({ kind: "text", eid: "1000-000001", from: { kind: "person", name: "seyi" }, text: "can you plan the trip" }),
  e({ kind: "judge", by: "moment", model: "@cf/cloudflare/clef", verdict: "respond", went: true, event: "1000-000001", why: "asks_tex", confidence: 0.9, ms: 900, input: { candidates: ["1000-000001"], running: false } }),
  e({ kind: "note", turn: T, about: "(Not a text from them. This was your own check-in: you looked through their workspace.)", text: "Payroll is due." }),
  e({ kind: "note", turn: T, routine: "tex/routines/daily/news.md", outcome: "answered", text: "Nothing new." }),
  e({ kind: "note", turn: T, about: "(Not a text from them. Another of their agents asked you to get their attention, and you texted them what follows.)", text: "Deploy done." }),
  step("oldLine", { input: { mode: "off", number: false, archiveOn: false }, output: { to: "pass" } }),
  step("edit", { input: { kind: "one", change: "edit", chars: 20, earlier: "event", earlierChars: 19 }, output: { to: "turn", why: "the words changed" } }),
  step("moveChat", { input: { kind: "person", number: true, archiveOn: false }, output: { outcome: "told", textChars: 98 } }),
  step("triage", { input: { texts: ["1000-000001"] }, output: { to: "judge", why: "several texts waiting" } }),
  step("react", { input: { on: "1000-000001" }, output: { emoji: "👍" } }),
  step("lane", { name: "write_note", output: { before: "t0" } }),
  run("decideWhy", { act: "quiet", why: "replies_to_tex" }, { to: "changed", why: "thanks_or_ok" }),
  run("shapeGate", { question: "is the bakery open sunday", group: false }, { to: "read", ending: "one_line", endingSure: 0.9, order: 0.1, records: 0.8 }),
  run("router", { question: "is the bakery open sunday", group: false, trigger: "text" }, { route: "read", sure: 0.8 }),
  run("fdQuick", { route: "quick", sure: 0.9 }, { door: "quick", kind: "door-quick" }),
  run("fdRead", { route: "read", sure: 0.8 }, { door: "read", kind: "door-read" }),
  run("fdAct", { route: "act", sure: 0.7 }, { door: "act", kind: "door-act" }),
  run("doorStep", { chat: "group", kind: "text" }, { when: ["next"], log: { parts: [{ part: "readTheText", ok: true, ms: 1, chat: "group", covers: ["1000-000001"] }] } }),
  run("bypass", { answeredBy: "settleAYesOrNo" }, { sent: true }),
  run("staff", { kind: "person" }, { text: "We moved." }),
  run("answerCheck", { draft: 8, reviewedAs: "report" }, { passed: true }),
  run("afterReply", { texts: 1 }, { threads: ["trip"], score: 4 }),
  run("chatDays", { texts: 1 }, { outcome: "summed", written: 1, missing: 0 }),
  run("warm", { owner: { person: "ws_1" }, chat: "texts", cause: "typing" }, { when: ["warmed"], ms: 412 }),
  run("moveJudge", { action: "move_note", path: "projects/agenda.md", workspace: "band" }, { allow: true, reason: "they said yes to the offer" }),
  run("crossChatGate", { from: "one", to: { kind: "group", key: "k" }, what: "is the demo Friday?" }, { to: "ask", ask: { id: "xabcdefghij" } }),
  run("chatAsk", { event: "chat_answer", crossChat: { id: "xabcdefghij" } }, { to: "answer", question: "(Not a text from them.)" }),
  run("chatAnswer", { kind: "ask", id: "xabcdefghij", draft: "Yes." }, { to: "back", id: "xabcdefghij", state: "answered", texts: ["Yes."] }),
  run("computer", { op: "run", owner: "f00d", command: "python3 sum.py" }, { ok: true, ms: 876, exitCode: 0, stdout: "142913828922" }),
  run("tapback", { emoji: "❤️", why: "they thanked me", lastFailed: false, tagged: false }, { to: "react", emoji: "❤️" }),
  run("askGate", { askChars: 21, draftChars: 34 }, { to: "back", kind: "fact", sure: 0.9, model: "@cf/cloudflare/clef-flash", modelMs: 109, asks: 1, climbed: { knows: 0, notes: 1, tried: [] }, when: ["tryNext"] }),
  run("rungKnows", { terms: ["sister", "address"] }, { found: [] }),
  run("rungNotes", { query: "sister address", terms: ["sister", "address"] }, { found: ["people/ana.md: 12 Elm St"] }),
  run("rungTools", {}, { tried: ["search"], failedApps: [] }),
  run("handoff", { ask: "find the address", notice: "nothing quick found it", cause: "ladder" }, { to: "hand", title: "Find the address" }),
  run("jobadv", { role: "check" }, { state: "keep_going" }),
  run("jobReport", { jobReport: { title: "Find ramen", state: "done", texts: ["Kyuramen."] } }, { to: "report", report: { title: "Find ramen", state: "done", texts: ["Kyuramen."] } }),
  run("jobStart", { hasTitle: true, hasBrief: true, cloudBusy: 0 }, { to: "start", where: "cloud", slots: 3 }),
  run("partEnd", { cause: "unfinished", part: 1 }, { to: "carry", cause: "unfinished", room: true }),
  run("learn", { question: "plan the trip" }, { nudge: { outcome: "skipped" }, reflect: { outcome: "skipped" } }),
  run("connect", { notes: ["areas/trips/plan.md"], question: "plan the trip", tainted: false, group: false }, { outcome: "connected", notes: 1, links: [{ from: "areas/trips/plan.md", to: "areas/trips/budget.md", why: "the same trip", there: "written", back: "written" }] }),
  run("noteRun", { path: "areas/trips/plan.md", noteText: "Fly out Friday.", anchor: { text: "Friday" }, ask: "make it Saturday", history: [], audience: "only the asker" }, { outcome: "answered", answer: "Changed it to Saturday.", replace: "Saturday", sources: ["areas/trips/plan.md"] }),
  step("door", { input: { chat: "group", kind: "text", covers: ["1000-000001"] }, output: { model: "anthropic/claude-haiku-5-5", effort: "medium", reviewer: "on", advisor: "on", planner: "off" } }),
  e({ kind: "brief", turn: T, asker: "seyi", ask: "plan the trip", tools: [], waiting: [] }),
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
  step("egress", { input: { words: "share the trip", action: "share", workspace: "band" }, output: { allow: false, reason: "not clear" } }),
  step("picture", { input: { tool: "draw_visual", args: { title: "Route" } }, output: { result: "drawn" } }),
  step("nudge", { input: { question: "who has the van?", answer: "Kemi does.", tainted: false }, output: { outcome: "wrote one line" } }),
  step("reflect", { input: { question: "plan the trip", tainted: false, ownText: true, canWrite: true }, output: { outcome: "nothing new", reason: "routine turn" } }),
  // The night's steps run on the control plane's schedule, not in a text's turn; the fixture logs them under this turn.
  step("nightly", { input: { run: "dream", timeZone: "Europe/London", since: 1 }, output: { to: "dream", timeZone: "Europe/London", since: 1 } }),
  step("dream", { input: { timeZone: "Europe/London", since: 1 }, output: { outcome: "kept", status: 200, when: [] } }),
  step("daysum", { input: { timeZone: "Europe/London", now: 2 }, output: { outcome: "summed one day" } }),
  step("aboutExpire", { input: { outcome: "dreamed", timeZone: "Europe/London", now: 2 }, output: { outcome: "expired", dropped: 1, when: ["check"] } }),
  step("aboutCheck", { input: { outcome: "expired", timeZone: "Europe/London", now: 2 }, output: { outcome: "unchanged", checked: 3 } }),
  step("housekeep", { input: { timeZone: "Europe/London" }, output: { outcome: "tidied", status: 200 } }),
  e({ kind: "reply", turn: T, text: "Started.", timing: { v: 2, waitMs: 1_200, replyMs: 9_000, steps: [{ name: "history", at: 10, ms: 300 }], rounds: [{ at: 900, ms: 4_000, model: "anthropic/claude-haiku-5-5", output: 200, prompt: { modules: [{ id: "stable/texting", n: 90_000, h: "aa" }] } }] } }),
];

describe("every canvas step logs what went in and what came out", () => {
  test("every step has a logging contract, and every contract is a step", () => {
    // Steps, never the folded groups' boxes; a step turned off in the "retired" group may keep the row it had.
    const steps = stepsOf(G()).nodes;
    const live = steps.filter((x) => x.group !== "retired").map((x) => x.id);
    expect(live.filter((id) => !(id in STEP_LOGS))).toEqual([]);
    expect(Object.keys(STEP_LOGS).filter((id) => !steps.some((x) => x.id === id))).toEqual([]);
    for (const [id, c] of Object.entries(STEP_LOGS)) for (const side of ["got", "gave", "settings", "time"] as const) expect([id, side, c[side].length > 0]).toEqual([id, side, true]);
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
    // A turn logged before the Door was one step lands on it.
    expect(nodeOfStep("door")).toBe("doorStep");
    // A step retired from the config (2026-11-20) lands on the step it was folded into.
    expect(nodeOfStep("checks")).toBe("answerCheck");
    expect(nodeOfStep("reflect")).toBe("learn");
  });

  // The other way (Dev2, 2026-11-14: "Everything that's running should have a node"): every step the gateway writes to a
  // chat's ledger, and every one the Worker keeps, lands on a drawn step. Timing lines are Door steps' gathering, and a
  // "node" step is the graph runner's, which lands on the node it names (stepIO.ts).
  test("every step name the gateway or the Worker logs lands on a canvas step", () => {
    const ledger = readFileSync(join(__dirname, "../../tex/gateway/agent/ledger.js"), "utf8");
    const names = JSON.parse(/export const STEP_NAMES = new Set\((\[[^\]]*\])\)/.exec(ledger)![1]) as string[];
    const worker = readFileSync(join(__dirname, "../../../packages/tex/worker/stepEvents.ts"), "utf8");
    for (const m of worker.matchAll(/name: "([a-z]+)"/g)) names.push(m[1]);
    const nowhere = [...new Set(names)].filter((name) => name !== "timing" && name !== "node" && nodeOfStep(name) === null);
    expect(nowhere).toEqual([]);
  });
});

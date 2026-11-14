/**
 * What every step got and gave in one real turn, for the right panel (Dev2, 2026-11-14: "WHY CANT I SEE WHAT IS GOING
 * IN AND OUT OF EVERY STEP ... I SHOULD ALSO SEE WHAT CONTEXT MODULES ITS GETTING ... every block should have really
 * good logging").
 *
 * Each step reads from what the turn logged, and where a step logged references rather than words (the judge keeps the
 * ids of the texts it judged; a model round keeps its prompt's module ids, sizes and fingerprints), the words are put
 * back from the same chat's ledger, never stored twice (Dev2, 2026-11-14 14:39Z: log references, rebuild the rest).
 */
import type { LedgerEntry } from "../../page/texPageTypes";
import { startOf } from "./mine";
import { nodeOfStep } from "./stepLogs";

export type IoLine = { k: string; v: string };

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Whole, never cut (Dev2, 2026-11-14: "we aren't properly showing the full input, thinkings, and outputs"): the panel folds a long one. */
export const show = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 1));
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const count = (n: number) => n.toLocaleString("en-US");

/** `step` names that are canvas steps of the same id. */
export const STEP_NODES = new Set(["triage", "decide", "react", "router", "fallback", "card", "classifier", "selfreview", "handback", "mailadv", "checks", "reviewer", "egress", "picture", "nudge", "reflect", "nightly", "dream", "daysum", "housekeep"]);

/** A text of the chat by any id the steps log for it (its event id, its entry id), as "Who: words". */
export function textById(entries: LedgerEntry[], id: string): string | null {
  const e = entries.find((x) => x.kind === "text" && (x.eid === id || x.id === id || x.id === "ev" + id.replace(/[^0-9]/g, "")));
  if (!e) return null;
  const from = rec(e.from);
  const who = from?.kind === "tex" ? "Tex" : str(from?.name) || (from?.kind === "person" ? "Them" : "Someone");
  return `${who}: ${str(e.text) || (e.tapback ? `tapback ${str(e.tapback)}` : "(a picture or file)")}`;
}

/** The judge's verdict in words. */
function verdictWords(o: Record<string, unknown>): string {
  const act = str(o.verdict) || str(o.act);
  const parts = [act === "respond" ? "answer" : act === "quiet" || act === "silent" ? "stay quiet" : act || "judged"];
  if (str(o.why)) parts.push(str(o.why).replace(/_/g, " "));
  if (num(o.confidence) !== null) parts.push(`${Math.round(num(o.confidence)! * 100)}% sure`);
  if (str(o.midTurn)) parts.push(`while a turn ran: ${str(o.midTurn) === "fold" ? "fold it in" : str(o.midTurn)}`);
  if (str(o.emoji)) parts.push(`tapback ${str(o.emoji)}`);
  return parts.join(" · ");
}

/** A judging's texts: the ones it was asked about, by the ids it logged. */
function judgedTexts(entries: LedgerEntry[], input: Record<string, unknown> | null, event?: unknown): string {
  const ids = [...(Array.isArray(input?.candidates) ? (input!.candidates as unknown[]) : []), input?.newest, event].filter((x): x is string => typeof x === "string" && x !== "");
  const lines = [...new Set(ids)].map((id) => textById(entries, id) ?? `(text ${id}, not in the part of the chat read)`);
  return lines.join("\n");
}

/** One model round of the front door: its time, tokens and the context modules its prompt was built from, in order. */
function roundLines(r: Record<string, unknown>, i: number, prev: string | null): { head: string; body: string; mods: string } {
  const p = rec(r.prompt);
  const mods = Array.isArray(p?.modules) ? (p!.modules as unknown[]).map(rec).filter((m): m is Record<string, unknown> => m !== null) : [];
  const modText = mods.map((m) => `${str(m.id)} · ${count(num(m.n) ?? 0)} chars · ${str(m.h)}`).join("\n");
  const tokens = [
    num(r.input) !== null ? `${count(num(r.input)!)} new in` : "",
    num(r.cacheRead) !== null ? `${count(num(r.cacheRead)!)} cached` : "",
    num(r.cacheWrite) ? `${count(num(r.cacheWrite)!)} written to cache` : "",
    num(r.output) !== null ? `${count(num(r.output)!)} out` : "",
    num(r.calls) ? `${num(r.calls)} tool calls` : "",
  ].filter(Boolean);
  const head = `Round ${i + 1} · ${secs(num(r.ms) ?? 0)}${str(r.model) ? " · " + str(r.model).replace(/^anthropic\//, "") : ""}`;
  const body = [tokens.join(" · "), modText ? (prev === modText ? "Same context modules as the round before" : "") : "No context modules logged (before 2026-11-14 16:00 UTC)"].filter(Boolean).join("\n");
  return { head, body, mods: modText };
}

/**
 * Everything one turn's steps got and gave. `entries` is the chat's ledger as read (texts, replies, notes and the
 * day's details); `turn` the turn; `text` what started it and `answer` what went out.
 */
export function stepIO(entries: LedgerEntry[], turn: string | null, text: string, answer: string, startedBy = "Your text"): Record<string, IoLine[]> {
  const io: Record<string, IoLine[]> = { text: [{ k: startedBy, v: text }] };
  const push = (id: string, k: string, v: unknown) => {
    const s = show(v);
    if (s.trim()) (io[id] ??= []).push({ k, v: s });
  };
  const mine = turn ? [...entries].filter((e) => e.turn === turn).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at) : [];
  const reply = mine.find((e) => e.kind === "reply");
  const timing = rec(reply?.timing) ?? rec(mine.find((e) => e.kind === "note" && rec(e.timing))?.timing);
  const rounds = (Array.isArray(timing?.rounds) ? (timing!.rounds as unknown[]) : []).map(rec).filter((r): r is Record<string, unknown> => r !== null);

  // The texts this turn answers, by the ids Door steps logged, in words from the chat.
  const doorStep = mine.find((e) => e.kind === "step" && e.step === "door");
  const covers = Array.isArray(rec(doorStep?.input)?.covers) ? (rec(doorStep!.input)!.covers as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const covered = covers.map((id) => textById(entries, id)).filter((x): x is string => !!x).join("\n");
  const sentTexts = mine.filter((e) => e.kind === "text" && rec(e.from)?.kind === "tex");

  // A text arriving: each text the turn covers, as it was kept.
  if (covered) {
    push("text", "Got", covered);
    push("text", "Gave", `Kept in the chat's record: ${covers.join(", ")}`);
  } else if (text) push("text", "Gave", "Kept in the chat's record");

  // Check-in, routine or ping: what started it and what it texted.
  for (const e of mine) {
    const start = startOf(e);
    if (!start) continue;
    push(start, "Got", str(e.routine) ? `Routine note ${str(e.routine)}` : str(e.about) || startedBy);
    push(start, "Gave", str(e.text) || "Nothing texted");
    if (str(e.outcome)) push(start, "Outcome", e.outcome);
  }

  // Queue: how long the turn waited for the chat's lane.
  if (covered) push("lanes", "Got", covered);
  const wait = num(timing?.waitMs);
  if (wait !== null) push("lanes", "Waited", wait ? `${secs(wait)} for the turn before it in this chat to finish` : "Nothing ahead of it: started straight away");

  // Door steps: what it gathered before any model ran, and what it handed the front door.
  const brief = mine.find((e) => e.kind === "brief");
  push("door", "Got", text);
  const gathered = (Array.isArray(timing?.steps) ? (timing!.steps as unknown[]) : [])
    .map(rec)
    .filter((s): s is Record<string, unknown> => s !== null && num(s.at) !== null && num(rounds[0]?.at) !== null && num(s.at)! < num(rounds[0].at)! && !str(s.name).startsWith("wait:"))
    .map((s) => `${str(s.name).replace(/_/g, " ")} · ${secs(num(s.ms) ?? 0)}`);
  if (gathered.length) push("door", "Gathered", gathered.join("\n"));
  if (brief) {
    const { v: _v, id: _id, at: _at, kind: _k, turn: _t, seq: _s, ...b } = brief;
    push("door", "Gave the front door (its brief)", b);
  }
  if (doorStep) {
    push("door", "Turn", doorStep.input);
    push("door", "Settings it set", doorStep.output);
  }
  const first = rounds.length ? roundLines(rounds[0], 0, null) : null;
  if (first?.mods) push("door", "Context modules it built, in prompt order", first.mods);

  // Front door: what it got, each round's prompt and tokens, what it thought and said.
  push("fd", "Got", text);
  let prev: string | null = null;
  rounds.forEach((r, i) => {
    const x = roundLines(r, i, prev);
    push("fd", x.head, x.body + (x.mods && x.mods !== prev ? "\n\nContext modules, in prompt order:\n" + x.mods : ""));
    prev = x.mods || prev;
  });
  const inputs = rec(rec(rounds[0]?.prompt)?.inputs);
  if (inputs) push("fd", "Built for", inputs);

  let review = 0;
  for (const e of mine) {
    if (e.kind === "thinking") push("fd", "Thought" + (num(e.ms) !== null ? ` · ${secs(num(e.ms)!)}` : ""), e.text);
    else if (e.kind === "said") push("fd", "Said", e.text);
    else if (e.kind === "tool" && (e.name === "ask_advisor" || e.name === "plan_big_ask")) {
      const node = e.name === "ask_advisor" ? "advisor" : "planner";
      push(node, "Got", e.args);
      push(node, "Gave" + (num(e.ms) !== null ? ` · ${secs(num(e.ms)!)}` : ""), e.result ?? "(no result kept)");
    } else if (e.kind === "tool") {
      const name = String(e.name ?? "tool");
      push("tools", `${name} · got`, e.args ?? "(no arguments)");
      push("tools", `${name} · gave` + (num(e.ms) !== null ? ` · ${secs(num(e.ms)!)}` : "") + (e.ok === false ? " · failed" : ""), e.result ?? e.error ?? "(its result wasn't kept)");
    }
    else if (e.kind === "judge" && e.by === "review") {
      if (str(e.model) && review === 0) push("reviewer", "Model", e.model);
      push("reviewer", `Round ${review + 1}: ${e.went ? "let it go" : "sent it back"}${num(e.ms) !== null ? ` · ${secs(num(e.ms)!)}` : ""}`, [e.draft || e.text ? "Draft: " + show(e.draft ?? e.text) : "", show(e.notice ?? e.reason ?? "")].filter(Boolean).join("\n"));
      review += 1;
    } else if (e.kind === "judge" && e.by === "code") push("checks", e.went === false ? "Sent back" : "Passed", [e.draft ? "Draft: " + show(e.draft) : "", show(e.notice ?? e.reason ?? "")].filter(Boolean).join("\n"));
    else if (e.kind === "advisor") {
      const node = e.check ? "jobcheck" : "advisor";
      push(node, "Got" + (str(e.jobTitle) ? ` · ${str(e.jobTitle)}` : ""), e.question);
      push(node, "Gave" + (num(e.ms) !== null ? ` · ${secs(num(e.ms)!)}` : ""), e.answer);
      if (str(e.thinking)) push(node, "Thought", e.thinking);
    } else if (e.kind === "mail_check") {
      push("mail", "Got", { to: e.to, subject: e.subject, ...(e.ref ? { ref: e.ref } : {}) });
      push("mail", "Gave", { verdict: e.verdict, why: e.why });
    } else if (e.kind === "job") {
      push("job", "Got", { job: e.job, title: e.title });
      push("job", "Gave · " + (str(e.state) || "state"), e.advice ?? e.result ?? e.state);
    }
    else if (e.kind === "step" && e.step === "decide") {
      const input = rec(e.input);
      push("decide", "Judged", judgedTexts(entries, input) || show(input));
      if (input) push("decide", "Asked with", { ...input, candidates: undefined, newest: undefined });
      push("decide", "Said" + (num(e.ms) !== null ? ` · ${secs(num(e.ms)!)}` : ""), rec(e.output) ? verdictWords(rec(e.output)!) + "\n" + show(e.output) : (e.cause ?? "no answer"));
      if (str(e.model)) push("decide", "Model", e.model);
    } else if (e.kind === "step" && e.step === "react") {
      const input = rec(e.input);
      push("react", "On", (input?.on && textById(entries, str(input.on))) || show(input));
      push("react", e.ok === false ? "Failed to send" : "Sent", rec(e.output)?.emoji ?? e.output);
    } else if (e.kind === "step" && e.step === "node" && str(e.name)) {
      // A node the config's graph runner ran: it logs every run itself, so this is what the node got and gave.
      const tag = [str(e.via), num(e.ms) !== null ? secs(num(e.ms)!) : "", e.ok === false ? "failed" : ""].filter(Boolean).join(" · ");
      push(str(e.name), "Got" + (tag ? ` · ${tag}` : ""), e.input ?? "(nothing went in)");
      push(str(e.name), e.ok === false ? "Failed" : "Gave", e.ok === false ? { reason: e.reason ?? "failed" } : e.output ?? "(nothing came out)");
    } else if (e.kind === "step" && nodeOfStep(e.step)) {
      // Every other step the same way: what it got, what it gave, the model it ran on, how long, and why when it says.
      const node = nodeOfStep(e.step)!;
      const tag = [str(e.name), num(e.ms) !== null ? secs(num(e.ms)!) : "", e.ok === false ? "failed" : ""].filter(Boolean).join(" · ");
      if (e.step !== "door") {
        push(node, "Got" + (tag ? ` · ${tag}` : ""), e.input ?? "(nothing logged going in)");
        push(node, e.ok === false ? "Failed" : "Gave", e.output ?? (e.reason ? { reason: e.reason } : "(nothing logged coming out)"));
      }
      if (str(e.model)) push(node, "Model", e.model);
    }
  }
  push("fd", "Answer", answer);
  if (answer) push("send", "Got", answer);
  if (sentTexts.length) for (const t of sentTexts) push("send", t.delivered === false ? "Not delivered" : "Sent", str(t.text) || show(t));
  else push("send", "Sent", answer || "(nothing: it stayed quiet)");
  return io;
}

/**
 * The judge's verdict on a group's text, kept by the gateway as a `judge` entry `by: "moment"` (no turn: it ran before
 * one), as a decide step of `turn`, so the canvas reads a group's judging like a 1:1's; a tapback it chose is React's.
 */
export function momentAsSteps(e: LedgerEntry, turn: string): LedgerEntry[] {
  const input = { ...(rec(e.input) ?? {}), newest: str(e.event) || undefined, running: e.running === true || undefined };
  const output = { verdict: e.verdict, why: e.why, confidence: e.confidence, ...(e.emoji ? { emoji: e.emoji } : {}), ...(e.midTurn ? { midTurn: e.midTurn } : {}), ...(e.covers ? { covers: e.covers } : {}) };
  const out: LedgerEntry[] = [{ id: e.id + ":decide", at: e.at, kind: "step", turn, step: "decide", of: e.running ? "running" : "waiting", ok: true, ...(num(e.ms) !== null ? { ms: num(e.ms)! } : {}), input, output, model: e.model }];
  if (e.verdict === "react" && e.emoji) out.push({ id: e.id + ":react", at: e.at, kind: "step", turn, step: "react", ok: true, input: { on: str(e.event) }, output: { emoji: e.emoji } });
  return out;
}

/**
 * The test chat as Messages shows it (Dev, 2026-11-24, approved artboards 03 to 08 of `group-chat-sim-artboards/`):
 * the gateway's rows turned into what the Chat view draws, top to bottom. Time lines between sections; centered event
 * lines for who joined or left and for Undo Send; runs of bubbles from one sender (the name over the first, the
 * avatar and tail by the last); an edit shown on the text it edits; tapbacks and inline replies on their bubbles; Tex
 * typing while a turn runs; and under each person's text the why line, from the same steps the Grid shows: whether
 * Tex answered or stayed quiet, the step that decided (Triage or Decide), and its reason.
 *
 * Tex's quiet turns have no bubble: the why line is where a stay-quiet shows. Every entry has a `t`, so later kinds
 * (polls, renames, app cards) slot in as new entries. Pure: no React, no gateway.
 */
import type { SandboxRow, SandboxStep } from "../../../engine/sandbox";
import { changeWords, groupOf, type GroupAnswer, type Seg, type WorldPerson } from "./worldModel";

export type WhyStep = { step: "Triage" | "Decide"; out: string; ms: number | null; why: string };
/** Tex's decision on one text: answers (`yes`), stays quiet, or still deciding (`yes: null`). */
export type Why = { yes: boolean | null; running: boolean; reason: string; by: "Triage" | "Decide" | null; steps: WhyStep[] };

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A step's output as an object: sent as JSON, JSON in text, or "key: value" words. */
export function stepOut(s: SandboxStep | undefined): Record<string, unknown> {
  if (!s) return {};
  const d = rec(s.data);
  if (d) return d;
  const t = (s.out ?? "").trim();
  if (t.startsWith("{")) {
    try {
      return rec(JSON.parse(t)) ?? {};
    } catch {
      return {};
    }
  }
  const o: Record<string, unknown> = {};
  for (const m of t.matchAll(/(\w+):\s*([^,·]+)/g)) o[m[1]] = m[2].trim();
  return o;
}

const TRIAGE_TO: Record<string, string> = { judge: "to Decide", tex: "to Tex", running: "beside the turn running" };
const VERDICT: Record<string, string> = { respond: "answer", answer: "answer", quiet: "nothing", silent: "nothing", react: "tapback", wait: "wait" };

/**
 * Tex's decision on a person's text, from its steps and the reply rows that answer it (`reply` = its id). Null for a
 * text that never ran (one the chat started from).
 */
export function whyOf(row: SandboxRow, replies: SandboxRow[], running: boolean): Why | null {
  const steps = row.steps ?? [];
  if (!steps.length && !replies.length && !running) return null;
  const tri = steps.find((s) => s.node === "triage");
  const dec = steps.find((s) => s.node === "decide");
  const t = stepOut(tri);
  const d = stepOut(dec);
  const verdict = String(d.verdict ?? d.act ?? "");
  const said = replies.some((r) => !r.quiet && (!!r.text || !!r.pics?.length));
  const yes = said ? true : running ? (VERDICT[verdict] === "answer" || t.to === "tex" ? true : null) : false;
  const by = dec && dec.ms !== null ? "Decide" : tri ? "Triage" : null;
  const why = String((by === "Decide" ? d.why : t.why) ?? t.why ?? "").trim();
  const reason = (why || (yes === null ? "reading it" : yes ? "Tex answered" : "nothing for Tex to add")) + (running && yes !== null ? "; running now" : "");
  const out: WhyStep[] = [];
  if (tri) out.push({ step: "Triage", out: TRIAGE_TO[String(t.to)] ?? String(t.to ?? tri.out ?? ""), ms: tri.ms, why: String(t.why ?? "") });
  if (dec) out.push({ step: "Decide", out: VERDICT[verdict] ?? (verdict || dec.out), ms: dec.ms, why: String(d.why ?? "") });
  return { yes, running, reason, by, steps: out };
}

export type Bubble = {
  /** The row it shows (a Tex reply's split into its parts: `<id>~<n>`). */
  id: string;
  row: SandboxRow;
  kind: "text" | "pics" | "media" | "typing";
  text: string;
  pics?: string[];
  media?: Record<string, unknown>;
  edited?: boolean;
  reactions?: Array<{ who: string; emoji: string }>;
  quote?: { who: string; text: string };
  why?: Why;
  status?: string;
  note?: string;
};
export type ChatEntry =
  | { t: "time"; key: string; day: string | null; time: string }
  | { t: "event"; key: string; id: string; text: string; change?: Seg[] | null; row: SandboxRow }
  | { t: "run"; key: string; who: string; tex: boolean; side: "in" | "out"; items: Bubble[] };

/** A time line's words: the day when it changes ("Today", "Yesterday", "Mon, Nov 23"), and the time. */
export function timeWords(at: number, now: number, lastDay: string | null): { day: string | null; time: string; dayKey: string } {
  const d = new Date(at);
  const dayKey = d.toDateString();
  const n = new Date(now);
  const y = new Date(now - 86_400_000);
  const day = dayKey === n.toDateString() ? "Today" : dayKey === y.toDateString() ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return { day: dayKey === lastDay ? null : day, time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), dayKey };
}

const GAP = 15 * 60_000;
const lower = (s: string) => s.toLowerCase();

/** Who is in a made-up chat after its people rows, from who it opened with and everyone who joined since. */
export function peopleAfter(opened: WorldPerson[], known: Record<string, WorldPerson>, rows: SandboxRow[]): WorldPerson[] {
  let here = [...opened];
  for (const r of rows) {
    if (r.kind !== "people" || !r.name) continue;
    if (r.change === "left") here = here.filter((p) => lower(p.name) !== lower(r.name!));
    else if (!here.some((p) => lower(p.name) === lower(r.name!))) here = [...here, known[lower(r.name)] ?? { name: r.name, account: "off" }];
  }
  return here;
}

/** The newest group answer in the rows (the latest reply that carries one). */
export function lastGroup(rows: SandboxRow[]): GroupAnswer | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].kind === "people") return null; // a change since: the next text asks again
    const g = groupOf(rows[i].group);
    if (g && g.status !== null) return g; // a turn's failure alone says nothing of what the chat can see
  }
  return null;
}

/** The line a people row shows: "Delta added Sam to the conversation." */
export const eventWords = (r: SandboxRow) => {
  const t = r.text.trim().replace(/\.$/, "");
  return r.change === "added" && !/conversation$/.test(t) ? `${t} to the conversation.` : `${t}.`;
};

export type ChatOpts = {
  /** Who you're texting as: their bubbles are blue, on the right. */
  as: string;
  running: string | null;
  /** The step running now, in words ("Front door"). */
  hotWords?: string | null;
  now: number;
  /** A made-up chat's people as it opened and everyone known, to say what a join or leave changes. */
  world?: { opened: WorldPerson[]; known: Record<string, WorldPerson>; guest?: (name: string) => string | undefined } | null;
};

/** The rows as the Chat view draws them, in order. */
export function chatEntries(rows: SandboxRow[], o: ChatOpts): ChatEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const replies = new Map<string, SandboxRow[]>();
  const edits = new Map<string, string>();
  for (const r of rows) {
    if (r.tex && r.reply) replies.set(r.reply, [...(replies.get(r.reply) ?? []), r]);
    if (r.kind === "edit" && r.on) edits.set(r.on, r.text);
  }
  const out: ChatEntry[] = [];
  let lastAt: number | null = null;
  let lastDay: string | null = null;
  let crossed = false;
  const seen: SandboxRow[] = [];
  // A bubble joins the run above it when the same person sent it and nothing came between.
  const push = (who: string, tex: boolean, b: Bubble, fresh = false) => {
    const last = out[out.length - 1];
    if (last?.t === "run" && last.who === who && !fresh) last.items.push(b);
    else out.push({ t: "run", key: "r" + b.id, who, tex, side: !tex && who === o.as ? "out" : "in", items: [b] });
  };
  for (const r of rows) {
    seen.push(r);
    if (r.kind === "reaction" || r.kind === "edit" || r.unsent || (r.tex && r.quiet)) continue;
    if (typeof r.at === "number" && (lastAt === null || r.at - lastAt >= GAP)) {
      const w = timeWords(r.at, o.now, lastDay);
      lastDay = w.dayKey;
      out.push({ t: "time", key: "t" + r.id, day: w.day, time: w.time });
    }
    if (typeof r.at === "number") lastAt = r.at;
    if (!r.prod && !crossed && seen.some((x) => x.prod)) {
      out.push({ t: "event", key: "x" + r.id, id: "", text: "Test from here · writes stay in the test chat", row: r });
    }
    if (!r.prod) crossed = true;
    if (r.kind === "unsend") {
      const who = byId.get(r.on ?? "")?.who ?? r.who;
      out.push({ t: "event", key: "e" + r.id, id: r.id, text: `${who} unsent a message.`, row: r });
      continue;
    }
    if (r.kind === "people") {
      const w = o.world;
      const before = w ? peopleAfter(w.opened, w.known, seen.slice(0, -1)) : [];
      const after = w ? peopleAfter(w.opened, w.known, seen) : [];
      const who = w ? (w.known[lower(r.name ?? "")] ?? null) : null;
      out.push({ t: "event", key: "e" + r.id, id: r.id, text: eventWords(r), change: w && r.change ? changeWords(before, after, who, r.change, w.guest?.(r.name ?? "")) : null, row: r });
      continue;
    }
    const tex = !!r.tex;
    const q = r.replyTo ? byId.get(r.replyTo) : undefined;
    const quote = q ? { who: q.tex ? "Tex" : q.who, text: edits.get(q.id) ?? q.text } : undefined;
    const why = tex ? null : whyOf(r, replies.get(r.id) ?? [], o.running === r.id);
    const base = { row: r, reactions: r.reactions, edited: r.edited || edits.has(r.id) };
    const items: Bubble[] = [];
    const text = edits.get(r.id) ?? r.text;
    const parts = tex ? text.split(/\n{2,}/).filter((x) => x.trim()) : text ? [text] : [];
    parts.forEach((x, i) => items.push({ ...base, id: i ? `${r.id}~${i}` : r.id, kind: "text", text: x }));
    // A person's photo or card comes before their caption; Tex's after its words.
    const att: Bubble[] = [];
    if (r.pics?.length) att.push({ ...base, id: r.id + "~p", kind: "pics", text: "", pics: r.pics });
    if (r.media) att.push({ ...base, id: r.id + "~m", kind: "media", text: "", media: r.media });
    items.splice(tex ? parts.length : 0, 0, ...att);
    if (!items.length) continue;
    // Tapbacks, Edited and the why line go on the text's last bubble; a quote on its first.
    items.forEach((b, i) => {
      if (i < items.length - 1) Object.assign(b, { reactions: undefined, edited: false });
    });
    if (quote) items[0].quote = quote;
    if (why) items[items.length - 1].why = why;
    items.forEach((b, i) => push(tex ? "Tex" : r.who, tex, b, i === 0 && !!quote));
    if (o.running === r.id && !(replies.get(r.id) ?? []).some((x) => !x.quiet && x.text)) {
      push("Tex", true, { id: r.id + "~typing", row: r, kind: "typing", text: "", note: o.hotWords ?? undefined }, true);
    }
  }
  // "Delivered" under the newest bubble of yours, when it is the newest text of all.
  const last = out[out.length - 1];
  if (last?.t === "run" && last.side === "out") last.items[last.items.length - 1].status = "Delivered";
  return out;
}

/**
 * The words the Tex page puts beside its numbers. Pure, so the tests pin the
 * mock's wording ("Working on 2 jobs · 1 needs you", "Helped twice today").
 */

import type { Behind, ChatRef, JobSummary, Mood, Overview, Tiles, Turn, TurnAction } from "./texPageTypes";

/** `6:05`, or `9:20 am` before noon: the page's clock, in the viewer's own time. */
export function clock(at: number, now: Date = new Date()): string {
  const d = new Date(at);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const t = `${h % 12 === 0 ? 12 : h % 12}:${m}${h < 12 ? " am" : ""}`;
  if (sameDay(d, now)) return t;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${t}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `Oct 24`, or `today`. */
export function day(at: number, now: Date = new Date()): string {
  const d = new Date(at);
  return sameDay(d, now) ? "today" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `3.8 s`, `0.5 s`, `12 s`. */
export function seconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
}

/** `1 min`, `3 min`, `2 h`: how long a job has run. */
export function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${Math.max(1, min)} min`;
  return `${Math.round(min / 60)} h`;
}

/** `6 minutes`, `1 minute`, `2 hours`: how long a finished job took. */
export function took(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  return `${h} hour${h === 1 ? "" : "s"}`;
}

/** `20 min ago`, `2 h ago`, `just now`. */
export function ago(at: number, now: number = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function isGroup(chat: ChatRef): boolean {
  return chat.key !== "me";
}

/** `Tex`, or `Tex in Team Night`. */
export function heading(chat: ChatRef): string {
  return isGroup(chat) ? `Tex in ${chat.name}` : "Tex";
}

/** `Working on 2 jobs · 1 needs you`; a group: `5 people · working on 1 job`. */
export function statusLine(o: Pick<Overview, "chat" | "status">): string {
  const { jobs, needsYou } = o.status;
  const work = jobs === 0 ? (isGroup(o.chat) ? "nothing running" : "nothing running right now") : `working on ${plural(jobs, "job")}`;
  const parts: string[] = [];
  if (isGroup(o.chat)) {
    if (o.chat.people !== undefined) parts.push(plural(o.chat.people, "person", "people"));
    parts.push(work);
  } else {
    parts.push(work.charAt(0).toUpperCase() + work.slice(1));
  }
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? "s" : ""} you`);
  return parts.join(" · ");
}

export function busyLine(slots: Overview["minions"], places?: Overview["places"]): string {
  // An offline machine's free slots can take nothing, so they are not counted as room; its jobs, if any, still are.
  const off = new Set((places ?? []).filter((p) => p.offline).map((p) => p.key));
  const counted = slots.filter((s) => s.job !== null || s.place === undefined || !off.has(s.place));
  return `Minions · ${counted.filter((s) => s.job !== null).length} of ${counted.length} busy`;
}

/** The figure a job is drawn with. */
export function moodOf(job: JobSummary | null): Mood {
  if (job === null) return "rest";
  if (job.state === "waiting") return "stuck";
  if (job.state === "running") return "busy";
  if (job.state === "failed") return "wild";
  return "calm";
}

/** The line under a running job: `1 min · 3 steps didn't work`, `Needs your sign-in code`, `For Ada · Claude Code · 3 min`. */
export function slotLine(job: JobSummary, now: number = Date.now()): { text: string; failed?: string; warn?: boolean } {
  if (job.state === "waiting" && job.needs) return { text: job.needs, warn: true };
  const parts = [job.for ? `For ${job.for}` : null, job.tool ?? null, span(now - job.startedAt)].filter((x): x is string => x !== null);
  return {
    text: parts.join(" · "),
    ...(job.failedSteps > 0 ? { failed: `${plural(job.failedSteps, "step")} didn't work` } : {}),
  };
}

const ENDED: Record<JobSummary["state"], string> = {
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Didn't finish",
  stopped: "Stopped",
};

/** `Done · 20 min ago ›` */
export function endedLine(job: JobSummary, now: number = Date.now()): string {
  return `${ENDED[job.state]} · ${ago(job.endedAt ?? job.startedAt, now)} ›`;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

export function advisorLine(b: Behind["advisor"]): string {
  if (b.today === 0) return "Not needed today";
  return `Helped ${times(b.today)} today${b.last ? ` · last: ${b.last}` : ""}`;
}

export function mailcheckLine(b: Behind["mailcheck"]): string {
  const { today, waiting } = b;
  if (today === 0 && waiting === 0) return "No emails today";
  if (today === 0) return `${plural(waiting, "email")} waiting for your yes`;
  return `Checked ${plural(today, "email")} today${waiting > 0 ? ` · ${waiting} waiting for your yes` : ""}`;
}

/** The five shortcut tiles' second lines. */
export function tileLines(
  t: Tiles,
  group: boolean,
  now: Date = new Date(),
): Record<"routines" | "checkins" | "about" | "computer" | "settings", string> {
  const host = t.computer.url ? hostOf(t.computer.url) : "";
  const words = (next: string | number) => (typeof next === "number" ? clock(next, now) : next);
  return {
    routines: t.routines.on === 0 ? "None on" : `${t.routines.on} on${t.routines.next !== undefined ? ` · ${group ? "" : "next "}${words(t.routines.next)}` : ""}`,
    checkins: t.checkins.next !== undefined ? `Next ${words(t.checkins.next)}` : "None set",
    about:
      t.about.newToday > 0 ? `${t.about.newToday} new today` : t.about.count > 0 ? `${plural(t.about.count, "thing")}` : "Nothing yet",
    computer: !t.computer.running ? "Not running" : group && host ? `On ${host} · live` : "Live",
    settings: t.settings.summary || (group ? "Answers when named" : "Default"),
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The link word inside an action's label, so `Started Minion 2` draws `Minion 2 ›` as a link. */
const LINK_WORDS: Record<TurnAction["kind"], RegExp | null> = {
  advisor: /Advisor/,
  job: /Minion \d/,
  mailcheck: /Email check/,
  tool: null,
};

export interface ActionPiece {
  before: string;
  link?: string;
  after: string;
}

export function actionPieces(action: TurnAction): ActionPiece {
  const word = LINK_WORDS[action.kind];
  const m = word ? action.label.match(word) : null;
  if (!m || m.index === undefined || (action.kind !== "advisor" && action.kind !== "mailcheck" && !action.ref)) {
    return { before: action.label, after: "" };
  }
  return {
    before: action.label.slice(0, m.index),
    link: m[0],
    after: action.label.slice(m.index + m[0].length),
  };
}

/** `6:05 · You: "is maritime worth switching to?"` */
export function turnHead(turn: Turn, now?: Date): string {
  return `${clock(turn.at, now)} · ${turn.who || "Someone"}: “${turn.said}”`;
}

/** The tail after the actions: `replied "…" · 3.8 s`, or `Stayed quiet · 0.5 s`. */
export function turnTail(turn: Turn): string[] {
  const out: string[] = [];
  if (turn.reply !== null) out.push(`replied “${turn.reply}”`);
  else if (turn.did.length === 0) out.push("Stayed quiet");
  out.push(seconds(turn.ms));
  return out;
}

export const VERDICT_LABEL = { sent: "Sent", waiting: "Waiting for your yes", stopped: "Stopped" } as const;

/** Whether a job's own words name the site the browser is on, so its page never shows another job's browser. */
export function onSite(job: { title: string; now?: string; steps: { text: string }[] }, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return [job.title, job.now ?? "", ...job.steps.map((s) => s.text)].some((t) => t.toLowerCase().includes(host));
}

/** A check-in's time as its form edits it, `2026-11-03 18:30`, in the viewer's own time: the form the gateway takes. */
export function whenField(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Is this a time the gateway takes for a check-in (`YYYY-MM-DD HH:MM`). */
export function isWhenField(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(v.trim());
}

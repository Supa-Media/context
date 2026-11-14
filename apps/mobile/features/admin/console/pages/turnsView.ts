/**
 * The Turns page's HTML, the artifact's `P.turns` and `P.turns.props` drawn from the real data:
 * `consoleAi.turns` (the turns, their speed, trouble and hand-backs) and `texStats.report` (the
 * texts received, when the texting counts are configured). Pure: the page module (`Turns.web.tsx`)
 * fetches, this file draws. Every value from the database goes through `esc`.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { delta, esc, ic, kpi, legend, lines, panel, pill, REPLAY, seg } from "../kit";
import { S, WIN } from "../state";

/** How long agentTurns keeps a turn: a longer window would only draw empty days. */
export const TURNS_KEPT_DAYS = 30;
/** The days the turns query reads: the window, clamped to the days turns are kept. */
export const turnsDays = (d: string): 1 | 7 | 30 => (d === "1" ? 1 : d === "7" ? 7 : 30);
/** The window's label for the turns, which never reach past the days they are kept. */
const turnsWin = (d: string): string => (Number(d) > TURNS_KEPT_DAYS ? WIN["30"] : WIN[d]);

type ConsoleTurns = FunctionReturnType<typeof api.functions.consoleAi.turns>;
type TextCounts = FunctionReturnType<typeof api.functions.texStats.report>;
type Recent = ConsoleTurns["recent"][number];

/** `undefined` turns is the loading state; `texts` is null until the texting counts answer, or when they are not configured. */
export type TurnsData = { turns: ConsoleTurns | undefined; texts: TextCounts | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const round1 = (n: number) => Math.round(n * 10) / 10;
const secs = (ms: number) => (ms / 1000).toFixed(1);
const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** Local HH:MM for today, else "Nov 12 14:02". */
export function whenOf(at: number, now: number = Date.now()): string {
  const t = new Date(at);
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return t.toDateString() === new Date(now).toDateString() ? hm : `${MONTHS[t.getMonth()]} ${t.getDate()} ${hm}`;
}

/** The model's name from its id: haiku, opus or sonnet; else the id after the last slash. */
export function modelOf(id: string): string {
  const m = id.toLowerCase();
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  return id.slice(id.lastIndexOf("/") + 1) || id;
}

const ENDED: Record<Recent["outcome"], [string, string]> = {
  answered: ["Answered", "ok"],
  exhausted: ["Ran out of steps", "warn"],
  failed: ["Failed", "bad"],
};
const endedPill = (outcome: Recent["outcome"]) => pill(ENDED[outcome][0], ENDED[outcome][1]);

export const toolsRow = () =>
  `<div class="tools">${seg("Ended", [["all", "Any ending"], ["trouble", "Didn't finish"]], S.f.end, "end")}<input class="search" id="q" placeholder="Person or @workspace" value="${esc(S.q)}" data-act="q"></div>`;

/** One of the four targets: a null value draws "—" and an empty meter. */
function target(label: string, value: string | null, n: number | null, t: number, tl: string, hi: boolean): string {
  const okk = n == null ? true : hi ? n >= t : n < t;
  const mx = hi ? 100 : t * 2;
  const w = n == null ? 0 : Math.min(100, (n / mx) * 100);
  const color = n == null ? "track" : okk ? "ok" : "bad";
  return `<div class="g"><div class="l">${label}</div><div class="v ${okk || n == null ? "" : "dn"}">${value ?? "—"}</div><div class="sub">target ${tl}</div><div class="meter"><i style="width:${w}%;background:var(--${color})"></i><b style="left:${(t / mx) * 100}%"></b></div></div>`;
}

function hurtTargets(turns: ConsoleTurns, texts: TextCounts | null): string {
  const inbound = texts && texts.configured ? texts.texts.inOne : 0;
  const answered = texts && texts.configured && inbound > 0 ? Math.round((turns.answeredOne / inbound) * 100) : null;
  const handed = turns.hurt.handedBackShare == null ? null : Math.round(turns.hurt.handedBackShare * 100);
  const troubled = turns.hurt.troubledShare == null ? null : Math.round(turns.hurt.troubledShare * 100);
  const slow = turns.turns ? turns.hurt.p95Ms / 1000 : null;
  return (
    `<div class="tgt">` +
    target("Answered 1:1 texts", answered == null ? null : `${answered}%`, answered, 95, "≥ 95%", true) +
    target("Handed back to them", handed == null ? null : `${handed}%`, handed, 15, "< 15%", false) +
    target("Slowest 1 in 20", slow == null ? null : `${slow.toFixed(1)} s`, slow, 60, "< 60 s", false) +
    target("Troubled chats", troubled == null ? null : `${troubled}%`, troubled, 5, "< 5%", false) +
    `</div>`
  );
}

/** The page's HTML; `undefined` data is the loading state. */
export function turnsRender(d: TurnsData | undefined): string {
  const t = d?.turns;
  if (!t) return toolsRow() + `<div class="empty">Loading…</div>`;
  const texts = d?.texts ?? null;
  const trouble = S.f.end === "trouble";
  const didnt = t.exhausted + t.failed;
  const asked = texts && texts.configured ? texts.texts.inOne + texts.texts.inGroup : null;
  const typical = t.turns ? `${secs(t.p50Ms)} s` : "—";
  const vsBefore = t.priorP50Ms == null ? "" : delta(round1((t.p50Ms - t.priorP50Ms) / 1000), false, " s") + " vs before";

  const series = (k: "p50" | "p95") => t.series.map((s) => round1(s[k] / 1000));
  const chart = lines(
    [
      { v: series("p95"), c: "c4" },
      { v: series("p50"), c: "c1", area: true },
    ],
    { fmt: (v) => v + " s" },
  );

  const total = t.where.modelMs + t.where.toolMs + t.where.otherMs;
  const share = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const [think, tools, other] = [share(t.where.modelMs), share(t.where.toolMs), share(t.where.otherMs)];

  const rows =
    t.recent
      .map(
        (r) =>
          `<tr class="click" tabindex="0" data-act="sel" data-id="${esc(r.id)}" aria-selected="${S.x === r.id}"><td>${whenOf(r.at)}</td><td>${esc(r.person ?? "Someone")}${r.workspace ? ` <span class="sub hp">@${esc(r.workspace)}</span>` : ""}</td><td class="hp">${r.group ? "Group" : "1:1"}</td><td class="hp">${esc(modelOf(r.model))}</td><td>${endedPill(r.outcome)}</td><td class="r hp">${r.rounds}</td><td class="r">${secs(r.ms)} s</td></tr>`,
      )
      .join("") || `<tr><td colspan="7" class="empty">No turns match</td></tr>`;

  return (
    toolsRow() +
    `<div class="kpis">${kpi("Typical answer", typical, vsBefore)}${kpi("Turns", t.answered, texts && texts.configured ? `answers to ${asked} texts` : `in ${turnsWin(S.d)}`)}${kpi("Didn't finish", didnt, `${t.exhausted} out of steps · ${t.failed} failed`, `data-act="end" data-v="${trouble ? "all" : "trouble"}" aria-pressed="${trouble}"`)}</div>` +
    (Number(S.d) > TURNS_KEPT_DAYS ? `<div class="banner"><span class="tx">Turns are kept ${TURNS_KEPT_DAYS} days, so this shows the last ${TURNS_KEPT_DAYS}.</span></div>` : "") +
    (t.truncated ? `<div class="banner warn"><span class="tx">More turns than one read holds: these figures cover the newest ones.</span></div>` : "") +
    panel("t-hurt", "Where Tex hurts", "against targets", hurtTargets(t, texts)) +
    panel("t-chart", "Answer time", "per " + (S.d === "1" ? "hour" : "day"), chart + legend("turns", [["c1", "Typical"], ["c4", "Slowest 1 in 20"]])) +
    `<div class="grid2">` +
    panel(
      "t-where",
      "Where the time goes",
      "",
      `<div class="share"><i style="width:${think}%;background:var(--c1)"></i><i style="width:${tools}%;background:var(--c2)"></i><i style="width:${other}%;background:var(--c6)"></i></div>` +
        legend("where", [["c1", `Thinking ${think}%`], ["c2", `Tools ${tools}%`], ["c6", `Other ${other}%`]]),
      `<a href="https://context.lc/lab" target="_blank" rel="noopener" class="link">Per tool in the Lab ↗</a>`,
    ) +
    `</div>` +
    panel(
      "t-recent",
      "Recent turns",
      trouble ? `latest ${t.recent.length} of ${didnt}` : `latest ${t.recent.length}`,
      `<div class="tbl"><table><tr><th>When</th><th>Who</th><th class="hp">Chat</th><th class="hp">Model</th><th>Ended</th><th class="r hp">Steps</th><th class="r">Time</th></tr>${rows}</table></div>`,
    )
  );
}

export type Segment = { label: string; ms: number; c: string };

/** The turn's time, end to end: the queue, then each step of the trace in order. */
export function segmentsOf(r: Recent): Segment[] {
  const out: Segment[] = [];
  if (r.waitMs) out.push({ label: "Queue", ms: r.waitMs, c: "c6" });
  let round = 0;
  // The last model round of an answered turn wrote the reply: the artifact calls it Reply.
  const lastModel = r.outcome === "answered" ? r.trace.map((s) => s.kind).lastIndexOf("model") : -1;
  r.trace.forEach((s, i) => {
    let label: string;
    let c: string;
    if (s.kind === "model") {
      round += 1;
      label = i === lastModel && round > 1 ? "Reply" : `Round ${round}`;
      c = "c1";
    } else if (s.kind === "tool") {
      label = [capital(s.tool ?? "Tool"), s.action].filter(Boolean).join(" · ");
      c = "c4";
    } else if (s.kind === "router") {
      // The router step is the artifact's "Decide" (Clef picks the path), drawn in its colour.
      label = "Decide";
      c = "c2";
    } else {
      label = "Fallback";
      c = "c3";
    }
    out.push({ label: s.ok ? label : `${label} ✕`, ms: s.ms, c });
  });
  return out;
}

/** The side panel for one recent turn, or null when it is not in the list. */
export function turnsProps(d: TurnsData | undefined, id: string): string | null {
  const r = d?.turns?.recent.find((x) => x.id === id);
  if (!r) return null;
  const segs = segmentsOf(r);
  const sum = segs.reduce((a, s) => a + s.ms, 0);
  const scale = Math.max(sum, r.ms, 1);
  let slow = -1;
  segs.forEach((s, i) => {
    if (s.ms > 0 && (slow < 0 || s.ms > segs[slow].ms)) slow = i;
  });
  let at = 0;
  const bars = segs
    .map((s, i) => {
      const left = (at / scale) * 100;
      const width = Math.max(1.5, (s.ms / scale) * 100);
      at += s.ms;
      return `<div class="r${i === slow ? " slow" : ""}"><span>${esc(s.label)}</span><span class="tr"><span class="bb" style="left:${left}%;width:${width}%;background:var(--${s.c})"></span></span><span class="t">${secs(s.ms)}s</span></div>`;
    })
    .join("");
  return (
    `<div class="pph"><h3 tabindex="-1">${esc(r.person ?? "Someone")} · ${whenOf(r.at)}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>` +
    `<div class="kv"><span class="k">Chat</span><span class="v">${r.group ? "Group chat" : "1:1 text"}</span><span class="k">Model</span><span class="v">${esc(modelOf(r.model))}</span><span class="k">Ended</span><span class="v">${endedPill(r.outcome)}</span><span class="k">Tokens</span><span class="v">${(r.inputTokens / 1000).toFixed(1)}k in · ${(r.outputTokens / 1000).toFixed(1)}k out</span></div>` +
    `<div class="ppb"><div class="h">Step by step · ${secs(r.ms)} s</div><div class="wf">${bars}</div></div>` +
    REPLAY
  );
}

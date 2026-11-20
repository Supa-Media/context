/**
 * The test chat's playback (Dev2, 2026-11-16: "we should have 1 play button, and be smart about if anything changed and
 * we can just replay what we already did, or if something changed and we need fresh answers"). A text keeps the
 * version it ran on; while that version is unchanged ▶ plays back the steps it logged on the canvas, at their logged
 * times and with no model call, and once anything that runs has changed ▶ runs the text again on live models.
 * Clicking a step's cell lights the canvas up to that step.
 *
 * Lab live sandbox (approved by Dev2 2026-11-16, mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): every
 * playback is a `PlayRun` (`sandboxRun.ts`) played at `lab.speed`; a text you send plays from its first step at once,
 * trailing the live run and never past what has happened; ▶ on one of Tex's texts plays only the steps that led to it.
 * The dock shows the texts as a grid or the run on the head as a timeline (`view`). While no step is pinned, the node
 * panel follows the step running at the head (`lab.sel`).
 */
import { useSyncExternalStore } from "react";
import { lab, set as setLab } from "./state";
import { isLive, live } from "./live";
import { onSandboxText, retryText, sandbox, type SandboxRow } from "./sandbox";
import type { PlayRun } from "./playRun";
import type { ProdPlay } from "./prodRun";
import { litAt, runById, runStart, stepsAt } from "./sandboxRun";
import { timeMap } from "./timeMap";
import type { LabGraph } from "../types";
import type { Lit } from "../views/canvas/usePlayback";

/**
 * What a test turn runs: the version as saved, which the gateway reads afresh for every turn. For a live draft that is
 * the graph the server confirmed (`live.synced`) with where each step is drawn left out; otherwise its id and saved
 * revision. Never the canvas as drawn: a focus folding groups, a step moved or an edit not saved yet changes nothing a
 * turn would run.
 */
const prints = new WeakMap<LabGraph, string>();
export function versionPrint(): string {
  const g = isLive() ? live.synced : null;
  if (!g) return lab.cur.id + ":" + (lab.cur.rev ?? 0);
  let p = prints.get(g);
  if (p === undefined) {
    p = lab.cur.id + ":" + JSON.stringify({ ...g, nodes: g.nodes.map(({ x: _x, y: _y, ...n }) => n) });
    prints.set(g, p);
  }
  return p;
}

/** Each test text's version print when it ran; a text the Lab didn't see run takes the print it was first seen with. */
const ranOn = new Map<string, string>();
export function noteRan(rows: SandboxRow[]) {
  const now = versionPrint();
  for (const r of rows) if (r.steps?.length && !ranOn.has(r.id)) ranOn.set(r.id, now);
}
export const isStale = (msgId: string) => {
  const p = ranOn.get(msgId);
  return !!p && p !== versionPrint();
};

/**
 * The run at the head: its id (`<rowId>` or `<rowId>#<texRowId>`), the text it is of (`msgId`, the step panel's
 * `stepRunNow.ts` reads it), the head's time from the text's arrival, and whether it plays.
 */
type Play = { id: string; msgId: string; t: number; playing: boolean } | null;
const msgOf = (id: string) => id.split("#")[0];
type Pick = { msgId: string; upto: string | null } | null;
export type DockView = "grid" | "timeline";
let play: Play = null;
let pick: Pick = null;
let view: DockView = "grid";
let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
const subs = new Set<() => void>();
let ver = 0;
const emit = () => {
  ver++;
  subs.forEach((f) => f());
};
export function usePlay(): { play: Play; pick: Pick; view: DockView } {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ver,
    () => ver,
  );
  return { play, pick, view };
}

const TICK = 50;
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Runs played from outside the test chat's own rows: a real text as production logged it (`views/mine/playProd.ts`,
 * on the graph Tex had then), with what the panel reads of it (the prompts and background jobs).
 */
const ext = new Map<string, { run: PlayRun; prod?: ProdPlay }>();

/** A run by its id, as it stands now: a real text's as read, else a test text's (a running one grows by the clock). */
export function runOf(id: string): PlayRun | null {
  return ext.get(id)?.run ?? runById(id, sandbox.rows, { running: sandbox.running, hot: sandbox.hot, now: Date.now() });
}

/** ▶ on a real text: its run, read from production's log, played on the Timeline like any other. */
export function playExternal(run: PlayRun, prod?: ProdPlay) {
  ext.set(run.id, { run, ...(prod ? { prod } : {}) });
  if (play?.id === run.id && play.playing) return togglePlay();
  view = "timeline";
  playRun(run.id);
}
/** The runs played from production's log, for the timeline's picker. */
export const externalRuns = (): PlayRun[] => [...ext.values()].map((x) => x.run);
/** Whether a run id is a real text read from production's log (or the steps behind one of its Tex texts). */
export const isExternal = (id: string) => ext.has(id);
/** What production logged around the run at the head, when it is a real text's: its prompts and background jobs. */
export const playingProd = (): ProdPlay | null => (play ? (ext.get(play.id)?.prod ?? null) : null);

/** The node panel follows the step running at the head, unless a step is pinned. */
function follow(r: PlayRun, t: number) {
  if (lab.pin) return;
  const at = litAt(r, t).running;
  if (at && !(lab.sel?.t === "node" && lab.sel.id === at)) setLab({ sel: { t: "node", id: at } });
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}
function tick(step?: number) {
  if (!play?.playing) return stopTimer();
  const r = runOf(play.id);
  if (!r) {
    stopTimer();
    play = { ...play, playing: false };
    return emit();
  }
  const now = clock();
  // A test step is exact. A live tick is the wall time since the last one: `setInterval` passes no argument in a
  // browser, and anything that is not a number is ignored so a stray argument cannot become the step.
  const dt = typeof step === "number" ? step : Math.max(0, now - last);
  last = now;
  // Never past what has happened: a running text's total is how long it has run. A finished run plays in the
  // timeline's drawn time, so a long stretch where nothing ran passes in a moment (engine/timeMap.ts).
  const map = timeMap(r, play.t, !!r.running && !r.of);
  const t = Math.min(r.total, map.real(map.drawn(play.t) + dt * lab.speed));
  const done = t >= r.total && !r.running;
  play = { ...play, t, playing: !done };
  follow(r, t);
  if (done) stopTimer();
  emit();
}
let held = false;
/** For tests: the playback clock held still, so a page test isn't re-rendering the whole Lab every tick. */
export function holdPlayClock(hold: boolean) {
  held = hold;
}
/** For tests: one tick of the clock, exactly `ms` later, however long the tick itself takes. */
export function stepPlayClock(ms: number) {
  last = clock() - ms;
  tick(ms);
}
function startTimer() {
  stopTimer();
  last = clock();
  if (!held) timer = setInterval(tick, TICK);
}

/** Play a run from `t` (its first step when left out), at the Lab's speed. */
export function playRun(id: string, t?: number): boolean {
  const r = runOf(id);
  if (!r) return false;
  pick = null;
  if (lab.pin) setLab({ pin: false });
  play = { id, msgId: msgOf(id), t: Math.min(r.total, t ?? runStart(r)), playing: true };
  startTimer();
  emit();
  return true;
}

/** Pause, or play on from the head (from the start again once at the end). */
export function togglePlay() {
  if (!play) return;
  if (play.playing) {
    stopTimer();
    play = { ...play, playing: false };
    return emit();
  }
  const r = runOf(play.id);
  if (!r) return;
  play = { ...play, t: play.t >= r.total && !r.running ? runStart(r) : play.t, playing: true };
  startTimer();
  emit();
}

/** Move the head (the scrubber, a click on a track): it stops there, never past what has happened. */
export function seek(t: number) {
  if (!play) return;
  const r = runOf(play.id);
  stopTimer();
  play = { ...play, t: Math.max(0, r ? Math.min(r.total, t) : t), playing: false };
  if (r) follow(r, play.t);
  emit();
}

/** Show a run on the timeline without playing it: at its end, or where a running one is now. */
export function showRun(id: string) {
  const r = runOf(id);
  if (!r) return;
  stopTimer();
  pick = null;
  play = { id, msgId: msgOf(id), t: r.total, playing: false };
  emit();
}

/** Grid or Timeline in the dock; the timeline opens on the run at the head, else the newest text that ran. */
export function setDockView(v: DockView) {
  view = v;
  if (v === "timeline" && (!play || !runOf(play.id))) {
    const r = [...sandbox.rows].reverse().find((x) => !x.tex && (x.steps?.length || sandbox.running === x.id));
    if (r) showRun(r.id);
  }
  emit();
}

/** A text just sent: the timeline, playing it from its first step at the Lab's speed, trailing the live run. */
export function followText(msgId: string) {
  view = "timeline";
  if (!playRun(msgId, 0)) emit();
}

export function stopPlay() {
  stopTimer();
  play = null;
  emit();
}

/** ▶ on a test text: plays it back when nothing changed, runs it fresh when something did; ⏸ while it plays pauses it. */
export function playText(msgId: string): "played" | "fresh" | "stopped" | "none" {
  if (play?.id === msgId && play.playing) {
    togglePlay();
    return "stopped";
  }
  if (isStale(msgId)) {
    if (sandbox.running) return "none";
    stopPlay();
    ranOn.delete(msgId);
    // The fresh run is a new text: the timeline follows it as it does every text sent (`onSandboxText` below).
    void retryText(msgId);
    return "fresh";
  }
  if (!runOf(msgId)) return "none";
  view = "timeline";
  playRun(msgId, 0);
  return "played";
}

/** ▶ on one of Tex's texts (`<rowId>#<texRowId>`): only the steps that led to it, as the gateway logged them. */
export function playTexText(runId: string): boolean {
  if (play?.id === runId && play.playing) {
    togglePlay();
    return true;
  }
  view = "timeline";
  return playRun(runId);
}

/** A step's cell: the canvas lit up to that step, the text picked. */
export function pickStep(msgId: string, upto: string | null) {
  stopPlay();
  pick = { msgId, upto };
  emit();
}

/** The run at the head, for the node panel: the steps reached by then, each as far as it got, and the one running. */
export function playHead(): { run: PlayRun; t: number; playing: boolean; steps: ReturnType<typeof stepsAt>; running: string | null } | null {
  if (!play) return null;
  const run = runOf(play.id);
  if (!run) return null;
  return { run, t: play.t, playing: play.playing, steps: stepsAt(run, play.t), running: litAt(run, play.t).running };
}

/** The id of the run at the head, if any (the step panel reads which one it is). */
export const playingId = () => play?.id ?? null;

/** The run the canvas shows: the one playing, or the one on the timeline (a real text's draws the graph of its time). */
export const shownRun = () => (play && (play.playing || view === "timeline") ? runOf(play.id) : null);

/** The steps a run plays when it is one of Tex's texts (the canvas dims the rest), else null. */
export function playOnly(): ReadonlySet<string> | null {
  const r = shownRun();
  return r?.of ? new Set(r.steps.map((s) => s.node)) : null;
}

const stepsOf = (msgId: string) => sandbox.rows.find((r) => r.id === msgId)?.steps ?? [];

/** What the canvas lights now: the run at the head (each step done full, the ones running part way), or the text picked. */
export function playLit(): Lit | ReadonlySet<string> | null {
  const r = shownRun();
  if (r && play) return litAt(r, play.t).lit;
  if (pick) {
    const steps = stepsOf(pick.msgId);
    if (!steps.length) return null;
    const k = pick.upto ? steps.findIndex((s) => s.node === pick!.upto) : -1;
    return new Set((k < 0 ? steps : steps.slice(0, k + 1)).map((s) => s.node));
  }
  return null;
}

// Every new text in the test chat, yours or an AI's in a shared one, plays as it runs.
onSandboxText(followText);

/** For tests. */
export function resetPlay() {
  stopTimer();
  play = null;
  pick = null;
  view = "grid";
  ranOn.clear();
  ext.clear();
  emit();
}

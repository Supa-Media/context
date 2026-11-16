/**
 * The test chat's one ▶ (Dev2, 2026-11-16: "we should have 1 play button, and be smart about if anything changed and
 * we can just replay what we already did, or if something changed and we need fresh answers"). A text keeps the
 * version it ran on; while that version is unchanged ▶ plays back the steps it logged on the canvas, at their logged
 * times and with no model call, and once anything that runs has changed ▶ runs the text again on live models.
 * Clicking a step's cell lights the canvas up to that step.
 */
import { useSyncExternalStore } from "react";
import { lab } from "./state";
import { retryText, sandbox, type SandboxRow } from "./sandbox";
import type { Lit } from "../views/canvas/usePlayback";

/**
 * What a test turn runs: the version as saved, which the gateway reads afresh for every turn. Its id and saved
 * revision, never the canvas as drawn: a focus folding groups, a step moved or an edit not saved yet changes nothing
 * a turn would run.
 */
export function versionPrint(): string {
  return lab.cur.id + ":" + (lab.cur.rev ?? 0);
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

type Play = { msgId: string; t: number; total: number } | null;
type Pick = { msgId: string; upto: string | null } | null;
let play: Play = null;
let pick: Pick = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();
let ver = 0;
const emit = () => {
  ver++;
  subs.forEach((f) => f());
};
export function usePlay(): { play: Play; pick: Pick } {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ver,
    () => ver,
  );
  return { play, pick };
}

/** A playback lasts at most this long on screen; a longer turn plays faster. */
const MAX_PLAY_MS = 6000;
const TICK = 50;
const stepsOf = (msgId: string) => sandbox.rows.find((r) => r.id === msgId)?.steps ?? [];
const msOf = (ms: number | null) => Math.max(ms ?? 0, 1);

export function stopPlay() {
  if (timer) clearInterval(timer);
  timer = null;
  play = null;
  emit();
}

/** ▶ on a test text: plays it back when nothing changed, runs it fresh when something did; ⏸ while it plays stops it. */
export function playText(msgId: string): "played" | "fresh" | "stopped" | "none" {
  if (play?.msgId === msgId) {
    stopPlay();
    return "stopped";
  }
  stopPlay();
  if (isStale(msgId)) {
    if (sandbox.running) return "none";
    ranOn.delete(msgId);
    void retryText(msgId);
    return "fresh";
  }
  const steps = stepsOf(msgId);
  if (!steps.length) return "none";
  const total = steps.reduce((a, s) => a + msOf(s.ms), 0);
  const speed = Math.max(1, total / MAX_PLAY_MS);
  pick = { msgId, upto: null };
  play = { msgId, t: 0, total };
  timer = setInterval(() => {
    if (!play) return;
    play = { ...play, t: Math.min(play.total, play.t + TICK * speed) };
    if (play.t >= play.total) stopPlay();
    else emit();
  }, TICK);
  emit();
  return "played";
}

/** A step's cell: the canvas lit up to that step, the text picked. */
export function pickStep(msgId: string, upto: string | null) {
  stopPlay();
  pick = { msgId, upto };
  emit();
}

/** What the canvas lights now: the text playing (each step done full, the one playing part way), or the text picked. */
export function playLit(): Lit | ReadonlySet<string> | null {
  if (play) {
    const lit = new Map<string, number>();
    let t = play.t;
    for (const s of stepsOf(play.msgId)) {
      const d = msOf(s.ms);
      if (t >= d) lit.set(s.node, 1);
      else {
        lit.set(s.node, t / d);
        break;
      }
      t -= d;
    }
    return lit;
  }
  if (pick) {
    const steps = stepsOf(pick.msgId);
    if (!steps.length) return null;
    const k = pick.upto ? steps.findIndex((s) => s.node === pick!.upto) : -1;
    return new Set((k < 0 ? steps : steps.slice(0, k + 1)).map((s) => s.node));
  }
  return null;
}

/** For tests. */
export function resetPlay() {
  stopPlay();
  pick = null;
  ranOn.clear();
  emit();
}

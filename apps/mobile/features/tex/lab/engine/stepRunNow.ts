/**
 * Which test text the step panel reads and how a step stands in it right now: not run, running, or ran with what it
 * logged (see `stepRun.ts` for the words a step's output becomes).
 */
import { sandbox, type SandboxRow } from "./sandbox";
import { lab } from "./state";
import type { RunStep } from "./stepRun";
import { stepsAt } from "./sandboxRun";
import { playingId, runOf } from "./sandboxPlay";
import type { PlayStep } from "./playRun";

/** A playback as `sandboxPlay.ts` keeps it: the run's id (the steps behind one of Tex's texts: `<rowId>#<texRowId>`). */
type PlayAt = { msgId: string; t: number; id?: string };
/** The run a playback plays, on the times the gateway logged (`sandboxRun.ts`), as the timeline and canvas draw it. */
const runAt = (play: PlayAt) => runOf(play.id ?? play.msgId);
/** A played step as the panel reads a logged one. */
const asRunStep = (s: PlayStep): RunStep => {
  const { out, ms, at: _at, ...rest } = s;
  return { ...rest, ms: ms ?? null, out: typeof out === "string" ? out : out === undefined ? "" : JSON.stringify(out), ...(out !== undefined && typeof out !== "string" ? { data: out } : {}) } as RunStep;
};

/** The test text the panel reads: the one picked or playing, else the one running, else the newest that ran steps. */
export function panelRow(pick: { msgId: string } | null, play: { msgId: string } | null): SandboxRow | null {
  // Following, the text running now is the one shown; once a node is clicked (pinned) it stays on the one picked.
  const id = play?.msgId ?? (lab.pin ? pick?.msgId : null) ?? sandbox.running ?? pick?.msgId;
  const hit = id ? sandbox.rows.find((r) => r.id === id) : undefined;
  if (hit) return hit;
  for (let i = sandbox.rows.length - 1; i >= 0; i -= 1) if (sandbox.rows[i].steps?.length) return sandbox.rows[i];
  return null;
}

/** When a running step was first seen running, for how long it has been going (the gateway sends no start time yet). */
const seen = new Map<string, number>();
export const sinceOf = (key: string, now = Date.now()): number => {
  const t = seen.get(key);
  if (t !== undefined) return now - t;
  seen.set(key, now);
  return 0;
};

export type StepRunState =
  | { state: "none" }
  | { state: "running"; elapsed: number; key: string }
  | { state: "ran"; steps: RunStep[]; times: number };

/**
 * One canvas step as it ran for a text: not at all, running now (with its elapsed time, nothing else), or ran with what
 * it logged. While the text is played back a step counts only once the playback has reached it.
 */
export function stepRunOf(row: SandboxRow | null, node: string, played: number | null, now = Date.now(), play?: PlayAt | null): StepRunState {
  const all = (row?.steps ?? []) as RunStep[];
  // A real text played from production's log has no steps on its row: the run holds them.
  if (row && !all.length && played !== null) {
    const r = runAt({ msgId: row.id, id: playingId() ?? row.id, t: played });
    if (r) {
      const at = stepsAt(r, played).filter((s) => s.node === node);
      const going = at.find((s) => s.running);
      if (going) return { state: "running", elapsed: going.elapsed, key: `play:${r.id}:${node}` };
      return at.length ? { state: "ran", steps: at.map(asRunStep), times: at.length } : { state: "none" };
    }
  }
  if (!row || !all.length) return { state: "none" };
  const live = row.id === sandbox.running;
  const mine = all.filter((s) => s.node === node);
  // The run playing: the one handed in, else the head's own when it is of this text (the steps behind one of Tex's
  // texts included), else this text's whole run.
  const id = play?.id ?? (playingId()?.split("#")[0] === row.id ? playingId()! : row.id);
  const run = played !== null ? runAt({ msgId: row.id, id, t: played }) : null;
  if (played !== null && run) {
    // Playback, on the run's own times: running while the head is inside a step, ran once the head has passed it.
    const at = stepsAt(run, played).filter((s) => s.node === node);
    const going = at.find((s) => s.running);
    if (going) return { state: "running", elapsed: going.elapsed, key: `play:${run.id}:${node}` };
    const byId = new Map(all.map((s, i) => [s.id ?? `${row.id}.${i}`, s]));
    const done = at.map((s) => byId.get(s.id)).filter((s): s is RunStep => !!s);
    return done.length ? { state: "ran", steps: done, times: done.length } : { state: "none" };
  }
  if (played !== null) {
    // Playback: a step is running while the head is inside it, ran once the head has passed.
    let t = 0;
    const done: RunStep[] = [];
    let run: { elapsed: number } | null = null;
    for (const s of all) {
      const d = Math.max(s.ms ?? 0, 1);
      if (s.node === node) {
        if (played >= t + d) done.push(s);
        else if (played >= t) run = { elapsed: played - t };
      }
      t += d;
    }
    if (run) return { state: "running", elapsed: run.elapsed, key: `play:${row.id}:${node}` };
    return done.length ? { state: "ran", steps: done, times: done.length } : { state: "none" };
  }
  const running = live && (mine.some((s) => s.ms === null) || sandbox.hot === node);
  if (running) {
    const key = `${row.id}:${node}`;
    return { state: "running", elapsed: sinceOf(key, now), key };
  }
  const logged = mine.filter((s) => s.ms !== null || !live);
  return logged.length ? { state: "ran", steps: logged, times: logged.length } : { state: "none" };
}

/** The step running now in the live or playing text, which the panel follows until a node is clicked. */
export function runningNode(play: PlayAt | null): string | null {
  const run = play ? runAt(play) : null;
  if (play && run) {
    const going = stepsAt(run, play.t).filter((s) => s.running);
    return going.length ? going[going.length - 1].node : null;
  }
  if (play) {
    const row = sandbox.rows.find((r) => r.id === play.msgId);
    let t = 0;
    for (const s of row?.steps ?? []) {
      const d = Math.max(s.ms ?? 0, 1);
      if (play.t >= t && play.t < t + d) return s.node;
      t += d;
    }
    return null;
  }
  return sandbox.running && sandbox.hot ? sandbox.hot : null;
}

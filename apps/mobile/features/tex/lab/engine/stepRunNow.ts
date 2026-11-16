/**
 * Which test text the step panel reads and how a step stands in it right now: not run, running, or ran with what it
 * logged (see `stepRun.ts` for the words a step's output becomes).
 */
import { sandbox, type SandboxRow } from "./sandbox";
import { lab } from "./state";
import type { RunStep } from "./stepRun";

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
export function stepRunOf(row: SandboxRow | null, node: string, played: number | null, now = Date.now()): StepRunState {
  const all = (row?.steps ?? []) as RunStep[];
  if (!row || !all.length) return { state: "none" };
  const live = row.id === sandbox.running;
  const mine = all.filter((s) => s.node === node);
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
export function runningNode(play: { msgId: string; t: number } | null): string | null {
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

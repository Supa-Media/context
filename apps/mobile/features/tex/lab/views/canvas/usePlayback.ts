/**
 * Playing the traced moment on the canvas at its own pace (Dev2, 2026-11-14: "I want it to actually be as slow as the
 * actuall logged times are, so we can debug what parts are causing slowdowns"; then "I kind of need like a scrubber
 * when playing things so I could scroll back"; and "instead of it like just being fully outlined blue, for it to sort
 * of uh gradually circle around the node based on how much time it is").
 *
 * The timeline is the canvas's sim (real times for a traced own text, `realTimes.ts`): every reply and background step
 * with its start and end. A clock runs over it, scaled by the speed, and each step running at that moment is lit with
 * how far through it is (0 to 1, drawn as a ring filling around the step, `render.ts`). The scrubber sets the clock
 * by hand: dragging pauses, and Play carries on from there. The step that started last is selected so the right panel
 * shows what it got and gave.
 */
import { useEffect, useRef, useState } from "react";
import { labSim } from "../../engine/realTimes";
import { node, set } from "../../engine/state";

type Step = [string, { start: number; end: number }];
export type Lit = ReadonlyMap<string, number>;

/** A step too short to see stays lit a little longer: 150 ms of screen time, at most 0.4 s of the turn. */
const minLit = (speed: number) => Math.min(150 * speed, 400);

function timeline() {
  const sm = labSim();
  const steps: Step[] = Object.entries(sm.T).filter(([, t]) => t.lane === "reply" || t.lane === "behind");
  return { steps, of: Math.max(sm.reply, ...steps.map(([, t]) => t.end)) };
}

export function usePlayback(speed: number, moment: unknown) {
  const [lit, setLit] = useState<Lit | null>(null);
  const [clock, setClock] = useState<{ at: number; of: number } | null>(null);
  const [running, setRunning] = useState(false);
  const raf = useRef<number | null>(null);
  const run = useRef<ReturnType<typeof timeline> | null>(null);
  const drawn = useRef("");
  const last = useRef<string | null>(null);
  const pace = useRef(speed);
  pace.current = speed;

  /** Light what runs at `at` (turn milliseconds); draws only when something shows differently. */
  const show = (at: number, force = false) => {
    const tl = (run.current ??= timeline());
    const sp = pace.current;
    const on = tl.steps.filter(([, t]) => at >= t.start && at < Math.max(t.end, t.start + minLit(sp))).sort((a, b) => b[1].start - a[1].start);
    const key = on.map(([id]) => id).join(",") + "|" + Math.floor(Math.min(at, tl.of) / 50);
    if (force || key !== drawn.current) {
      drawn.current = key;
      setLit(new Map(on.map(([id, t]) => [id, Math.min(1, Math.max(0, (at - t.start) / Math.max(1, t.end - t.start)))])));
      setClock({ at: Math.min(Math.max(at, 0), tl.of), of: tl.of });
    }
    const newest = on[0]?.[0] ?? null;
    if (newest && newest !== last.current && node(newest)) {
      last.current = newest;
      set({ sel: { t: "node", id: newest } });
    }
  };

  const halt = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setRunning(false);
  };

  const start = (from: number) => {
    const tl = (run.current ??= timeline());
    const began = performance.now();
    setRunning(true);
    const tick = () => {
      const at = from + (performance.now() - began) * pace.current;
      show(at);
      if (at < tl.of + 400 * pace.current) raf.current = requestAnimationFrame(tick);
      else {
        // The end: nothing lit, the clock stays at the end so the scrubber can take it back.
        raf.current = null;
        setRunning(false);
        setLit(null);
        setClock({ at: tl.of, of: tl.of });
      }
    };
    raf.current = requestAnimationFrame(tick);
  };

  /** Play, or pause while playing. Played to the end, it starts again from the top. */
  const toggle = () => {
    if (raf.current !== null) return halt();
    const from = clock && clock.at < clock.of ? clock.at : 0;
    if (from === 0) {
      run.current = timeline();
      last.current = null;
    }
    start(from);
  };

  /** Play from the top on a fresh timeline (a text clicked in the conversation). */
  const restart = () => {
    halt();
    run.current = timeline();
    last.current = null;
    start(0);
  };

  /** The scrubber: pause and show the moment at `at`. */
  const scrub = (at: number) => {
    halt();
    show(at, true);
  };

  // Another moment traced: the old timeline no longer applies.
  useEffect(() => {
    halt();
    run.current = null;
    last.current = null;
    setLit(null);
    setClock(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moment]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  /** How long the whole moment takes, before it has played. */
  const total = () => (run.current ?? timeline()).of;
  return { lit, clock, running, toggle, restart, scrub, total };
}

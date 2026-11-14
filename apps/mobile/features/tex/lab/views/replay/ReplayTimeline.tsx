/**
 * Replay's timeline under the canvas (`engine/replay.ts`): the moment's texts, the judge's calls, each turn (its wait
 * in the queue hatched) and each send, on one clock from its first text, with a head that plays at the speed picked or
 * is dragged by the scrubber. Wherever the head is, the turn under it plays on the canvas at its measured times: each
 * step running then is lit with a ring for how far through it is, and the newest is selected so the right panel shows
 * what it got and gave.
 */
import { useEffect, useRef, useState } from "react";
import { fmtS } from "../../engine/sim";
import { labSim, realIO, realTimes } from "../../engine/realTimes";
import { turnAt, type Lane, type Moment } from "../../engine/replay";
import { emit, lab, node, set } from "../../engine/state";
import { traceMine } from "../../engine/traces";
import type { LedgerEntry } from "../../../page/texPageTypes";
import type { Lit } from "../canvas/usePlayback";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const speedLabel = (v: number) => (v === 1 ? "Real time" : v < 1 ? `${1 / v}× slower` : `${v}× faster`);
const LANES: Lane[] = ["Texts", "Judge", "Turn", "Sent"];
/** A step too short to see stays lit for 150 ms of screen time, at most 0.4 s of the turn. */
const minLit = (speed: number) => Math.min(150 * speed, 400);

/** Point the canvas at one turn of the moment: its text traced, its measured times and inputs and outputs. */
function showTurn(m: Moment, entries: LedgerEntry[], turn: string) {
  const asked = m.lines.find((l) => l.play?.turn === turn)?.play ?? m.lines.find((l) => l.play)?.play;
  if (!asked) return;
  traceMine(asked.text);
  const times = realTimes(entries, turn);
  lab.real = times ? { text: asked.text, times, io: realIO(entries, turn, asked.text, asked.then.text), turn } : null;
}

export function ReplayTimeline({ m, entries, onLit }: { m: Moment; entries: LedgerEntry[]; onLit: (lit: Lit | null) => void }) {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const raf = useRef<number | null>(null);
  const shown = useRef<string | null>(null);
  const last = useRef<string | null>(null);

  // A new moment starts at its first text, stopped.
  useEffect(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPlaying(false);
    setAt(0);
    shown.current = null;
    last.current = null;
  }, [m.id]);
  useEffect(() => () => void (raf.current !== null && cancelAnimationFrame(raf.current)), []);

  // What the canvas shows at the head.
  useEffect(() => {
    const under = turnAt(m, at);
    if (!under) {
      onLit(null);
      return;
    }
    if (shown.current !== under.turn) {
      shown.current = under.turn;
      showTurn(m, entries, under.turn);
      emit();
    }
    const t = at - under.start;
    const sim = labSim();
    const on = Object.entries(sim.T)
      .filter(([, s]) => (s.lane === "reply" || s.lane === "behind") && t >= s.start && t < Math.max(s.end, s.start + minLit(speed)))
      .sort((a, b) => b[1].start - a[1].start);
    onLit(on.length ? new Map(on.map(([id, s]) => [id, Math.min(1, Math.max(0, (t - s.start) / Math.max(1, s.end - s.start)))])) : null);
    const newest = on[0]?.[0];
    // Opened, the moment itself shows in the panel; once it plays or is scrubbed, the step running then.
    if (at > 0 && newest && newest !== last.current && node(newest)) {
      last.current = newest;
      set({ sel: { t: "node", id: newest } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, m.id, m.of, entries.length]);

  const stop = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setPlaying(false);
  };
  const play = () => {
    if (raf.current !== null) return stop();
    const from = at >= m.of ? 0 : at;
    const began = performance.now();
    setPlaying(true);
    const tick = () => {
      const now = Math.min(m.of, from + (performance.now() - began) * speed);
      setAt(Math.round(now / 20) * 20);
      if (now < m.of) raf.current = requestAnimationFrame(tick);
      else {
        raf.current = null;
        setPlaying(false);
      }
    };
    raf.current = requestAnimationFrame(tick);
  };
  const pct = (v: number) => `${((v / m.of) * 100).toFixed(2)}%`;

  return (
    <div className="float rtl" id="replayTimeline" aria-label="Timeline">
      <div className="rtlh">
        <button className="ib" id="rPlay" aria-label={playing ? "Pause" : "Play"} onClick={play}>
          <svg className="i" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: playing ? '<rect x="7" y="6" width="3.5" height="12" rx="1"/><rect x="13.5" y="6" width="3.5" height="12" rx="1"/>' : '<path d="M8 5l10 7-10 7z"/>' }} />
        </button>
        <span className="clock" id="rClock">
          {fmtS(at)} / {fmtS(m.of)}
        </span>
        <span className="spacer" />
        <select id="rSpeed" aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {speedLabel(v)}
            </option>
          ))}
        </select>
      </div>
      <div className="rlanes">
        {LANES.map((ln) => (
          <div key={ln} className="rrow">
            <span className="rln">{ln === "Judge" ? "Judge" : ln}</span>
            <div className="rtrack" data-lane={ln}>
              {m.lanes[ln].map((b, i) => (
                <button
                  key={i}
                  className={`rbar ${b.kind}`}
                  style={{ left: pct(b.start), width: `max(6px, ${pct(b.end - b.start)})` }}
                  title={`${b.label}${b.detail ? " · " + b.detail : ""} · ${fmtS(b.start)}–${fmtS(b.end)}`}
                  onClick={() => (stop(), setAt(b.start))}
                >
                  {b.label}
                </button>
              ))}
              <span className="rhead" style={{ left: pct(at) }} />
            </div>
          </div>
        ))}
      </div>
      <input
        id="rScrub"
        type="range"
        min={0}
        max={Math.round(m.of)}
        step={10}
        value={Math.round(at)}
        aria-label="Scrub through the moment"
        onChange={(e) => (stop(), setAt(Number(e.target.value)))}
      />
    </div>
  );
}

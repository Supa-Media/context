/**
 * Replay's timeline under the canvas (`engine/replay.ts`): the moment's texts, the judge's calls, each turn (its wait
 * in the queue hatched) and each send, on one clock from its first text, with a head that plays at the speed picked or
 * is dragged by the scrubber. Wherever the head is, the turn under it plays on the canvas at its measured times: each
 * step running then is lit with a ring for how far through it is, and the newest is selected so the right panel shows
 * what it got and gave.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { fmtS } from "../../engine/sim";
import { labSim, realIO, realTimes, withWorkerSteps } from "../../engine/realTimes";
import { startLabel, turnAt, type Bar, type Moment } from "../../engine/replay";
import { stepRows } from "../../engine/replaySteps";
import { emit, lab, node, set } from "../../engine/state";
import { traceMine } from "../../engine/traces";
import type { LedgerEntry } from "../../../page/texPageTypes";
import type { Lit } from "../canvas/usePlayback";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const speedLabel = (v: number) => (v === 1 ? "Real time" : v < 1 ? `${1 / v}× slower` : `${v}× faster`);
/** A step too short to see stays lit for 150 ms of screen time, at most 0.4 s of the turn. */
const minLit = (speed: number) => Math.min(150 * speed, 400);

/**
 * Point the canvas at one turn of the moment: what started it traced (a text someone sent, or a check-in, a routine or
 * a ping from its own start step), its measured times and everything it got, thought and gave. The texting Worker's
 * judgings in the moment before the turn's text was sent count as its Decide step.
 */
function showTurn(m: Moment, entries: LedgerEntry[], turn: string) {
  const sent = Math.max(...entries.filter((e) => e.turn === turn).map((e) => e.at), m.at);
  const all = withWorkerSteps(entries, turn, m.at - 1_000, sent);
  const asked = lab.myLines.find((l) => l.play?.turn === turn)?.play ?? (m.from === "text" ? m.lines.find((l) => l.play)?.play : null);
  if (asked) {
    traceMine(asked.text);
    const times = realTimes(all, turn);
    lab.real = times ? { text: asked.text, times, io: realIO(all, turn, asked.text, asked.then.text), turn } : null;
    return;
  }
  const own = m.lines[0];
  if (!own?.start) return;
  // Tex texting on its own: the start step's words are what it was asked, as the turn was given them.
  const label = startLabel(own);
  traceMine(label, own.start);
  const times = realTimes(all, turn);
  const io = realIO(all, turn, own.about || label, own.text);
  io[own.start] = [{ k: "Started", v: own.about || label }];
  lab.real = times ? { text: label, times, io, turn } : null;
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
    // Again when more of the day's entries arrive, so what the turn thought and did fills in once read.
    if (shown.current !== under.turn + "|" + entries.length) {
      shown.current = under.turn + "|" + entries.length;
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
  // One row per step that ran, each helper under the step that waited on it, between what came in and what went out
  // (Dev2, 2026-11-14: "the judge having its own seems weird, what about helpers?"). Decide is the texting Worker's step
  // before the turn; Queue is the turn's wait for it.
  const rows = useMemo(() => {
    const steps = stepRows(m, entries);
    const wait = m.lanes.Turn.filter((b) => b.kind === "wait");
    const out: Array<{ key: string; label: string; helper?: boolean; bars: Bar[] }> = [{ key: "Texts", label: m.from === "text" ? "Texts" : "Start", bars: m.lanes.Texts }];
    if (m.lanes.Judge.length) out.push({ key: "decide", label: "Decide", bars: m.lanes.Judge });
    if (wait.length) out.push({ key: "queue", label: "Queue", bars: wait });
    // The canvas's Decide step is the Decide row above.
    if (steps.length) for (const r of steps.filter((x) => x.id !== "decide")) out.push({ key: r.id, label: r.label, helper: r.helper, bars: r.bars });
    else out.push({ key: "Turn", label: "Turn", bars: m.lanes.Turn.filter((b) => b.kind === "turn") });
    out.push({ key: "Sent", label: "Sent", bars: m.lanes.Sent });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id, m.of, entries.length]);
  const pct = (v: number) => `${((v / m.of) * 100).toFixed(2)}%`;
  // Drag anywhere on the lanes to scrub (Dev2, 2026-11-14: "why not let me scrub with the bar").
  const dragging = useRef(false);
  const scrubTo = (e: RPointerEvent<HTMLDivElement>) => {
    const track = e.currentTarget.querySelector<HTMLElement>(".rtrack");
    if (!track) return;
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return;
    stop();
    setAt(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * m.of));
  };

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
      <div
        className="rlanes"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          scrubTo(e);
        }}
        onPointerMove={(e) => {
          if (dragging.current) scrubTo(e);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        {rows.map((r) => (
          <div key={r.key} className={r.helper ? "rrow helper" : "rrow"}>
            <span className="rln" title={r.label}>{r.label}</span>
            <div className="rtrack" data-lane={r.key}>
              {r.bars.map((b, i) => (
                <button
                  key={i}
                  className={`rbar ${b.kind}`}
                  style={{ left: pct(b.start), width: `max(6px, ${pct(b.end - b.start)})` }}
                  title={`${b.label}${b.detail ? " · " + b.detail : ""} · ${fmtS(b.start)}–${fmtS(b.end)}`}
                  tabIndex={-1}
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

/**
 * Replay's right panel, read only: for the step selected on the canvas, what it ran as (its model and effort in this
 * version, how long it really took, which Tex answered) and what it got and gave in that turn; with no step selected,
 * how Tex handled the text replayed from: each turn (its wait, how long it ran, which Tex, what it said) and every call
 * the judge made. The texts themselves are on the left, so they aren't repeated here (Dev2, 2026-11-14: "why are we
 * essentially showing the same info just uglier").
 */
import { NODE_INFO } from "../../data/graph";
import { shortVersion, type TexVersion } from "../../engine/mine";
import type { Moment } from "../../engine/replay";
import { fmtS } from "../../engine/sim";
import { lab, MODELS, node, set } from "../../engine/state";
import { useLab } from "../../store";
import { Ic } from "../ic";

const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

export function ReplayPanel({ m }: { m: Moment | null }) {
  useLab();
  if (!m) {
    return (
      <div className="rpanel" id="replayPanel">
        <h3>Replay</h3>
        <p className="hint">Pick a moment in the conversation to watch how Tex handled it. Nothing here changes Tex; switch to Lab to try a change.</p>
      </div>
    );
  }
  const sel = lab.sel;
  const n = sel?.t === "node" ? node(sel.id) : undefined;
  if (n) {
    const mo = MODELS[n.model] || MODELS.code;
    const real = lab.real;
    const ms = real?.times.ms[n.id];
    const io = real?.io?.[n.id] ?? [];
    const version = (real?.turn ? m.lines.find((l) => l.play?.turn === real.turn)?.play?.then.version : null) as TexVersion | null | undefined;
    return (
      <div className="rpanel" id="replayPanel">
        <div className="ph">
          <div className="badge">
            <Ic k={n.icon} />
          </div>
          <h3>{n.label}</h3>
          <button className="ib pclose" aria-label="Back to the moment" style={{ width: 32, height: 32 }} onClick={() => set({ sel: null })}>
            <svg className="i" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <p className="hint">{n.goal || NODE_INFO[n.id]?.goal || ""}</p>
        <div className="rset">
          <span className="pill acc">{mo.runs === "code" ? "Code" : mo.name + (n.effort ? " · " + n.effort : "")}</span>
          <span className="pill">{ms !== undefined ? fmtS(ms) + " real" : "not measured"}</span>
          {real?.times.calls[n.id] ? <span className="pill">{real.times.calls[n.id] + (real.times.calls[n.id] === 1 ? " call" : " calls")}</span> : null}
          <span className="pill" title="Which Tex answered">{shortVersion(version ?? null)}</span>
        </div>
        <div className="grp" id="rIO">
          <h4>Got and gave</h4>
          {io.length ? (
            io.map((l, i) => (
              <div key={i} className="io">
                <b>{l.k}</b>
                <pre>{l.v}</pre>
              </div>
            ))
          ) : (
            <p className="hint">This step kept nothing of its own for this turn.</p>
          )}
        </div>
      </div>
    );
  }
  // Nothing selected: what the chat on the left can't show, how Tex handled it. The texts themselves are already there.
  const first = m.lines[0];
  const behind = m.lines.filter((l) => l.from === "person").length - 1;
  const turnBars = m.lanes.Turn.filter((b) => b.kind === "turn");
  const waitOf = (turn?: string) => m.lanes.Turn.find((b) => b.kind === "wait" && b.turn === turn);
  const judged = m.lanes.Judge;
  return (
    <div className="rpanel" id="replayPanel">
      <h3>{first.who === "You" || !first.who ? "From your text" : `From ${first.who}'s text`}</h3>
      <p className="hint">
        {time(first.at)} · {behind > 0 ? `${behind} more ${behind === 1 ? "text" : "texts"} came in behind it` : "nothing came in behind it"}
      </p>
      <div className="rset">
        <span className="pill">
          {m.turns.length} {m.turns.length === 1 ? "turn" : "turns"}
        </span>
        <span className="pill">{fmtS(m.of)} to the last send</span>
      </div>
      <div className="grp" id="rTurns">
        <h4>Turns</h4>
        {turnBars.length ? (
          turnBars.map((b, i) => {
            const w = waitOf(b.turn);
            const waited = w ? w.end - Math.max(0, w.zero ?? w.start) : 0;
            return (
              <div key={i} className="rturn">
                <div className="rturnh">
                  <b>Turn {i + 1}</b>
                  <span>{(b.zero ?? 0) < 0 ? "already running" : `started ${fmtS(Math.max(0, b.zero ?? b.start))}`}</span>
                  {waited > 0 ? <span>waited {fmtS(waited)}</span> : null}
                  <span>ran {fmtS(b.end - b.start)}</span>
                  <span title="Which Tex answered">{shortVersion((b.version as TexVersion | null | undefined) ?? null)}</span>
                </div>
                <div className="rturnt">{b.detail || b.label}</div>
              </div>
            );
          })
        ) : (
          <p className="hint">No turn was logged for this text.</p>
        )}
      </div>
      <div className="grp" id="rJudge">
        <h4>The judge</h4>
        {judged.length ? (
          judged.map((b, i) => (
            <div key={i} className="rjrow">
              <span className="rjat">{fmtS(b.start)}</span>
              <b>{b.label}</b>
              <span className="rjwhy">{b.detail}</span>
            </div>
          ))
        ) : (
          <p className="hint">The judge kept no calls for this text.</p>
        )}
      </div>
      <p className="hint">Click a step on the canvas, or a bar on the timeline, to see what it got and gave.</p>
    </div>
  );
}

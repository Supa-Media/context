/**
 * Replay's right panel, read only: for the step selected on the canvas, what it ran as (its model and effort in this
 * version, how long it really took, which Tex answered) and what it got and gave in that turn; with no step selected,
 * the moment itself: its texts and every call the judge made about them.
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
  const judged = m.lanes.Judge;
  return (
    <div className="rpanel" id="replayPanel">
      <h3>{m.lines.filter((l) => l.from === "person").length > 1 ? "Texts in a row" : "One text"}</h3>
      <p className="hint">
        {m.turns.length} {m.turns.length === 1 ? "turn" : "turns"} · {fmtS(m.of)} from the first text to the last send
      </p>
      <div className="grp">
        <h4>Came in</h4>
        {m.lines
          .filter((l) => l.from === "person")
          .map((l) => (
            <div key={l.id} className="io">
              <b>
                {l.who} · {time(l.at)}
              </b>
              <pre>{l.text}</pre>
            </div>
          ))}
      </div>
      <div className="grp" id="rJudge">
        <h4>The judge</h4>
        {judged.length ? (
          judged.map((b, i) => (
            <div key={i} className="io">
              <b>
                {fmtS(b.start)} · {b.detail}
              </b>
              <pre>{b.label}</pre>
            </div>
          ))
        ) : (
          <p className="hint">No judging kept for this moment (older texts were judged before it was logged).</p>
        )}
      </div>
      <p className="hint">Click a step on the canvas, or a bar on the timeline, to see what it got and gave.</p>
    </div>
  );
}

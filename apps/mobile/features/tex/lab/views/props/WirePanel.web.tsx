/**
 * The Lab's wire panel: the artifact's `renderProps0` for a selected wire
 * (its kind, when it fires, how often a loop sends back, delete). A wire that
 * is no longer there clears the selection, as the artifact did.
 */
import type { ReactNode } from "react";
import { useEffect } from "react";
import { WHEN, WIRES } from "../../data/graph";
import { edit, G, lab, node, set } from "../../engine/state";
import type { LabEdge } from "../../types";
import { useLab } from "../../store";
import { Ic } from "../ic";
import { WireIcon } from "../parts";
import { onCommit } from "./change";
import { delSel } from "./NodePanel.web";

/** Toggle a "fires when" entry: "always" stands alone; any other entry replaces it. */
function toggleWhen(i: number, t: string) {
  edit(() => {
    const ed = G().edges[i];
    if (t === "*") ed.when = ["*"];
    else {
      ed.when = ed.when.filter((x) => x !== "*");
      ed.when = ed.when.includes(t) ? ed.when.filter((x) => x !== t) : [...ed.when, t];
      if (!ed.when.length) ed.when = ["*"];
    }
  });
}

export function WirePanel({ extra }: { extra?: ReactNode }) {
  useLab();
  const sel = lab.sel;
  const i = sel?.t === "edge" ? sel.i : -1;
  const e: LabEdge | undefined = G().edges[i];

  useEffect(() => {
    if (!e) set({ sel: null });
  }, [e]);
  if (!e) return null;

  const a = node(e.from)!;
  const b = node(e.to)!;

  return (
    <>
      <div className="ph">
        <div className="badge">
          <Ic k="wire" />
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, flex: 1 }}>Wire</div>
        {extra}
      </div>
      <div className="grp">
        <div className="flex" style={{ fontSize: 14 }}>
          <Ic k={a.icon} />
          <b>{a.label}</b>
          <span className="hint">to</span>
          <Ic k={b.icon} />
          <b>{b.label}</b>
        </div>
      </div>
      <div className="grp">
        <h4>Kind</h4>
        <div className="wk" id="eMode">
          {Object.entries(WIRES).map(([k, w]) => (
            <button key={k} data-v={k} aria-pressed={e.mode === k} onClick={() => edit(() => (G().edges[i].mode = k as LabEdge["mode"]))}>
              <WireIcon mode={k} />
              <span>
                <b>{w.name}</b>
                <small>{w.tip}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="grp">
        <h4>Fires when</h4>
        <div className="chips">
          {WHEN.map(([t, l]) => (
            <button key={t} className="tg" data-when={t} aria-pressed={e.when.includes(t)} onClick={() => toggleWhen(i, t)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {e.mode === "loop" ? (
        <div className="grp">
          <h4>How often</h4>
          <div className="nums" style={{ gridTemplateColumns: "1fr" }}>
            <label className="num">
              <span>Percent of drafts sent back</span>
              <input
                type="number"
                id="eP"
                min={0}
                max={100}
                key={String(Math.round((a.sendBack ?? 0.1) * 100))}
                defaultValue={Math.round((a.sendBack ?? 0.1) * 100)}
                ref={onCommit<HTMLInputElement>((v) => edit(() => (node(G().edges[i].from)!.sendBack = +v / 100)))}
              />
            </label>
          </div>
        </div>
      ) : null}
      <div className="grp">
        <button className="danger" id="eDel" onClick={delSel}>
          <Ic k="trash" />
          Delete this wire
        </button>
      </div>
    </>
  );
}

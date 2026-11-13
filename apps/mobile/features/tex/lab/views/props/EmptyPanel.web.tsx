/**
 * The Lab's version panel: the artifact's `renderProps0` with nothing selected
 * (the version's name, what runs today, the scenario's speed and cost, and the
 * canvas hints). The name is kept on commit, as the artifact's `onchange` did.
 */
import type { ReactNode } from "react";
import { BASE_SHA } from "../../data/graph";
import { fmtS, fmtUsd, simulate } from "../../engine/sim";
import { G, isMain, lab, set } from "../../engine/state";
import { scnLabel } from "../../engine/traces";
import { useLab } from "../../store";
import { Ic } from "../ic";
import { onCommit } from "./change";

export function EmptyPanel({ extra }: { extra?: ReactNode }) {
  useLab();
  const sim = simulate(G(), lab.scn, lab.logRows);
  const main = isMain();

  return (
    <>
      <div className="ph">
        <div className="badge">
          <Ic k="router" />
        </div>
        <input
          id="vName"
          aria-label="Version name"
          disabled={main}
          key={lab.cur.name}
          defaultValue={lab.cur.name}
          ref={onCommit<HTMLInputElement>((value) => {
            lab.cur.name = value.trim() || lab.cur.name;
            set({ dirty: true });
          })}
        />
        {extra}
      </div>
      <div className="file">{main ? `What runs today (main@${BASE_SHA}). Change anything to start your own copy.` : `From main@${BASE_SHA}`}</div>
      <div className="grp">
        <h4>{scnLabel(lab.scn)}</h4>
        <div className="est">
          <div className="big">{fmtS(sim.reply)}</div>
          <div className="row">
            <span>until the reply goes</span>
          </div>
          <div className="row">
            <span>This moment costs</span>
            <span>{fmtUsd(sim.usd)}</span>
          </div>
        </div>
      </div>
      <div className="grp">
        <h4>On the canvas</h4>
        <div className="hint" style={{ display: "grid", gap: 10 }}>
          <div className="flex" style={{ flexWrap: "nowrap" }}>
            <Ic k="door" style={{ color: "var(--accent)" }} />
            <span>Click a step to change it</span>
          </div>
          <div className="flex" style={{ flexWrap: "nowrap" }}>
            <Ic k="wire" style={{ color: "var(--accent)" }} />
            <span>Drag from a step's edge dot to wire it</span>
          </div>
          <div className="flex" style={{ flexWrap: "nowrap" }}>
            <Ic k="trash" style={{ color: "var(--accent)" }} />
            <span>Select, then press Delete</span>
          </div>
        </div>
      </div>
    </>
  );
}

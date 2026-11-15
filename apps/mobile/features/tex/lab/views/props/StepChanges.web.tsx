/**
 * The step panel's changes (Dev2, 2026-11-15; design https://claude.ai/artifact/VnAnSNDprEUJ4fFDEmXqhp, board 4): every
 * field the base had differently, its value struck through above this draft's, with "Put back" and "Step through
 * revs". Drawn while the graph's change marks are on.
 */
import { currentMarks, fieldText, putBack } from "../../engine/changeMarks";
import { isLive, live } from "../../engine/live";
import { lab, set } from "../../engine/state";
import { useLab } from "../../store";
import type { LabNode } from "../../types";
import { ChangeRows } from "../canvas/ChangeTip";

export function StepChanges({ n }: { n: LabNode }) {
  useLab();
  const m = currentMarks();
  const x = m?.nodes[n.id];
  if (!m || !x) return null;
  const count = x.fields.length + (x.moved ? 1 : 0);
  const untouched = ["model", "effort"].filter((f) => !x.fields.includes(f));
  const canStep = isLive() && live.rev > 1;
  return (
    <div className="grp cfield" id="nChanges">
      <div className="flex" style={{ gap: 8 }}>
        <h4 style={{ flex: 1, margin: 0 }}>{x.kind === "new" ? `New: not on ${m.vs}` : `Changed from ${m.vs}`}</h4>
        <span className={`pill ${x.kind === "new" ? "ok" : "warn"}`}>{x.kind === "new" ? "+ new" : `~ ${count} change${count === 1 ? "" : "s"}`}</span>
      </div>
      {x.kind === "changed" ? (
        <>
          <div className="hint small">Every field {m.vs} had differently shows its value struck through above this draft's.</div>
          <div className="box">
            <ChangeRows m={m} id={n.id} />
          </div>
          {untouched.length && x.base ? (
            <div className="hint small">
              {untouched.map((f) => `${f} ${fieldText(n, f)}`).join(" · ")} · unchanged
            </div>
          ) : null}
        </>
      ) : null}
      <div className="flex" style={{ gap: 8 }}>
        <button className="ghost" id="nPutBack" onClick={() => putBack(n.id)}>
          {m.vs === "main" ? "Put back main's" : `Put back ${m.vs}'s`}
        </button>
        <button
          className="ghost"
          id="nStepRevs"
          disabled={!canStep}
          title={canStep ? "Compare with one revision earlier each tap" : "A saved draft with two or more revisions"}
          onClick={() => {
            const next = typeof lab.chgVs === "number" ? lab.chgVs - 1 : live.rev;
            set(next >= 2 ? { chgVs: next } : { chgVs: "main", revBase: null });
          }}
        >
          Step through revs
        </button>
      </div>
    </div>
  );
}

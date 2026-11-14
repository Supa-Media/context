/**
 * The Lab's properties panel content: the artifact's `renderProps` with its
 * `renderProps0` picking the wire, step or version panel. The shell draws the
 * `<aside id="props">` around it. The header's Focus / Whole graph and close
 * buttons are added to each panel's `.ph`, and when a step is focused its test
 * cases are drawn beneath the panel (`focusTests`).
 */
import { AREAS, AREA_INFO } from "../data/areas";
import { focusOn, lab, node, set, unfocus } from "../engine/state";
import { useLab } from "../store";
import { EmptyPanel } from "./props/EmptyPanel.web";
import { resetModelFormOnSel } from "./props/ModelForm.web";
import { NodePanel } from "./props/NodePanel.web";
import { WirePanel } from "./props/WirePanel.web";
import { FocusTests } from "./Tests.web";

/** The focused step's test cases: its area chips and the chosen area's cases (the artifact's `focusTests`). */
function TestCases({ id }: { id: string }) {
  const n = node(id);
  if (!n) return null;
  const areas = (n.areas || []).filter((a) => AREAS[a]);
  if (!lab.fArea || !areas.includes(lab.fArea)) lab.fArea = areas[0] || null;
  const fArea = lab.fArea;
  if (fArea) lab.tArea = fArea;

  return (
    <div className="grp">
      <h4>Test cases</h4>
      {areas.length ? (
        <>
          <div className="chips" style={{ marginBottom: 8 }}>
            {areas.map((a) => (
              <button key={a} className="tg" data-farea={a} aria-pressed={a === fArea} onClick={() => set({ fArea: a })}>
                {`${AREAS[a]} · ${AREA_INFO[a]?.int ? "integration" : "unit"}`}
              </button>
            ))}
          </div>
          <div id="fcTests">{fArea ? <FocusTests /> : null}</div>
        </>
      ) : (
        <p className="hint">No test cases reach this step yet: a change here runs nothing until one does.</p>
      )}
    </div>
  );
}

export function Props() {
  useLab();
  resetModelFormOnSel();
  const sel = lab.sel;
  if (!sel) return null;

  const extra = (
    <>
      {sel.t === "node" && lab.view === "canvas" ? (
        <button
          className="ghost pfocus"
          title={lab.cfocus === sel.id ? "Back to the whole graph (Esc)" : "Focus on this step (double-click)"}
          onClick={() => (lab.cfocus === sel.id ? unfocus() : focusOn(sel.id))}
        >
          {lab.cfocus === sel.id ? "Whole graph" : "Focus"}
        </button>
      ) : null}
      <button
        className="ib pclose"
        aria-label="Close"
        style={{ width: 32, height: 32 }}
        onClick={() => {
          set({ sel: null });
          if (lab.cfocus) unfocus();
        }}
      >
        <svg className="i" viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </>
  );

  let panel;
  if (sel.t === "edge") panel = <WirePanel extra={extra} />;
  else {
    const n = node(sel.id);
    panel = n ? <NodePanel n={n} extra={extra} /> : <EmptyPanel extra={extra} />;
  }

  const cf = lab.cfocus;
  const wide = !!(cf && lab.view === "canvas" && sel.t === "node" && sel.id === cf);
  return (
    <>
      {panel}
      {wide && cf ? <TestCases id={cf} /> : null}
    </>
  );
}

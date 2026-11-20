/**
 * The step panel's "Test cases" (Dev2, 2026-11-15: "an easy way to add test cases"): how many of its 100 cases test
 * this step, the bench areas they come from, and its own cases with their add form (`tests/NodeCases.tsx`).
 */
import { AREAS } from "../../data/areas";
import { CASE_CAP, casesIn, nodeArea, stepCount } from "../../engine/cases";
import { drafts } from "../../engine/caseDraft";
import { go, lab } from "../../engine/state";
import { useLab } from "../../store";
import type { LabNode } from "../../types";
import { NodeCases } from "../tests/NodeCases";

export function StepCases({ n }: { n: LabNode }) {
  useLab();
  const areas = (n.areas || []).filter((a) => AREAS[a]);
  const own = casesIn(nodeArea(n.id)).length;
  if (!areas.length) {
    return (
      <div className="grp" id="nCases">
        <NodeCases id={n.id} compact />
      </div>
    );
  }
  return (
    <div className="grp" id="nCases">
      <div className="nch">
        <span className="nlbl" style={{ flex: 1 }}>
          Test cases
        </span>
        <span className="cnt">{stepCount(n)} cases</span>
      </div>
      <div className="chips">
        {areas.map((a) => (
          <button
            key={a}
            className="tg"
            data-opencases={a}
            onClick={() => {
              lab.tArea = a;
              drafts.node = null;
              go("tests");
            }}
          >
            {AREAS[a]} · {casesIn(a).length}/{CASE_CAP}
          </button>
        ))}
      </div>
      {own ? <NodeCases id={n.id} compact /> : null}
    </div>
  );
}

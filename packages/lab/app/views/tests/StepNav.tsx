/**
 * The Tests page's step list (Dev2, 2026-11-15): every step, each with how full it is against the 20-case cap, and
 * the steps no case tests yet under "No cases yet", model steps first, each with its own "+ Add case".
 */
import { Fragment } from "react";
import { AREAS, AREA_INFO, EXAMINABLE } from "../../data/areas";
import { CASE_CAP, casesIn, emptySteps, modelLine, nodeArea, nodeCaseSteps, stepById } from "../../engine/cases";
import { drafts, startNodeCase } from "../../engine/caseDraft";
import { isPicked } from "../../engine/diff";
import { emit, lab, MAIN, node } from "../../engine/state";
import { useLab } from "../../store";
import { Ic } from "../ic";
import { caseFit, setPipeScn } from "./caseParts";

/** How many of the cap a step uses, as a short bar. */
export function Meter({ n, w = 40 }: { n: number; w?: number }) {
  return (
    <span className="meter" style={{ width: w }} aria-hidden="true">
      <i style={{ width: `${Math.min(100, (n / CASE_CAP) * 100)}%` }} />
    </span>
  );
}

function pick(area: string) {
  lab.tArea = area;
  drafts.node = null;
  drafts.swap = null;
  setPipeScn(null);
  emit();
}

function AreaButton({ k, v }: { k: string; v: string }) {
  const cs = casesIn(k);
  const st = node(AREA_INFO[k]?.step ?? "", MAIN.graph);
  const b = cs.filter((c) => caseFit(c).length).length;
  return (
    <button data-area={k} aria-current={k === lab.tArea ? "true" : "false"} onClick={() => pick(k)}>
      <Ic k={st?.icon || "judge"} style={{ width: 16, height: 16 }} />
      <span className="an">
        {v}
        <small>{st?.label || ""}</small>
      </span>
      <Meter n={cs.length} />
      <span className="ac" title={`${cs.filter(isPicked).length} in the run`}>
        {cs.length}/{CASE_CAP}
      </span>
      {b ? <span className="pill warn" title="Cases that can't test this version as written">{b}</span> : null}
      {EXAMINABLE.has(k) ? null : <span className="pill warn" title="Needs API credits">credits</span>}
    </button>
  );
}

/** A step with cases of its own, beside the unit areas. */
function NodeButton({ id }: { id: string }) {
  const area = nodeArea(id);
  const n = stepById(id);
  const cs = casesIn(area);
  return (
    <button data-area={area} aria-current={area === lab.tArea ? "true" : "false"} onClick={() => pick(area)}>
      <Ic k={n?.icon || "judge"} style={{ width: 16, height: 16 }} />
      <span className="an">
        {n?.label ?? id}
        <small>{n ? modelLine(n) : ""}</small>
      </span>
      <Meter n={cs.length} />
      <span className="ac">
        {cs.length}/{CASE_CAP}
      </span>
    </button>
  );
}

const EMPTY_SHOWN = 5;

function EmptySteps() {
  const list = emptySteps();
  if (!list.length) return null;
  const shown = drafts.showAllEmpty ? list : list.slice(0, EMPTY_SHOWN);
  return (
    <>
      <div className="anh nocase">
        <b>No cases yet</b>
        <small style={{ flex: 1 }}>{list.length} steps</small>
        <small>model steps first</small>
      </div>
      {shown.map((n) => (
        <div key={n.id} className="erow" data-empty={n.id} aria-current={lab.tArea === nodeArea(n.id) ? "true" : "false"}>
          <span className="an">
            {n.label}
            <small>{modelLine(n)}</small>
          </span>
          <button
            className="addc"
            data-addcase={n.id}
            onClick={() => {
              pick(nodeArea(n.id));
              startNodeCase(n.id);
            }}
          >
            + Add case
          </button>
        </div>
      ))}
      {list.length > EMPTY_SHOWN ? (
        <button className="more" id="emptyMore" onClick={() => ((drafts.showAllEmpty = !drafts.showAllEmpty), emit())}>
          {drafts.showAllEmpty ? "Show fewer" : `Show ${list.length - EMPTY_SHOWN} more`}
        </button>
      ) : null}
    </>
  );
}

const GROUPS: Array<[string, string, (k: string) => boolean]> = [
  ["Unit", "one step alone", (k) => !AREA_INFO[k]?.int],
  ["Integration", "the whole turn", (k) => !!AREA_INFO[k]?.int],
];

export function StepNav() {
  useLab();
  const own = nodeCaseSteps().map((n) => n.id);
  return (
    <nav className="anav" aria-label="Steps">
      {lab.tester === "me" ? (
        <>
          <div className="anh">
            Yours<small>replayed read only</small>
          </div>
          <button data-area="mine" aria-current={lab.tArea === "mine" ? "true" : "false"} onClick={() => pick("mine")}>
            <Ic k="text" style={{ width: 16, height: 16 }} />
            <span className="an">
              Your texts
              <small>{lab.me?.name || "You"}</small>
            </span>
            <span className="ac">{Array.isArray(lab.myTexts) ? lab.myPicks.length + "/" + lab.myTexts.length : ""}</span>
          </button>
        </>
      ) : null}
      <div className="anh every">
        Every step<small>at most {CASE_CAP} cases each</small>
      </div>
      {GROUPS.map(([h, sub, f], gi) => (
        <Fragment key={h}>
          <div className="anh2">
            {h} · {sub}
          </div>
          {Object.entries(AREAS)
            .filter(([k]) => f(k))
            .map(([k, v]) => (
              <AreaButton key={k} k={k} v={v} />
            ))}
          {gi === 0 ? own.map((id) => <NodeButton key={id} id={id} />) : null}
        </Fragment>
      ))}
      <EmptySteps />
    </nav>
  );
}

/**
 * The Lab's Tests page, ported from the artifact's "test cases" section
 * (`renderTests0`): the area nav, and the area's cases with their run boxes,
 * edit forms and fit warnings. `FocusTests` is the same main column for the
 * canvas's focus side panel.
 */
import { Fragment } from "react";
import { AREAS, AREA_INFO, EXAMINABLE } from "../data/areas";
import { CASES } from "../labData.generated";
import { allCases, isPicked, picks } from "../engine/diff";
import { MAIN, emit, forkFromMain, isMain, lab, node } from "../engine/state";
import { dropCase, saveCase, useLab } from "../store";
import type { LabCase } from "../types";
import { Ic } from "./ic";
import { CaseThread, CaseWant, IoPanel, WhoPanel, caseFit, setPipeScn } from "./tests/caseParts";

/** The case whose text is open for editing (the artifact's `tEdit`), shared by both pages. */
let tEdit: string | null = null;

/** A change to the run or a case: fork from main first, then keep it (the artifact's `pickEdit`). */
function pickEdit(fn: () => void) {
  if (isMain()) forkFromMain();
  fn();
  lab.dirty = true;
  emit();
}

const NAV_GROUPS: Array<[string, string, (k: string) => boolean]> = [
  ["Unit", "one step alone", (k) => !AREA_INFO[k]?.int],
  ["Integration", "the whole turn", (k) => !!AREA_INFO[k]?.int],
];

function AreaButton({ k, v }: { k: string; v: string }) {
  const cs = allCases().filter((c) => c.area === k);
  const st = node(AREA_INFO[k]?.step ?? "", MAIN.graph);
  const b = cs.filter((c) => caseFit(c).length).length;
  return (
    <button
      data-area={k}
      aria-current={k === lab.tArea ? "true" : "false"}
      onClick={() => {
        lab.tArea = k;
        tEdit = null;
        setPipeScn(null);
        emit();
      }}
    >
      <Ic k={st?.icon || "judge"} style={{ width: 16, height: 16 }} />
      <span className="an">
        {v}
        <small>{st?.label || ""}</small>
      </span>
      <span className="ac">
        {cs.filter(isPicked).length}/{cs.length}
      </span>
      {b ? <span className="pill warn" title="Cases that can't test this version as written">{b}</span> : null}
      {EXAMINABLE.has(k) ? null : <span className="pill warn" title="Needs API credits">credits</span>}
    </button>
  );
}

function AreaNav() {
  useLab();
  return (
    <nav className="anav" aria-label="Areas">
      {NAV_GROUPS.map(([h, sub, f]) => (
        <Fragment key={h}>
          <div className="anh">
            {h}
            <small>{sub}</small>
          </div>
          {Object.entries(AREAS)
            .filter(([k]) => f(k))
            .map(([k, v]) => (
              <AreaButton key={k} k={k} v={v} />
            ))}
        </Fragment>
      ))}
    </nav>
  );
}

/** Keep the case: the edited texts from the two boxes, saved for everyone. */
function keep(id: string) {
  const area = lab.tArea;
  const base = CASES.find((c) => c.area === area && c.id === id);
  const val = (attr: string) => document.querySelector<HTMLTextAreaElement>(`[${attr}="${CSS.escape(id)}"]`)?.value ?? "";
  tEdit = null;
  void saveCase({
    ...(lab.caseEdits[area + "/" + id] || {}),
    area,
    id,
    ask: val("data-ask"),
    expect: val("data-exp"),
    isNew: !base,
    by: lab.myId,
    at: Date.now(),
  });
}

function TestCard({ c, inArea }: { c: LabCase; inArea: LabCase[] }) {
  const meta = c as LabCase & { chat?: string; must?: boolean; group?: string };
  const ed = lab.caseEdits[c.area + "/" + c.id];
  const on = isPicked(c);
  const id = c.id;
  const fit = caseFit(c);
  return (
    <article className={`tc ${on ? "" : "off"}`}>
      <div className="tch">
        <label className="inrun" title="In the run">
          <input
            type="checkbox"
            checked={on}
            data-pick={id}
            aria-label={`Run ${id}`}
            onChange={(e) => {
              const checked = e.target.checked;
              pickEdit(() => {
                const p = picks();
                const area = lab.tArea;
                if (!p[area]) p[area] = inArea.map((x) => x.id);
                p[area] = checked ? [...new Set([...p[area], id])] : p[area].filter((x) => x !== id);
              });
            }}
          />
        </label>
        <span className="cid">{id}</span>
        {meta.chat ? <span className="pill">{meta.chat === "group" ? "group" : "1:1"}</span> : null}
        {meta.must ? <span className="pill acc">tagged</span> : null}
        {meta.group ? <span className="pill">{meta.group}</span> : null}
        {ed ? <span className="pill acc">{ed.isNew ? "new" : "edited"}</span> : null}
        <span className="spacer"></span>
        <button
          className="ib sm"
          data-edit={id}
          aria-label={`Edit ${id}`}
          aria-pressed={tEdit === c.id ? "true" : "false"}
          onClick={() => {
            tEdit = tEdit === id ? null : id;
            emit();
          }}
        >
          <svg className="i" viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
            <path d="M4 20h4L19 9l-4-4L4 16z" />
          </svg>
        </button>
      </div>
      <div className="thr">
        <CaseThread c={c} ed={ed} />
      </div>
      <CaseWant c={c} ed={ed} />
      {fit.length ? (
        <div className="fitw">
          {fit.map((x, i) => (
            <div key={i}>{x}</div>
          ))}
        </div>
      ) : null}
      {tEdit === c.id ? (
        <div className="ed">
          <textarea className="note" rows={2} data-ask={id} aria-label="The text" defaultValue={c.ask} />
          <textarea className="note" rows={2} data-exp={id} aria-label="What's right" defaultValue={c.expect} />
          <div className="flex" style={{ justifyContent: "flex-end" }}>
            {ed ? (
              <button
                className="ghost"
                data-undo={id}
                onClick={() => {
                  tEdit = null;
                  void dropCase(c.area + "/" + id);
                }}
              >
                {"Back to main's"}
              </button>
            ) : null}
            <button className="primary" data-savecase={id} onClick={() => keep(id)}>
              Keep
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/** The area's main column: who runs it, the test panel, the toolbar and the case cards. */
function TMain() {
  useLab();
  const tArea = lab.tArea;
  const inArea = allCases().filter((c) => c.area === tArea);
  const list = inArea.filter((c) => !lab.tQ || (c.id + " " + c.ask + " " + c.expect).toLowerCase().includes(lab.tQ));
  return (
    <section className="tmain">
      <WhoPanel area={tArea} inArea={inArea} />
      <IoPanel area={tArea} />
      <div className="tbar">
        <input
          className="search"
          id="caseQ"
          placeholder="Search"
          value={lab.tQ}
          aria-label="Search cases"
          onChange={(e) => {
            lab.tQ = e.target.value.toLowerCase();
            emit();
          }}
        />
        <span className="hint">
          {inArea.filter(isPicked).length} of {inArea.length} in the run
        </span>
        <span className="spacer"></span>
        <button className="ghost" id="selAll" onClick={() => pickEdit(() => { delete picks()[lab.tArea]; })}>
          All
        </button>
        <button className="ghost" id="selNone" onClick={() => pickEdit(() => { picks()[lab.tArea] = []; })}>
          None
        </button>
        <button
          className="primary"
          id="addCase"
          onClick={() => {
            let i = 1;
            while (lab.caseEdits[lab.tArea + "/new-" + i]) i++;
            tEdit = "new-" + i;
            void saveCase({ area: lab.tArea, id: "new-" + i, ask: "The text", expect: "What's right", isNew: true, by: lab.myId, at: Date.now() });
          }}
        >
          <svg className="i" viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
            <path d="M12 5v14M5 12h14" />
          </svg>
          Case
        </button>
      </div>
      <div className="tgrid">
        {/* Keyed by place too: the bench has ids that repeat inside an area (review/plain-answer). */}
        {list.map((c, i) => (
          <TestCard key={c.area + "/" + c.id + "/" + i} c={c} inArea={inArea} />
        ))}
        {list.length ? null : <p className="hint">No cases match.</p>}
      </div>
    </section>
  );
}

/** The Tests page: the area nav beside the area's main column. */
export function Tests() {
  useLab();
  return (
    <div className="tlay">
      <AreaNav />
      <TMain />
    </div>
  );
}

/** Only the main column, for the canvas's focus side panel. */
export function FocusTests() {
  useLab();
  return <TMain />;
}

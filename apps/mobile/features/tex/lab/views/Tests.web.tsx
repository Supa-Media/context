/**
 * The Lab's Tests page, ported from the artifact's "test cases" section
 * (`renderTests0`): the area nav, and the area's cases with their run boxes,
 * edit forms and fit warnings. `FocusTests` is the same main column for the
 * canvas's focus side panel.
 */
import { AREAS, AREA_INFO } from "../data/areas";
import { CASES } from "../labData.generated";
import { CASE_CAP, isNodeArea, modelLine, nextId } from "../engine/cases";
import { cancelSwap, drafts, keepSwap, pickSwapOut, startSwap, stepOfArea } from "../engine/caseDraft";
import { allCases, isPicked, picks } from "../engine/diff";
import { MAIN, emit, forkFromMain, isMain, lab, node } from "../engine/state";
import { dropCase, saveCase, useLab } from "../store";
import type { LabCase } from "../types";
import { CaseThread, CaseWant, IoPanel, WhoPanel, caseFit } from "./tests/caseParts";
import { NodeCases } from "./tests/NodeCases";
import { Meter, StepNav } from "./tests/StepNav";
import { MineMain } from "./mine/Mine.web";

/** The case whose text is open for editing (the artifact's `tEdit`), shared by both pages. */
let tEdit: string | null = null;

/** A change to the run or a case: fork from main first, then keep it (the artifact's `pickEdit`). */
function pickEdit(fn: () => void) {
  if (isMain()) forkFromMain();
  fn();
  lab.dirty = true;
  emit();
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
  const sw = drafts.swap?.area === c.area ? drafts.swap : null;
  const going = sw?.out === c.id;
  return (
    <article className={`tc ${on ? "" : "off"}${going ? " going" : ""}`} data-case={id}>
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
                if (!p[area]) p[area] = inArea.filter(isPicked).map((x) => x.id);
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
        {going ? <span className="pill">picked to go</span> : null}
        <span className="spacer"></span>
        {sw ? (
          <button className="ghost sm" data-swapout={id} aria-pressed={going} onClick={() => pickSwapOut(going ? null : id)}>
            {going ? "Keep it" : "Swap out"}
          </button>
        ) : null}
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
  if (lab.tArea === "mine") return lab.tester === "me" ? <MineMain /> : <BenchMain />;
  if (isNodeArea(lab.tArea)) return <NodeMain />;
  return <BenchMain />;
}

/** The step's title row: its name, its model, how many of its 20 it holds. */
function StepTitle({ title, model, n }: { title: string; model: string; n: number }) {
  return (
    <div className="sth">
      <h2>{title}</h2>
      {model ? <span className="pill">{model}</span> : null}
      <span className="spacer"></span>
      <span className="stc">
        {n} of {CASE_CAP}
      </span>
      <Meter n={n} w={120} />
    </div>
  );
}

/** The case going into a full step: written here, a card picked to go, then Keep. */
function SwapCard({ inArea }: { inArea: LabCase[] }) {
  const sw = drafts.swap;
  if (!sw) return null;
  const base = CASES.find((c) => c.area === sw.area && c.id === sw.out);
  return (
    <article className="tc swapin" id="swapCard">
      <div className="tch">
        <span className="cid">{sw.id}</span>
        <span className="pill warn">swapping in</span>
        <span className="spacer"></span>
        <span className="hint">replaces</span>
        <span className="cid gone">{sw.out ?? "pick one"}</span>
      </div>
      <textarea className="note" rows={2} id="swapAsk" aria-label="The text" placeholder="The text" value={sw.ask} onChange={(e) => ((sw.ask = e.target.value), emit())} />
      <textarea className="note" rows={2} id="swapExp" aria-label="What's right" placeholder="What's right" value={sw.expect} onChange={(e) => ((sw.expect = e.target.value), emit())} />
      <div className="hint">Pick the case it replaces with Swap out on its card, then Keep. Nothing leaves until you Keep.</div>
      <div className="flex" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" id="swapCancel" onClick={cancelSwap}>
          Cancel
        </button>
        <button className="primary" id="swapKeep" disabled={!sw.out || !sw.ask.trim() || !inArea.some((c) => c.id === sw.out)} onClick={() => void keepSwap(base)}>
          Keep
        </button>
      </div>
    </article>
  );
}

/** The reviewer's checks, each with how many of the step's cases test it. */
function Coverage({ inArea }: { inArea: LabCase[] }) {
  const by = new Map<string, number>();
  for (const c of inArea) {
    const g = typeof c.group === "string" ? c.group : null;
    if (g) by.set(g, (by.get(g) || 0) + 1);
  }
  if (by.size < 2) return null;
  return (
    <div className="cov" id="coverage">
      <span className="hint">Covers all {by.size} checks</span>
      {[...by].map(([g, n]) => (
        <span key={g} className="pill">
          {g} {n}
        </span>
      ))}
    </div>
  );
}

/** The cases this Lab traded out of the step, each one put back with a tap. */
function SwappedOut({ area }: { area: string }) {
  const gone = Object.values(lab.caseEdits).filter((e) => e.area === area && e.removed);
  if (!gone.length) return null;
  return (
    <p className="hint" id="swappedOut">
      Swapped out:{" "}
      {gone.map((e) => (
        <button key={e.id} className="ghost sm" data-putback={e.id} onClick={() => void dropCase(area + "/" + e.id)}>
          {e.id} · put back
        </button>
      ))}
    </p>
  );
}

function BenchMain() {
  useLab();
  const tArea = lab.tArea === "mine" ? "core" : lab.tArea;
  const inArea = allCases().filter((c) => c.area === tArea);
  const list = inArea.filter((c) => !lab.tQ || (c.id + " " + c.ask + " " + c.expect).toLowerCase().includes(lab.tQ));
  const full = inArea.length >= CASE_CAP;
  const st = node(AREA_INFO[tArea]?.step ?? "") ?? node(AREA_INFO[tArea]?.step ?? "", MAIN.graph);
  return (
    <section className="tmain">
      <StepTitle title={AREAS[tArea] ?? tArea} model={st ? modelLine(st) : ""} n={inArea.length} />
      {full ? (
        <div className="capb" id="capBanner">
          <svg className="i" viewBox="0 0 24 24" style={{ width: 16, height: 16 }} aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16v.5" />
          </svg>
          <span style={{ flex: 1 }}>This step is full. A new case goes in by swapping out one you pick, so the run stays at {CASE_CAP}.</span>
          <button className="primary" id="swapIn" disabled={!!drafts.swap} onClick={() => startSwap(tArea)}>
            + Swap in a case
          </button>
        </div>
      ) : null}
      <Coverage inArea={inArea} />
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
        <button className="ghost" id="selGate" title="The cases a change's replay runs" onClick={() => pickEdit(() => { delete picks()[lab.tArea]; })}>
          Replay's
        </button>
        <button className="ghost" id="selAll" onClick={() => pickEdit(() => { picks()[lab.tArea] = inArea.map((x) => x.id); })}>
          All
        </button>
        <button className="ghost" id="selNone" onClick={() => pickEdit(() => { picks()[lab.tArea] = []; })}>
          None
        </button>
        {full ? null : (
          <button
            className="primary"
            id="addCase"
            onClick={() => {
              const id = nextId(lab.tArea);
              tEdit = id;
              void saveCase({ area: lab.tArea, id, ask: "The text", expect: "What's right", isNew: true, by: lab.myId, at: Date.now() });
            }}
          >
            <svg className="i" viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Case
          </button>
        )}
      </div>
      <div className="tgrid">
        {drafts.swap?.area === tArea ? <SwapCard inArea={inArea} /> : null}
        {/* Keyed by place too: the bench has ids that repeat inside an area (review/plain-answer). */}
        {list.map((c, i) => (
          <TestCard key={c.area + "/" + c.id + "/" + i} c={c} inArea={inArea} />
        ))}
        {list.length ? null : <p className="hint">No cases match.</p>}
      </div>
      <SwappedOut area={tArea} />
    </section>
  );
}

/** A step's own cases (area node:<id>): its title, then the form and the kept cases. */
function NodeMain() {
  useLab();
  const n = stepOfArea(lab.tArea);
  if (!n) return <p className="hint">That step is not in this version.</p>;
  const count = allCases().filter((c) => c.area === lab.tArea).length;
  return (
    <section className="tmain" id="nodeMain">
      <StepTitle title={n.label} model={modelLine(n)} n={count} />
      <NodeCases id={n.id} />
    </section>
  );
}

/** The Tests page: the area nav beside the area's main column. */
export function Tests() {
  useLab();
  return (
    <div className="tlay">
      <StepNav />
      <TMain />
    </div>
  );
}

/** Only the main column, for the canvas's focus side panel. */
export function FocusTests() {
  useLab();
  return <TMain />;
}

/**
 * The Lab's step panel (Dev, 2026-11-26: "this whole side panel needs to be flogged, the goal should literally be the
 * first thing I see when clicking on a node to understand it"; artboards in the project's `node-panel-artboards/`).
 *
 * Top to bottom: the name, the Goal (`StepGoal.web.tsx`), one line of facts (`StatusRow`), then the switch between
 * "Run details" (what the step did for the test text picked, `RunCard.web.tsx`) and "Settings". Settings is one list,
 * one control per field: what changed from main, the settings (`SettingsCard.web.tsx`), Output, Reads, Wires and Test
 * cases, then "More" (closed: the code files, the chat's record, timing, the change note) and Delete. Each field changed
 * from main is outlined yellow with "was ... on main" under it. The card's foot says what it shows (`PanelFoot.web.tsx`).
 */
import { useState, type ReactNode } from "react";
import { AREAS, EXAMINABLE } from "../../data/areas";
import { ICONS, NODE_INFO, wireName } from "../../data/graph";
import { fieldText, stepChange } from "../../engine/changeMarks";
import { cacheShare, ctxTokens, fmtS, fmtUsd } from "../../engine/sim";
import { labSim, tracedReal } from "../../engine/realTimes";
import { delSel, G, go, lab, MODELS, node, set } from "../../engine/state";
import { scnLabel } from "../../engine/traces";
import { useLab } from "../../store";
import type { LabNode } from "../../types";
import { Ic } from "../ic";
import { CardSwitch } from "./CardSwitch.web";
import { RunCard, StatusRow, useStepRun } from "./RunCard.web";
import { PanelFoot } from "./PanelFoot.web";
import { SettingsCard } from "./SettingsCard.web";
import { setNode } from "./nodeEdit";
import { WireIcon } from "../parts";
import { onCommit } from "./change";
import { OutputGrp } from "./OutputFields.web";
import { StepCases } from "./StepCases.web";
import { StepChanges } from "./StepChanges.web";
import { StepGoal } from "./StepGoal.web";
import { AddPicker, ReadsStack } from "./ReadsStack.web";

export function NodePanel({ n, extra }: { n: LabNode; extra?: ReactNode }) {
  useLab();
  const g = G();
  const m = MODELS[n.model] || MODELS.code;
  const [picking, setPicking] = useState(false);
  // "More": the step's code files, record, timing and change note, closed until asked for.
  const [more, setMore] = useState(false);
  const wires = g.edges.map((e, i) => [e, i] as const).filter(([e]) => e.to === n.id || e.from === n.id);
  const { has, run } = useStepRun(n);
  const ch = stepChange(n.id);
  const card = lab.card ?? (has ? "run" : "set");
  const chgd = (f: string) => !!ch?.x.fields.includes(f);
  /** A changed field's outline class, and the line saying what main had. */
  const cc = (f: string, base = "") => (base + (chgd(f) ? " chgf" : "")).trim();
  const was = (f: string) => (chgd(f) && ch?.x.base ? <small className="was">{`was ${fieldText(ch.x.base, f)} on ${ch.vs}`}</small> : null);

  return (
    <>
      <div className="ph">
        {/* The badge picks the step's icon (Dev2, 2026-11-14: "there is no way to change the icons"). */}
        <button className="badge" id="nIcon" aria-label="Change the icon" aria-expanded={picking} title="Change the icon" style={{ color: `var(${m.c})` }} onClick={() => setPicking(!picking)}>
          <Ic k={n.icon} />
        </button>
        <input id="nLabel" aria-label="Step name" key={n.label} defaultValue={n.label} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "label", v))} />
        {extra}
      </div>
      {picking ? (
        <div className="icpick" id="nIconPick" role="listbox" aria-label="Icons">
          {Object.keys(ICONS)
            .filter((k) => k !== "trash" && k !== "wire")
            .map((k) => (
              <button
                key={k}
                data-icon={k}
                role="option"
                aria-selected={n.icon === k}
                aria-label={k}
                onClick={() => {
                  setNode(n.id, "icon", k);
                  setPicking(false);
                }}
              >
                <Ic k={k} />
              </button>
            ))}
        </div>
      ) : null}
      <StepGoal key={n.id} n={n} card={card} />
      <StatusRow n={n} card={card} run={run} />
      <CardSwitch card={card} changed={!!ch && ch.x.kind === "changed"} />
      {card === "run" ? (
        <RunCard n={n} has={has} run={run} />
      ) : (
        <>
          <StepChanges n={n} />
          <SettingsCard n={n} />
          {m.runs !== "code" ? (
            <div className={cc("output")}>
              <OutputGrp n={n} m={m} />
              {was("output")}
            </div>
          ) : null}
          {m.runs !== "code" ? (
            <>
              <div className={cc("reads", "grp")}>
                <h4>
                  Reads<small>{`${(ctxTokens(n, g) / 1000).toFixed(1)}k · ${Math.round(cacheShare(n, g) * 100)}% cached`}</small>
                </h4>
                {was("reads")}
                <ReadsStack n={n} g={g} />
                <button className="add" id="addCtx" style={{ marginTop: 8 }} aria-expanded={lab.addCtxOpen} onClick={() => set({ addCtxOpen: !lab.addCtxOpen })}>
                  <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add
                </button>
              </div>
              {lab.addCtxOpen ? <AddPicker n={n} g={g} /> : null}
            </>
          ) : null}
          <div className="grp">
            <h4>Wires</h4>
            {wires.length ? (
              wires.map(([e, i]) => {
                const out = e.from === n.id;
                const other = out ? node(e.to) : node(e.from);
                return (
                  <button key={i} className="wr" data-wire={i} onClick={() => set({ sel: { t: "edge", i } })}>
                    <span className="hint" style={{ width: 34, fontSize: 11 }}>
                      {out ? "to" : "from"}
                    </span>
                    <WireIcon mode={e.mode} />
                    <span style={{ flex: 1 }}>{other?.label}</span>
                    <span className="hint" style={{ fontSize: 12 }}>
                      {wireName(e)}
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="hint" style={{ margin: 0 }}>
                Not wired yet. Drag from its edge dot to another step.
              </p>
            )}
          </div>
          <StepCases n={n} />
          <button className="adv" id="nMore" aria-expanded={more} onClick={() => setMore(!more)}>
            <span className="car">▸</span>More<small>code, record, timing, change note</small>
          </button>
          {more ? <MoreSettings n={n} cc={cc} was={was} /> : null}
          {["text", "send"].includes(n.id) ? null : (
            <div className="delrow">
              <button className="danger" id="nDel" onClick={delSel}>
                <Ic k="trash" />
                Delete this step
              </button>
            </div>
          )}
        </>
      )}
      <PanelFoot card={card} ran={run.state !== "none"} />
    </>
  );
}

/** What "More" opens: the step's code files, its tool stats, the chat's record, what it ran with, its timing and change note. */
function MoreSettings({ n, cc, was }: { n: LabNode; cc: (f: string, base?: string) => string; was: (f: string) => ReactNode }) {
  const g = G();
  const t = labSim(g).T[n.id];
  const io = tracedReal() ? lab.real?.io?.[n.id] : undefined;
  return (
    <div className="advbody">
      <div className="sub">Code</div>
      <div className={cc("code", "file")}>{n.file || "new step"}</div>
      {was("code")}
      {n.id === "tools" ? (
        <button className="ghost" id="nToolStats" style={{ marginTop: 8 }} onClick={() => go("tools")}>
          <Ic k="tools" />
          Tool use, times and errors
        </button>
      ) : null}
      <div className={cc("record")}>
        <div className="sub">The chat's record</div>
        <div className="toggle">
          <span>{n.log ? "Writes " + (NODE_INFO[n.id]?.logs || ["its entries"]).join(", ") : "Writes nothing"}</span>
          <button className="sw" id="nLog" role="switch" aria-checked={!!n.log} aria-label="Writes to the chat's record" onClick={() => setNode(n.id, "log", !n.log)} />
        </div>
        {was("record")}
        {n.log ? null : <p className="hint lgno">Debugging this step means the turn trace or the worker log. Turn it on to make it a code change.</p>}
      </div>
      {io?.length ? (
        // What this step got and gave when it ran for one of your texts (`realTimes.ts` realIO).
        <div id="nIO">
          <div className="sub">{`In “${scnLabel(lab.scn)}”, it ran with`}</div>
          {io.map((l, i) => (
            <div key={i} className="io">
              <b>{l.k}</b>
              <pre>{l.v}</pre>
            </div>
          ))}
        </div>
      ) : null}
      {t ? (
        <>
          <div className="sub">{`In “${scnLabel(lab.scn)}”`}</div>
          <div className="est">
            <div className="big">{fmtS(t.ms)}</div>
            {t.parts.map((p, i) => (
              <div key={i} className="row">
                <span>{(p.own ? "Its own work" : p.id === "sendback" ? "Send-backs" : node(p.id)?.label || p.id) + (p.note ? " · " + p.note : "")}</span>
                <span>{fmtS(p.ms)}</span>
              </div>
            ))}
            <div className="row">
              <span>Cost</span>
              <span>{fmtUsd(t.usd)}</span>
            </div>
          </div>
        </>
      ) : null}
      <div className="sub">Change note</div>
      <textarea className="note" id="nNote" rows={2} placeholder="What code has to do that the boxes can't say" key={n.note} defaultValue={n.note} ref={onCommit<HTMLTextAreaElement>((v) => setNode(n.id, "note", v))} />
      <div className="chips" style={{ marginTop: 8 }}>
        {n.areas.length ? (
          n.areas.map((a) => (
            <span key={a} className={`pill ${EXAMINABLE.has(a) ? "" : "warn"}`}>
              <Ic k="judge" style={{ width: 13, height: 13 }} />
              {AREAS[a] || a}
            </span>
          ))
        ) : (
          <span className="pill warn">No test cases reach this step</span>
        )}
      </div>
    </div>
  );
}

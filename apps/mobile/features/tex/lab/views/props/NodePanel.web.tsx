/**
 * The Lab's step panel: the artifact's `renderProps0` for a selected step
 * (its `.ph` header, goal, log switch, running switch, model, effort, the
 * reads and output fields, wires, the scenario's own timing, the change note
 * and delete). Ported with the same markup, classes and ids.
 *
 * Lab live sandbox (approved mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): a switch at the top picks the
 * card, "Run details" (what the step did for the test text picked, `RunCard.web.tsx`) or "Settings": the mockup's short
 * list (`SettingsCard.web.tsx`), and everything below behind "More settings", each field changed from main outlined
 * yellow with "was ... on main" under it. The card's foot says what it shows (`PanelFoot.web.tsx`).
 */
import { useState, type ReactNode } from "react";
import { AREAS, EXAMINABLE } from "../../data/areas";
import { ICONS, NODE_INFO, wireName } from "../../data/graph";
import { fieldText, stepChange } from "../../engine/changeMarks";
import { cacheShare, ctxTokens, fmtS, fmtUsd, outTok } from "../../engine/sim";
import { labSim, tracedReal } from "../../engine/realTimes";
import { delSel, G, go, lab, MODELS, node, set } from "../../engine/state";
import { scnLabel } from "../../engine/traces";
import { useLab } from "../../store";
import type { LabNode } from "../../types";
import { Ic } from "../ic";
import { CardSwitch } from "./CardSwitch.web";
import { RunCard, StatusBadge, StatusRow, useStepRun } from "./RunCard.web";
import { PanelFoot } from "./PanelFoot.web";
import { SettingsCard } from "./SettingsCard.web";
import { pickModel, setNode } from "./nodeEdit";
import { WireIcon } from "../parts";
import { onCommit } from "./change";
import { EditModelLink, getModelForm, ModelForm, NewModelButton } from "./ModelForm.web";
import { OutputGrp } from "./OutputFields.web";
import { StepCases } from "./StepCases.web";
import { StepChanges } from "./StepChanges.web";
import { AddPicker, ReadsStack } from "./ReadsStack.web";
import { EFFORTS } from "@context/shared/src/texConfigSchema.cjs";

export function NodePanel({ n, extra }: { n: LabNode; extra?: ReactNode }) {
  useLab();
  const g = G();
  const m = MODELS[n.model] || MODELS.code;
  const t = labSim(g).T[n.id];
  const io = tracedReal() ? lab.real?.io?.[n.id] : undefined;
  const [picking, setPicking] = useState(false);
  // The long panel, behind "More settings" on the Settings card (the mockup's card is the short list).
  const [more, setMore] = useState(false);
  const wires = g.edges.map((e, i) => [e, i] as const).filter(([e]) => e.to === n.id || e.from === n.id);
  const outTokens = outTok(n);
  const outLocked = !!n.outSchema?.length;
  const { has, run } = useStepRun(n);
  const ch = stepChange(n.id);
  const card = lab.card ?? (has ? "run" : "set");
  const chgd = (f: string) => !!ch?.x.fields.includes(f);
  /** A changed field's outline class, and the line saying what main had. */
  const cc = (f: string, base = "") => (base + (chgd(f) ? " chgf" : "")).trim();
  const was = (f: string) => (chgd(f) && ch?.x.base ? <small className="was">{`was ${fieldText(ch.x.base, f)} on ${ch.vs}`}</small> : null);

  return (
    <>
      <CardSwitch card={card} changed={!!ch && ch.x.kind === "changed"} />
      <div className="ph">
        {/* Not in the artifact: the badge picks the step's icon (Dev2, 2026-11-14: "there is no way to change the icons"). */}
        <button className="badge" id="nIcon" aria-label="Change the icon" aria-expanded={picking} title="Change the icon" style={{ color: `var(${m.c})` }} onClick={() => setPicking(!picking)}>
          <Ic k={n.icon} />
        </button>
        <input id="nLabel" aria-label="Step name" key={n.label} defaultValue={n.label} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "label", v))} />
        {card === "run" ? <StatusBadge run={run} /> : null}
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
      <StatusRow n={n} card={card} run={run} draft={lab.cur.name} />
      {card === "run" ? (
        <RunCard n={n} has={has} run={run} />
      ) : (
        <>
      <SettingsCard n={n} />
      {io?.length ? (
        // Not in the artifact: what this step got and gave when it ran for one of your texts (`realTimes.ts` realIO).
        <div className="grp" id="nIO">
          <h4>{`In “${scnLabel(lab.scn)}”, it ran with`}</h4>
          {io.map((l, i) => (
            <div key={i} className="io">
              <b>{l.k}</b>
              <pre>{l.v}</pre>
            </div>
          ))}
        </div>
      ) : null}
      <StepChanges n={n} />
      <StepCases n={n} />
      <button className="more" id="nMore" aria-expanded={more} onClick={() => setMore(!more)}>
        {more ? "Fewer settings ▴" : "More settings ▾"}
      </button>
      {more ? (
        <>
      <div className={cc("code", "file")}>{n.file || "new step"}</div>
      {was("code")}
      <div className={cc("goal", "grp")}>
        <h4>Goal</h4>
        {was("goal")}
        <textarea className="note" id="nGoal" rows={3} placeholder="Why this step exists: what goes wrong without it" key={n.goal || ""} defaultValue={n.goal || ""} ref={onCommit<HTMLTextAreaElement>((v) => setNode(n.id, "goal", v.trim()))} />
      </div>
      {n.id === "tools" ? (
        <div className="grp">
          <button className="ghost" id="nToolStats" onClick={() => go("tools")}>
            <Ic k="tools" />
            Tool use, times and errors
          </button>
        </div>
      ) : null}
      <div className={cc("record", "grp")}>
        <h4>The chat's record</h4>
        {was("record")}
        <div className="toggle">
          <span>{n.log ? "Writes " + (NODE_INFO[n.id]?.logs || ["its entries"]).join(", ") : "Writes nothing"}</span>
          <button className="sw" id="nLog" role="switch" aria-checked={!!n.log} aria-label="Writes to the chat's record" onClick={() => setNode(n.id, "log", !n.log)} />
        </div>
        {n.log ? null : (
          <p className="hint lgno" style={{ margin: "6px 0 0" }}>
            Debugging this step means the turn trace or the worker log. Turn it on to make it a code change.
          </p>
        )}
      </div>
      <div className={cc("running", "grp")}>
        <div className="toggle">
          <span>Running</span>
          <button className="sw" id="nOn" role="switch" aria-checked={n.on} aria-label="Running" onClick={() => setNode(n.id, "on", !n.on)} />
        </div>
        {was("running")}
      </div>
      <div className="grp">
        <h4>Model</h4>
        <div className={cc("model", "seg")} id="nModel">
          {Object.entries(MODELS).map(([k, v]) => (
            <button key={k} data-v={k} aria-pressed={k === n.model} onClick={() => pickModel(n.id, k)}>
              <span className="mdot" style={{ background: `var(${v.c})` }} />
              {v.name}
            </button>
          ))}
          <NewModelButton />
        </div>
        {was("model")}
        <EditModelLink m={m} />
        {getModelForm() ? <ModelForm /> : null}
        {m.runs === "code" ? (
          <div className="nums" style={{ marginTop: 10, gridTemplateColumns: "1fr" }}>
            <label className="num">
              <span>Time, ms</span>
              <input type="number" id="nMs" key={String(n.ms || 0)} defaultValue={n.ms || 0} min={0} step={50} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "ms", +v))} />
            </label>
          </div>
        ) : (
          <>
            {m.runs === "api" ? null : (
              <>
                <h4 style={{ marginTop: 12 }}>Effort</h4>
                <div className={cc("effort", "seg")} id="nEffort">
                  {EFFORTS.map((k) => (
                    <button key={k} data-v={k} aria-pressed={(n.effort || "medium") === k} onClick={() => setNode(n.id, "effort", k)}>
                      {k}
                    </button>
                  ))}
                </div>
                {was("effort")}
              </>
            )}
            <div className="nums" style={{ marginTop: 10 }}>
              <label className={cc("rounds", "num")}>
                <span>Rounds</span>
                <input type="number" id="nRounds" key={String(n.rounds)} defaultValue={n.rounds} min={1} max={40} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "rounds", +v))} />
                {was("rounds")}
              </label>
              <label className={cc("tokens out", "num")}>
                <span>Tokens out</span>
                <input
                  type="number"
                  id="nOut"
                  key={String(outTokens)}
                  defaultValue={outTokens}
                  min={0}
                  step={10}
                  disabled={outLocked}
                  title={outLocked ? "Set by the output fields" : undefined}
                  ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "out", +v))}
                />
                {was("tokens out")}
              </label>
              <label className={cc("limit", "num")}>
                <span>Limit, s</span>
                <input type="number" id="nTo" key={String(n.timeoutS || 0)} defaultValue={n.timeoutS || 0} min={0} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "timeoutS", +v))} />
                {was("limit")}
              </label>
            </div>
            <div className="flex" style={{ marginTop: 10 }}>
              <span className={`pill ${m.runs === "api" ? "warn" : "acc"}`}>{m.runs === "api" ? "Real API call in a run" : "A Claude agent stands in"}</span>
              {m.measured ? <span className="pill ok">speed measured</span> : <span className="pill">speed estimated</span>}
            </div>
          </>
        )}
        {m.note ? (
          <p className="hint" style={{ margin: "8px 0 0" }}>
            {m.note}
          </p>
        ) : null}
      </div>
      {m.runs !== "code" ? (
        <div className={cc("output")}>
          <OutputGrp n={n} m={m} />
          {was("output")}
        </div>
      ) : null}
      {m.runs !== "code" ? (
        <>
        <div className={cc("reads", "grp")}>
          <h4>{`Reads · ${(ctxTokens(n, g) / 1000).toFixed(1)}k · ${Math.round(cacheShare(n, g) * 100)}% cached`}</h4>
          {was("reads")}
          <ReadsStack n={n} g={g} />
          <div style={{ marginTop: 8 }}>
            <button className="add" id="addCtx" aria-expanded={lab.addCtxOpen} onClick={() => set({ addCtxOpen: !lab.addCtxOpen })}>
              <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add
            </button>
          </div>
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
      {t ? (
        <div className="grp">
          <h4>{`In “${scnLabel(lab.scn)}”`}</h4>
          <div className="est">
            <div className="big">{fmtS(t.ms)}</div>
            {t.parts.map((p, i) => (
              <div key={i} className="row">
                <span>
                  {(p.own ? "Its own work" : p.id === "sendback" ? "Send-backs" : node(p.id)?.label || p.id) + (p.note ? " · " + p.note : "")}
                </span>
                <span>{fmtS(p.ms)}</span>
              </div>
            ))}
            <div className="row">
              <span>Cost</span>
              <span>{fmtUsd(t.usd)}</span>
            </div>
          </div>
        </div>
      ) : null}
      <div className="grp">
        <h4>Change note</h4>
        <textarea className="note" id="nNote" rows={3} placeholder="What code has to do that the boxes can't say" key={n.note} defaultValue={n.note} ref={onCommit<HTMLTextAreaElement>((v) => setNode(n.id, "note", v))} />
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
      {["text", "send"].includes(n.id) ? null : (
        <div className="grp">
          <button className="danger" id="nDel" onClick={delSel}>
            <Ic k="trash" />
            Delete this step
          </button>
        </div>
      )}
        </>
      ) : null}
        </>
      )}
      <PanelFoot card={card} ran={run.state !== "none"} />
    </>
  );
}

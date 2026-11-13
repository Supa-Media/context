/**
 * The Lab's step panel: the artifact's `renderProps0` for a selected step
 * (its `.ph` header, goal, log switch, running switch, model, effort, the
 * reads and output fields, wires, the scenario's own timing, the change note
 * and delete). Ported with the same markup, classes and ids.
 */
import type { ReactNode } from "react";
import { AREAS, EXAMINABLE } from "../../data/areas";
import { NODE_INFO, WIRES } from "../../data/graph";
import { cacheShare, ctxTokens, fmtS, fmtUsd, outTok, simulate } from "../../engine/sim";
import { delSel, edit, G, go, lab, MODELS, node, set } from "../../engine/state";
import { scnLabel } from "../../engine/traces";
import { useLab } from "../../store";
import type { LabNode } from "../../types";
import { Ic } from "../ic";
import { WireIcon } from "../parts";
import { onCommit } from "./change";
import { EditModelLink, getModelForm, ModelForm, NewModelButton } from "./ModelForm.web";
import { OutputGrp } from "./OutputFields.web";
import { AddPicker, ReadsStack } from "./ReadsStack.web";

/** The artifact's `set(k, v)` in the node branch: edits the step by id, so a fork of main is taken first. */
function setNode<K extends keyof LabNode>(id: string, k: K, v: LabNode[K]) {
  edit(() => {
    const x = node(id);
    if (x) x[k] = v;
  });
}

/** A model button's pick: a code step keeps no effort; an api-only model gets its one-question schema. */
function pickModel(id: string, k: string) {
  edit(() => {
    const x = node(id);
    if (!x) return;
    x.model = k;
    if (MODELS[k].runs !== "code" && !x.effort) x.effort = "medium";
    if (MODELS[k].typed === "only" && !x.outSchema?.length) x.outSchema = [{ name: "answer", type: "choice", options: "yes, no, unsure" }];
    if (MODELS[k].typed === "only") x.outSchema = (x.outSchema || []).map((f) => (f.type === "text" ? { ...f, type: "choice" } : f));
  });
}

export function NodePanel({ n, extra }: { n: LabNode; extra?: ReactNode }) {
  useLab();
  const g = G();
  const m = MODELS[n.model] || MODELS.code;
  const t = simulate(g, lab.scn, lab.logRows).T[n.id];
  const wires = g.edges.map((e, i) => [e, i] as const).filter(([e]) => e.to === n.id || e.from === n.id);
  const outTokens = outTok(n);
  const outLocked = !!n.outSchema?.length;

  return (
    <>
      <div className="ph">
        <div className="badge" style={{ color: `var(${m.c})` }}>
          <Ic k={n.icon} />
        </div>
        <input id="nLabel" aria-label="Step name" key={n.label} defaultValue={n.label} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "label", v))} />
        {extra}
      </div>
      <div className="file">{n.file || "new step"}</div>
      <div className="grp">
        <h4>Goal</h4>
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
      <div className="grp">
        <h4>The chat's record</h4>
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
      <div className="grp">
        <div className="toggle">
          <span>Running</span>
          <button className="sw" id="nOn" role="switch" aria-checked={n.on} aria-label="Running" onClick={() => setNode(n.id, "on", !n.on)} />
        </div>
      </div>
      <div className="grp">
        <h4>Model</h4>
        <div className="seg" id="nModel">
          {Object.entries(MODELS).map(([k, v]) => (
            <button key={k} data-v={k} aria-pressed={k === n.model} onClick={() => pickModel(n.id, k)}>
              <span className="mdot" style={{ background: `var(${v.c})` }} />
              {v.name}
            </button>
          ))}
          <NewModelButton />
        </div>
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
                <div className="seg" id="nEffort">
                  {["off", "low", "medium", "high", "xhigh"].map((k) => (
                    <button key={k} data-v={k} aria-pressed={(n.effort || "medium") === k} onClick={() => setNode(n.id, "effort", k)}>
                      {k}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="nums" style={{ marginTop: 10 }}>
              <label className="num">
                <span>Rounds</span>
                <input type="number" id="nRounds" key={String(n.rounds)} defaultValue={n.rounds} min={1} max={40} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "rounds", +v))} />
              </label>
              <label className="num">
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
              </label>
              <label className="num">
                <span>Limit, s</span>
                <input type="number" id="nTo" key={String(n.timeoutS || 0)} defaultValue={n.timeoutS || 0} min={0} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "timeoutS", +v))} />
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
      {m.runs !== "code" ? <OutputGrp n={n} m={m} /> : null}
      {m.runs !== "code" ? (
        <>
        <div className="grp">
          <h4>{`Reads · ${(ctxTokens(n, g) / 1000).toFixed(1)}k · ${Math.round(cacheShare(n, g) * 100)}% cached`}</h4>
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
                <span className="hint" style={{ width: 34, fontSize: 11.5 }}>
                  {out ? "to" : "from"}
                </span>
                <WireIcon mode={e.mode} />
                <span style={{ flex: 1 }}>{other?.label}</span>
                <span className="hint" style={{ fontSize: 12 }}>
                  {WIRES[e.mode].name}
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
  );
}

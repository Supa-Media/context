/**
 * The step panel's "Settings" card as the approved Lab live sandbox mockup has it
 * (https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): a short list, Running, Model, Effort, Time limit, Prompt and
 * Output (Code in place of the model ones for a code step), each field this draft changed outlined yellow with "was X
 * on main" under it. Everything else the step has (goal, record, rounds, reads, wires, change note, delete) is behind
 * "More settings" in `NodePanel.web.tsx`, so nothing the long panel could do is lost.
 */
import type { ReactNode } from "react";
import { fieldText, stepChange } from "../../engine/changeMarks";
import { MODELS } from "../../engine/state";
import type { LabNode } from "../../types";
import { onCommit } from "./change";
import { pickModel, setNode } from "./nodeEdit";

const EFFORTS = ["off", "low", "medium", "high", "xhigh"];

export function SettingsCard({ n }: { n: LabNode }) {
  const m = MODELS[n.model] || MODELS.code;
  const ch = stepChange(n.id);
  const changed = (f: string) => !!ch?.x.fields.includes(f);
  /** One row: its label, and its control outlined when this draft changed it, with what main had under it. */
  const row = (label: string, field: string, control: ReactNode) => (
    <>
      <label>{label}</label>
      <div className={changed(field) ? "chgf" : undefined} data-field={field}>
        {control}
        {changed(field) && ch?.x.base ? <span className="was">{`was ${fieldText(ch.x.base, field)} on ${ch.vs}`}</span> : null}
      </div>
    </>
  );
  const chips = (xs: string[], empty: string) => <div className="mods">{xs.length ? xs.map((x) => <span key={x}>{x}</span>) : <span className="none">{empty}</span>}</div>;
  const model = m.runs !== "code";
  return (
    <div className="setf" id="setShort">
      {row(
        "Running",
        "running",
        <select id="setOn" value={n.on ? "on" : "off"} onChange={(e) => setNode(n.id, "on", e.target.value === "on")}>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>,
      )}
      {model
        ? row(
            "Model",
            "model",
            <select id="setModel" value={n.model} onChange={(e) => pickModel(n.id, e.target.value)}>
              {Object.entries(MODELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.name}
                </option>
              ))}
            </select>,
          )
        : null}
      {model && m.runs !== "api"
        ? row(
            "Effort",
            "effort",
            <select id="setEffort" value={n.effort || "medium"} onChange={(e) => setNode(n.id, "effort", e.target.value)}>
              {EFFORTS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>,
          )
        : null}
      {model
        ? row(
            "Time limit",
            "limit",
            <span className="unit">
              <input type="number" id="setLimit" min={0} key={String(n.timeoutS || 0)} defaultValue={n.timeoutS || 0} ref={onCommit<HTMLInputElement>((v) => setNode(n.id, "timeoutS", +v))} />s
            </span>,
          )
        : null}
      {model ? row("Prompt", "reads", chips(n.ctx || [], "nothing read")) : row("Code", "code", chips(n.file ? [n.file] : [], "new step"))}
      {row("Output", "output", chips((n.outSchema || []).map((f) => f.name), model ? "free text" : "what the code returns"))}
    </div>
  );
}

/**
 * The step panel's "Settings" card as the approved Lab live sandbox mockup has it
 * (https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): a short list, Running, Model, Effort, Time limit, Prompt and
 * Output (Code in place of the model ones for a code step), each field this draft changed outlined yellow with "was X
 * on main" under it. Everything else the step has (goal, record, rounds, reads, wires, change note, delete) is behind
 * "More settings" in `NodePanel.web.tsx`, so nothing the long panel could do is lost.
 */
import { useState, type ReactNode } from "react";
import { fieldText, stepChange } from "../../engine/changeMarks";
import { MODELS } from "../../engine/state";
import type { LabNode } from "../../types";
import { SEARCH_SETTINGS_BOUNDS } from "../../../../../apps/mcp/src/search/config/searchConfig.cjs";
import { SETTING_TEXT, checkSetting, settingLabel } from "../../data/searchSettings";
import { onCommit } from "./change";
import { pickModel, setNode } from "./nodeEdit";
import { EFFORTS } from "@context/tex/src/texConfigSchema.cjs";
import { StepSettings } from "./StepSettings.web";

/**
 * One of a search step's numbers: a number box bounded by the schema, outlined yellow with "was X on main" when this
 * draft changed it. A value out of bounds, or not whole where it must be, is refused: nothing is saved, the box goes
 * back to the saved value, and the bound is said under it.
 */
function SearchSetting({ n, name }: { n: LabNode; name: string }) {
  const [why, setWhy] = useState<string | null>(null);
  const bound = SEARCH_SETTINGS_BOUNDS[name];
  const value = typeof n.settings?.[name] === "number" ? (n.settings[name] as number) : 0;
  const ch = stepChange(n.id);
  // A new step has no main to compare with, so nothing is outlined; a changed one shows main's number under it.
  const base = ch?.x.base ? ch.x.base.settings?.[name] : undefined;
  const changed = !!ch?.x.base && base !== value;
  const tip = SETTING_TEXT[name]?.tip ?? "";
  return (
    <>
      <label title={tip}>{settingLabel(name)}</label>
      <div className={changed ? "chgf" : undefined} data-setting={name}>
        <span className="unit">
          <input
            type="number"
            id={`set-${name}`}
            min={bound.min}
            max={bound.max}
            step={bound.integer ? 1 : "any"}
            key={String(value)}
            defaultValue={value}
            ref={onCommit<HTMLInputElement>((text, el) => {
              const r = checkSetting(name, text);
              if (!r.ok) {
                setWhy(r.why);
                el.value = String(value);
                return;
              }
              setWhy(null);
              if (r.value !== value) setNode(n.id, "settings", { ...n.settings, [name]: r.value });
            })}
          />
        </span>
        {changed ? <span className="was">{`was ${base ?? "none"} on ${ch?.vs ?? "main"}`}</span> : null}
        {why ? (
          <span role="alert" style={{ display: "block", fontSize: 11, color: "var(--bad)", fontWeight: 600, marginTop: 2 }}>{`${why}. Not saved.`}</span>
        ) : (
          <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{tip}</span>
        )}
      </div>
    </>
  );
}

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
  // A search step's numbers (search's config, `searchConfig.json`): only the ones the schema bounds, so a stray key is not drawn.
  const searchKeys = Object.keys(n.settings ?? {}).filter((k) => k in SEARCH_SETTINGS_BOUNDS);
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
      {model && (n.id === "fd" || n.id === "job")
        ? row(
            "Tool list",
            "tool list",
            <select id="setToolList" value={n.toolList || "turn"} onChange={(e) => setNode(n.id, "toolList", e.target.value as "turn" | "fixed")}>
              <option value="turn">What the turn holds</option>
              <option value="fixed">Fixed, every turn the same</option>
            </select>,
          )
        : null}
      {model && (n.id === "fd" || n.id === "job")
        ? row(
            "Slow modules",
            "frozen modules",
            <select id="setFreeze" value={n.freeze || "turn"} onChange={(e) => setNode(n.id, "freeze", e.target.value as "turn" | "summary")}>
              <option value="turn">Read every turn</option>
              <option value="summary">Frozen until the next summary</option>
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
      {searchKeys.length ? (
        <>
          <div className="setsec" style={{ gridColumn: "1 / -1", fontWeight: 600, marginTop: 6 }}>
            Settings
          </div>
          {searchKeys.map((k) => (
            <SearchSetting key={k} n={n} name={k} />
          ))}
        </>
      ) : null}
      <StepSettings n={n} />
    </div>
  );
}

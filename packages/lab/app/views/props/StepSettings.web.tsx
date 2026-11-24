/**
 * A Tex code step's own settings in the step card (Dev2, 2026-11-23: "code nodes should be able to define their own
 * parameters, like number parameters or Boolean parameters ... display that in the UI, and agents are able to tweak
 * those parameters"; artboards in the project's `node-params-artboards/`).
 *
 * The step's code declares each one (`packages/tex/src/texNodeSettings.cjs`): a number with bounds, on or off, or one
 * of a few choices, its default and its words. This draws them under the short list as "Settings · from the code": a
 * number box, a switch or a picker, the tip under each, and a setting this draft changed outlined yellow with what main
 * had. A value its declaration refuses is not saved, and the bound is said under the box, the same rule `check` and the
 * gateway apply. `tex_dev edit` sets the same field (`set` on `settings`).
 */
import { useState } from "react";
import { STEP_SETTINGS, stepSettingProblem, type StepSettingDecl, type StepSettingValue } from "@context/tex/src/texNodeSettings.cjs";
import { stepChange } from "../../engine/changeMarks";
import type { LabNode } from "../../types";
import { onCommit } from "./change";
import { setNode } from "./nodeEdit";

/** The step's value for `name`, or its declared default when the draft leaves it out. */
function valueOf(n: LabNode, name: string, decl: StepSettingDecl): StepSettingValue {
  const own = n.settings?.[name];
  return own !== undefined && stepSettingProblem(n.id, name, own) === null ? own : decl.default;
}

/** Saves one setting, keeping the step's others. */
function save(n: LabNode, name: string, value: StepSettingValue) {
  setNode(n.id, "settings", { ...(n.settings ?? {}), [name]: value });
}

const shown = (v: StepSettingValue | undefined) => (v === true ? "on" : v === false ? "off" : v === undefined ? "unset" : String(v));

function Setting({ n, name, decl }: { n: LabNode; name: string; decl: StepSettingDecl }) {
  const [why, setWhy] = useState<string | null>(null);
  const value = valueOf(n, name, decl);
  const ch = stepChange(n.id);
  // A new step has no main to compare with; a changed one shows main's value (its default when main leaves it out).
  const base = ch?.x.base ? (ch.x.base.settings?.[name] ?? decl.default) : undefined;
  const changed = !!ch?.x.base && base !== value;
  let control;
  if (decl.type === "boolean") {
    control = (
      <button
        type="button"
        className="sw"
        role="switch"
        id={`step-set-${name}`}
        aria-checked={value === true}
        aria-label={decl.label}
        onClick={() => save(n, name, value !== true)}
      />
    );
  } else if (decl.type === "choice") {
    control = (
      <select id={`step-set-${name}`} value={String(value)} onChange={(e) => save(n, name, e.target.value)}>
        {decl.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <span className="unit">
        <input
          type="number"
          id={`step-set-${name}`}
          min={decl.min}
          max={decl.max}
          step={decl.integer ? 1 : "any"}
          aria-invalid={why ? true : undefined}
          aria-describedby={changed && !why ? undefined : `step-set-${name}-tip`}
          key={String(value)}
          defaultValue={Number(value)}
          ref={onCommit<HTMLInputElement>((text, el) => {
            const typed = text.trim() === "" ? NaN : Number(text);
            const problem = stepSettingProblem(n.id, name, typed);
            if (problem !== null) {
              // The refused number stays in the box, outlined red, so the person sees what was not saved.
              setWhy(`${decl.label} must be ${decl.integer ? "a whole number " : ""}from ${decl.min} to ${decl.max}`);
              return;
            }
            setWhy(null);
            if (typed !== value) save(n, name, typed);
          })}
        />
        {decl.unit ?? ""}
      </span>
    );
  }
  return (
    <>
      <label className="stl" htmlFor={`step-set-${name}`}>
        {decl.label}
      </label>
      <div className={[changed && "chgf", why && "bad"].filter(Boolean).join(" ") || undefined} data-setting={name}>
        {control}
        {changed ? <span className="was">{`was ${shown(base)}${typeof base === "boolean" ? "," : ""} on ${ch?.vs ?? "main"}`}</span> : null}
        {/* A changed setting shows main's value in place of its tip, as the artboard has it. */}
        {why ? (
          <span role="alert" id={`step-set-${name}-tip`} className="stip bad">{`${why}. Not saved.`}</span>
        ) : changed ? null : (
          <span id={`step-set-${name}-tip`} className="stip">
            {decl.tip}
          </span>
        )}
      </div>
    </>
  );
}

/** The step's declared settings, or nothing for a step whose code declares none. */
export function StepSettings({ n }: { n: LabNode }) {
  const declared = n.graph === "search" ? undefined : STEP_SETTINGS[n.id];
  if (!declared || Object.keys(declared).length === 0) return null;
  return (
    <>
      <div className="setsec stepsec">
        <b>Settings</b>
        <span>from the code</span>
      </div>
      {Object.entries(declared).map(([name, decl]) => (
        <Setting key={name} n={n} name={name} decl={decl} />
      ))}
    </>
  );
}

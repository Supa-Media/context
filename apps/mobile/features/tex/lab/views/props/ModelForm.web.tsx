/**
 * The model step's "add a model" and "edit this model" form (spec-b.js lines
 * 1-23, and the Model group's button and edit link of line 154-155). The
 * artifact's `modelForm` global lives here; the Props view reads it with
 * `getModelForm()`, and each change draws again through `emit()`.
 */
import { edit, emit, G, lab, MODELS, node } from "../../engine/state";
import { useLab } from "../../store";
import type { LabModel } from "../../types";
import { Ic } from "../ic";

/** The form's draft of a model: a copy of a custom one, or the defaults of a new one. */
export type FormV = Pick<LabModel, "name" | "runs"> & Partial<Omit<LabModel, "name" | "runs" | "typed">> & { typed?: "schema" | "only" | "json" | "" };
export type ModelFormState = { key: string | null; v: FormV } | null;

let modelForm: ModelFormState = null;
/** Bumped each time a form opens, so its inputs draw their new values even when the form changes straight to another. */
let formSeq = 0;
let lastSel: string | null = null;

export const getModelForm = () => modelForm;
export function setModelForm(v: ModelFormState) {
  modelForm = v;
  if (v) formSeq++;
  emit();
}

/** The artifact's `renderProps0` start: a new selection closes the form. Called during render, so it does not emit. */
export function resetModelFormOnSel() {
  const sk = JSON.stringify(lab.sel);
  if (sk !== lastSel) {
    modelForm = null;
    lastSel = sk;
  }
}

const selId = () => (lab.sel?.t === "node" ? lab.sel.id : "");
const val = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? "";

/** The artifact's `keep()`: copies what the inputs hold into the draft. */
function keep(f: FormV) {
  f.name = val("mfName");
  f.id = val("mfId");
  for (const [i, k] of [["mfBase", "base"], ["mfTok", "perTok"], ["mfCR", "cacheR"], ["mfCW", "cacheW"], ["mfOut", "outP"]] as const)
    f[k] = Math.max(0, +val(i) || 0);
}

const RUNS = [["subscription", "Claude subscription"], ["api", "API call"]] as const;
const TYPED = [["", "Text"], ["schema", "Text or typed"], ["only", "Typed only"]] as const;

function saveModel(f: FormV, key: string | null) {
  keep(f);
  const name = f.name.trim();
  if (!name) {
    document.getElementById("mfName")?.focus();
    return;
  }
  const k = key || "x-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) + "-" + Date.now().toString(36).slice(-3);
  const id = selId();
  const mdl: LabModel = {
    name,
    full: name,
    id: (f.id ?? "").trim() || name,
    c: f.runs === "api" ? "--m-api" : "--accent",
    runs: f.runs,
    base: f.base,
    perTok: f.perTok,
    cacheR: f.cacheR,
    cacheW: f.cacheW,
    outP: f.outP,
    typed: f.typed || undefined,
    custom: true,
  };
  if (mdl.typed === "only") mdl.note = "Answers typed fields only.";
  setModelForm(null);
  edit(() => {
    const g = G();
    g.models = g.models || {};
    g.models[k] = mdl;
    const x = node(id)!;
    x.model = k;
    if (mdl.runs !== "code" && !x.effort) x.effort = "medium";
    if (mdl.typed === "only" && !x.outSchema?.length) x.outSchema = [{ name: "answer", type: "choice", options: "yes, no" }];
  });
}

function deleteModel(k: string) {
  setModelForm(null);
  edit(() => {
    const g = G();
    for (const n of g.nodes) if (n.model === k) n.model = "haiku-5-5";
    delete g.models?.[k];
  });
}

const nb = (id: string, l: string, v: number | undefined, st: number) => (
  <label className="num">
    <span>{l}</span>
    <input type="number" id={id} defaultValue={v} min={0} step={st} />
  </label>
);

/** The form itself, or nothing when no form is open (the artifact's `modelFormHtml`). */
export function ModelForm() {
  useLab();
  const mf = modelForm;
  if (!mf) return null;
  const f = mf.v;
  const key = mf.key;
  const sel = selId();
  return (
    <div className="mform" key={formSeq}>
      <label className="num" style={{ gridColumn: "1/-1" }}>
        <span>Name</span>
        <input id="mfName" defaultValue={f.name} placeholder="e.g. Kimi K2" />
      </label>
      <label className="num" style={{ gridColumn: "1/-1" }}>
        <span>Model id</span>
        <input id="mfId" defaultValue={f.id} placeholder="provider/model" spellCheck={false} style={{ fontFamily: "var(--mono)" }} />
      </label>
      <div className="seg" id="mfRuns" style={{ gridColumn: "1/-1" }}>
        {RUNS.map(([r, l]) => (
          <button key={r} data-r={r} aria-pressed={f.runs === r} onClick={() => { keep(f); f.runs = r; emit(); }}>
            {l}
          </button>
        ))}
      </div>
      {nb("mfBase", "Start, ms", f.base, 50)}
      {nb("mfTok", "ms per token out", f.perTok, 0.5)}
      {nb("mfCR", "$/M cached in", f.cacheR, 0.01)}
      {nb("mfCW", "$/M new in", f.cacheW, 0.01)}
      {nb("mfOut", "$/M out", f.outP, 0.1)}
      <div className="seg" id="mfTyped" style={{ gridColumn: "1/-1" }}>
        {TYPED.map(([t, l]) => (
          <button key={t} data-t={t} aria-pressed={t ? f.typed === t : !f.typed} onClick={() => { keep(f); f.typed = t; emit(); }}>
            {l}
          </button>
        ))}
      </div>
      <div className="flex" style={{ gridColumn: "1/-1", justifyContent: "flex-end" }}>
        {key && !G().nodes.some((n) => n.model === key && n.id !== sel) ? (
          <button className="danger sm" id="mfDel" onClick={() => deleteModel(key)}>
            <Ic k="trash" style={{ width: 14, height: 14 }} />
            Delete
          </button>
        ) : null}
        <button className="ghost" id="mfCancel" onClick={() => setModelForm(null)}>
          Cancel
        </button>
        <button className="primary" id="mfSave" onClick={() => saveModel(f, key)}>
          {key ? "Save" : "Add and use"}
        </button>
      </div>
    </div>
  );
}

/** The Model group's "Model" button that opens the add form (spec line 154). */
export function NewModelButton() {
  useLab();
  return (
    <button
      id="mNewModel"
      aria-label="Add a model"
      title="Add a model"
      aria-pressed={!!modelForm && !modelForm.key}
      onClick={() =>
        setModelForm(
          modelForm && !modelForm.key
            ? null
            : { key: null, v: { name: "", id: "", runs: "api", base: 900, perTok: 5, cacheR: 0.1, cacheW: 0.5, outP: 2, typed: "" } },
        )
      }
    >
      <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
        <path d="M12 5v14M5 12h14" />
      </svg>
      Model
    </button>
  );
}

/** "Edit <name>" for a custom model, shown while no form is open (spec line 155). */
export function EditModelLink({ m }: { m: LabModel }) {
  useLab();
  if (!(m.custom && !modelForm)) return null;
  return (
    <button
      className="lnk"
      id="mEditModel"
      style={{ marginTop: 8 }}
      onClick={() => {
        const k = node(selId())!.model;
        setModelForm({ key: k, v: { ...MODELS[k] } });
      }}
    >
      Edit {m.name}
    </button>
  );
}

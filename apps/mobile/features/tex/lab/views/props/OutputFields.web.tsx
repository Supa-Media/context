/**
 * The model step's "Output" group: free text or typed fields, each field's
 * name, type and options (spec-b.js lines 25-41).
 */
import { FTYPES } from "../../data/models";
import { edit, lab, MODELS, node } from "../../engine/state";
import { outTok } from "../../engine/sim";
import { useLab } from "../../store";
import type { LabModel, LabNode, OutField } from "../../types";
import { onCommit } from "./change";

const selId = () => (lab.sel?.t === "node" ? lab.sel.id : "");
/** The artifact stores `null` for "no typed fields"; kept as is so saved versions match. */
const noFields = () => null as unknown as undefined;

function setKind(v: "text" | "typed") {
  edit(() => {
    const x = node(selId())!;
    x.outSchema = v === "typed" ? (x.outSchema?.length ? x.outSchema : [{ name: "answer", type: "choice", options: "yes, no" }]) : noFields();
  });
}

function setField(i: number, k: keyof OutField, v: string) {
  edit(() => {
    const f = node(selId())!.outSchema![i];
    f[k] = v;
  });
}

function removeField(i: number) {
  edit(() => {
    const y = node(selId())!;
    y.outSchema!.splice(i, 1);
    if (!y.outSchema!.length) y.outSchema = MODELS[y.model]?.typed === "only" ? [{ name: "answer", type: "yesno" }] : noFields();
  });
}

function addField() {
  edit(() => {
    const y = node(selId())!;
    y.outSchema!.push({ name: "field_" + (y.outSchema!.length + 1), type: "yesno" });
  });
}

export function OutputGrp({ n, m }: { n: LabNode; m: LabModel }) {
  useLab();
  const typed = !!n.outSchema?.length;
  const only = m.typed === "only";
  const types = Object.entries(FTYPES).filter(([k]) => !only || k !== "text");
  const sup = only ? (
    <span className="pill acc">Typed only</span>
  ) : m.typed === "schema" ? (
    <span className="pill ok">Typed output supported</span>
  ) : (
    <span className="pill warn">JSON mode, not checked</span>
  );
  return (
    <div className="grp">
      <h4>Output · {outTok(n)} tokens</h4>
      {only ? null : (
        <div className="seg" id="nOutKind">
          <button data-v="text" aria-pressed={!typed} onClick={() => setKind("text")}>
            Free text
          </button>
          <button data-v="typed" aria-pressed={typed} onClick={() => setKind("typed")}>
            Typed fields
          </button>
        </div>
      )}
      {typed ? (
        <>
          <div className="fields">
            {n.outSchema!.map((f, i) => (
              <div className="fld" key={i}>
                <input
                  key={"n:" + f.name}
                  data-fn={i}
                  defaultValue={f.name}
                  aria-label="Field name"
                  spellCheck={false}
                  ref={onCommit((v) => setField(i, "name", v.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "field"))}
                />
                <select
                  key={"t:" + f.type}
                  data-ft={i}
                  aria-label="Field type"
                  defaultValue={f.type}
                  ref={onCommit((v) => setField(i, "type", v))}
                >
                  {types.map(([k, t]) => (
                    <option key={k} value={k}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button className="x" data-fx={i} aria-label={`Remove field ${f.name}`} onClick={() => removeField(i)}>
                  <svg className="i" viewBox="0 0 24 24" style={{ width: 12, height: 12 }}>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                {f.type === "choice" || f.type === "score" ? (
                  <input
                    className="fo"
                    key={"o:" + (f.options || "")}
                    data-fo={i}
                    defaultValue={f.options || ""}
                    placeholder={f.type === "choice" ? "Options, comma separated" : "Range, e.g. 1-10"}
                    aria-label={`Options for ${f.name}`}
                    ref={onCommit((v) => setField(i, "options", v))}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <button className="add" id="fAdd" style={{ marginTop: 8 }} onClick={addField}>
            <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Field
          </button>
        </>
      ) : null}
      <div className="flex" style={{ marginTop: 10 }}>
        {sup}
      </div>
    </div>
  );
}

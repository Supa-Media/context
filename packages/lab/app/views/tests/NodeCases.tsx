/**
 * A step's own test cases (Dev2, 2026-11-15: "there's not a way to add them here"): the form whose boxes come from
 * the step's input and output shapes, so every step gets the same one, and the cases already kept. Drawn on the
 * Tests page and in the step's panel on the canvas.
 */
import { CASE_CAP, casesIn, choicesOf, fieldsOf, nodeArea, nodeCaseText, stepById, type Field } from "../../engine/cases";
import { cancelNodeCase, drafts, editNodeCase, keepNodeCase, startNodeCase } from "../../engine/caseDraft";
import { emit, lab } from "../../engine/state";
import { dropCase, saveCase, useLab } from "../../store";
import type { LabCase, LabNode } from "../../types";

/** The step's logged inputs from the traced turn, by field, when the canvas traces one of the person's own texts. */
function realGiven(n: LabNode, ins: Field[]): Record<string, string> | null {
  const lines = lab.real?.io?.[n.id];
  if (!lines?.length) return null;
  const names = new Set(ins.map((f) => f.name));
  for (const l of lines) {
    try {
      const o = JSON.parse(l.v) as unknown;
      if (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).some((k) => names.has(k)))
        return Object.fromEntries(ins.map((f) => [f.name, (o as Record<string, unknown>)[f.name] === undefined ? "" : typeof (o as Record<string, unknown>)[f.name] === "string" ? String((o as Record<string, unknown>)[f.name]) : JSON.stringify((o as Record<string, unknown>)[f.name])]));
    } catch {
      // Not JSON: a line of words, read below.
    }
  }
  const got = lines.find((l) => /^(Got|Turn|Input)/.test(l.k));
  const first = ins.find((f) => f.type === "text") ?? ins[0];
  return got && first ? { [first.name]: got.v } : null;
}

function GivenBox({ f, value, onChange, wide }: { f: Field; value: string; onChange: (v: string) => void; wide: boolean }) {
  return (
    <label className="nfld">
      <span>
        {f.name} {f.optional ? <small>optional</small> : null}
      </span>
      {wide ? (
        <textarea className="note" rows={2} data-given={f.name} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="note" data-given={f.name} value={value} placeholder={f.type === "yesno" ? "yes or no" : f.type === "number" ? "a number" : f.type === "list" || f.type === "object" ? "JSON" : ""} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function WantBox({ f, want, onChange }: { f: Field; want: { is?: string; judge?: string }; onChange: (w: { is?: string; judge?: string }) => void }) {
  const ch = choicesOf(f);
  if (ch)
    return (
      <div className="seg" role="group" aria-label={f.name}>
        {[...ch, "Any"].map((c) => (
          <button key={c} type="button" data-want={f.name} aria-pressed={c === "Any" ? !want.is : want.is === c} onClick={() => onChange(c === "Any" ? {} : { is: c })}>
            {c}
          </button>
        ))}
      </div>
    );
  if (f.type === "text")
    return (
      <span className="judge">
        <small>A judge reads it:</small>
        <input className="note" data-want={f.name} value={want.judge ?? ""} placeholder="what it should say or do" onChange={(e) => onChange(e.target.value ? { judge: e.target.value } : {})} />
      </span>
    );
  return <input className="note" data-want={f.name} value={want.is ?? ""} placeholder="exactly this, or empty for any" onChange={(e) => onChange(e.target.value ? { is: e.target.value } : {})} />;
}

/** The open form: given its inputs, want its output, then Keep. */
export function NodeCaseForm({ n }: { n: LabNode }) {
  useLab();
  const d = drafts.node;
  if (!d || d.area !== nodeArea(n.id)) return null;
  const { ins, outs } = fieldsOf(n);
  const real = realGiven(n, ins);
  const firstText = ins.find((f) => f.type === "text")?.name;
  return (
    <div className="ncf" id="nodeCaseForm">
      <div className="ncfh">
        <span className="cid">{d.id}</span>
        <span className="spacer"></span>
        <button
          type="button"
          className="ghost sm"
          id="fillReal"
          disabled={!real}
          title={real ? "Fill the inputs from the turn traced on the canvas" : "Trace one of your own texts on the canvas first"}
          onClick={() => {
            if (real) d.given = { ...d.given, ...real };
            emit();
          }}
        >
          Fill from a real turn
        </button>
      </div>
      <div className="nlbl">Given · its inputs</div>
      <div className="ngrid">
        {ins.map((f) => (
          <GivenBox key={f.name} f={f} wide={f.name === firstText} value={d.given[f.name] ?? ""} onChange={(v) => ((d.given[f.name] = v), emit())} />
        ))}
      </div>
      <div className="nlbl">Want · its output</div>
      <div className="wgrid">
        {outs.map((f) => (
          <div key={f.name} className="wrow">
            <span className="wn">{f.name}</span>
            <WantBox f={f} want={d.want[f.name] ?? {}} onChange={(w) => ((d.want[f.name] = w), emit())} />
          </div>
        ))}
      </div>
      <div className="flex" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ghost" id="cancelCase" onClick={cancelNodeCase}>
          Cancel
        </button>
        <button type="button" className="primary" id="keepCase" onClick={() => void keepNodeCase()}>
          Keep
        </button>
      </div>
    </div>
  );
}

function NodeCaseCard({ c }: { c: LabCase }) {
  const t = nodeCaseText(c);
  return (
    <article className="tc" data-case={c.id}>
      <div className="tch">
        <span className="cid">{c.id}</span>
        {c.isNew ? <span className="pill acc">new</span> : null}
        <span className="spacer"></span>
        <button className="ghost sm" data-editcase={c.id} onClick={() => editNodeCase(c)}>
          Edit
        </button>
        <button
          className="ghost sm"
          data-dropcase={c.id}
          onClick={() => {
            const k = c.area + "/" + c.id;
            if (c.isNew) void dropCase(k);
            else void saveCase({ ...c, removed: true, by: lab.myId, at: Date.now() });
          }}
        >
          Remove
        </button>
      </div>
      <div className="want">
        <span className="wl">Given</span>
        <div className="hint">{t.ask || "nothing"}</div>
      </div>
      <div className="want">
        <span className="wl">Want</span>
        <div className="hint">{t.expect || "any answer"}</div>
      </div>
    </article>
  );
}

/** A step's own cases: the count, the empty state, the open form, the kept cases and "+ Add another case". */
export function NodeCases({ id, compact = false }: { id: string; compact?: boolean }) {
  useLab();
  const n = stepById(id);
  if (!n) return null;
  const area = nodeArea(id);
  const list = casesIn(area);
  const open = drafts.node?.area === area;
  return (
    <div className="ncases" data-step={id}>
      {compact ? (
        <div className="nch">
          <span className="nlbl" style={{ flex: 1 }}>
            Test cases
          </span>
          <span className="cnt">
            {list.length} / {CASE_CAP}
          </span>
        </div>
      ) : null}
      {list.length === 0 && !open ? <p className="hint">No cases yet. A case gives this step its inputs and says what it should answer; Promote puts it in the repo, and `pnpm ai nodes` runs it through this step's code alone.</p> : null}
      {list.length === 0 && !open ? (
        <button className="primary" id="addFirstCase" onClick={() => startNodeCase(id)}>
          + Add a case
        </button>
      ) : null}
      <NodeCaseForm n={n} />
      {list.length ? (
        <div className="tgrid">
          {list.map((c, i) => (
            <NodeCaseCard key={c.id + "/" + i} c={c} />
          ))}
        </div>
      ) : null}
      {(list.length > 0 || open) && list.length < CASE_CAP ? (
        <button className="addc wide" id="addAnotherCase" disabled={open} title={open ? "Keep or cancel the case above first" : undefined} onClick={() => startNodeCase(id)}>
          + Add another case
        </button>
      ) : null}
      <p className="hint small">The boxes come from the step's input and output shapes, so every step gets the same form. Kept cases live in the repo beside the other bench cases.</p>
    </div>
  );
}

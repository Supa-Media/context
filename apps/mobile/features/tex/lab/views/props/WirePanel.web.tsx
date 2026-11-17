/**
 * The Lab's wire panel: the artifact's `renderProps0` for a selected wire
 * (its kind, when it fires, how often a loop sends back, delete). A wire that
 * is no longer there clears the selection, as the artifact did.
 */
import type { ReactNode } from "react";
import { useEffect } from "react";
import { PROVISIONAL_ALLOW, PROVISIONAL_UNLESS, PROVISIONAL_WHEN, WHEN, WIRES } from "../../data/graph";
import { delSel, edit, G, lab, node, set } from "../../engine/state";
import type { LabEdge } from "../../types";
import { useLab } from "../../store";
import { Ic } from "../ic";
import { WireIcon } from "../parts";
import { onCommit } from "./change";

/** Toggle a "fires when" entry: "always" stands alone; any other entry replaces it. */
function toggleWhen(i: number, t: string) {
  edit(() => {
    const ed = G().edges[i];
    if (t === "*") ed.when = ["*"];
    else {
      ed.when = ed.when.filter((x) => x !== "*");
      ed.when = ed.when.includes(t) ? ed.when.filter((x) => x !== t) : [...ed.when, t];
      if (!ed.when.length) ed.when = ["*"];
    }
  });
}

/** A provisional wire's start gate: toggle a burst that does not start it early. None listed, every burst starts it. */
function toggleUnless(i: number, fact: string) {
  edit(() => {
    const ed = G().edges[i];
    const cur = ed.unless ?? [];
    ed.unless = cur.includes(fact) ? cur.filter((x) => x !== fact) : [...cur, fact];
  });
}

/** A provisional wire's verdicts: toggle "stop:<tag>" or "restart:<tag>"; with none, it only says go. */
function toggleVerdict(i: number, v: string) {
  edit(() => {
    const ed = G().edges[i];
    const has = ed.when.includes(v);
    ed.when = has ? ed.when.filter((x) => x !== v) : [...ed.when.filter((x) => x !== "*"), v];
    if (!ed.when.length) ed.when = ["*"];
  });
}

/** Change a wire's kind, keeping only the "fires when" entries the new kind reads. */
function setMode(i: number, k: LabEdge["mode"]) {
  edit(() => {
    const ed = G().edges[i];
    const verdict = (x: string) => x.startsWith("stop:") || x.startsWith("restart:");
    ed.mode = k;
    if (k !== "provisional") {
      delete ed.allow;
      delete ed.unless;
    }
    ed.when = ed.when.filter((x) => x === "*" || (k === "provisional") === verdict(x));
    if (!ed.when.length) ed.when = ["*"];
  });
}

export function WirePanel({ extra }: { extra?: ReactNode }) {
  useLab();
  const sel = lab.sel;
  const i = sel?.t === "edge" ? sel.i : -1;
  const e: LabEdge | undefined = G().edges[i];

  useEffect(() => {
    if (!e) set({ sel: null });
  }, [e]);
  if (!e) return null;

  const a = node(e.from)!;
  const b = node(e.to)!;

  return (
    <>
      <div className="ph">
        <div className="badge">
          <Ic k="wire" />
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>Wire</div>
        {extra}
      </div>
      <div className="grp">
        <div className="flex" style={{ fontSize: 13 }}>
          <Ic k={a.icon} />
          <b>{a.label}</b>
          <span className="hint">to</span>
          <Ic k={b.icon} />
          <b>{b.label}</b>
        </div>
      </div>
      <div className="grp">
        <h4>Kind</h4>
        <div className="wk" id="eMode">
          {Object.entries(WIRES).filter(([, w]) => !w.folded).map(([k, w]) => (
            <button key={k} data-v={k} aria-pressed={e.mode === k || (k === "job" && !!WIRES[e.mode]?.folded)} onClick={() => setMode(i, k as LabEdge["mode"])}>
              <WireIcon mode={k} />
              <span>
                <b>{w.name}</b>
                <small>{w.tip}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      {e.mode === "provisional" ? (
        <div className="grp">
          <h4>Before its go</h4>
          <div className="chips" id="eAllow">
            {PROVISIONAL_ALLOW.map(([k, l, tip]) => (
              <button key={k} className="tg" data-allow={k} title={tip} aria-pressed={(e.allow ?? "revertible") === k} onClick={() => edit(() => (G().edges[i].allow = k))}>
                {l}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {e.mode === "provisional" ? (
        <div className="grp">
          <h4>Does not start early when</h4>
          <div className="chips" id="eUnless">
            {PROVISIONAL_UNLESS.map(([fact, label, tip]) => (
              <button key={fact} className="tg" data-unless={fact} title={tip} aria-pressed={(e.unless ?? []).includes(fact)} onClick={() => toggleUnless(i, fact)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {e.mode === "provisional" ? (
        (["stop", "restart"] as const).map((kind) => (
          <div className="grp" key={kind}>
            <h4>{kind === "stop" ? "Stops it when" : "Restarts it when"}</h4>
            <div className="chips">
              {PROVISIONAL_WHEN.map(([t, l]) => (
                <button key={t} className="tg" data-when={`${kind}:${t}`} aria-pressed={e.when.includes(`${kind}:${t}`)} onClick={() => toggleVerdict(i, `${kind}:${t}`)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="grp">
          <h4>Fires when</h4>
          <div className="chips">
            {WHEN.map(([t, l]) => (
              <button key={t} className="tg" data-when={t} aria-pressed={e.when.includes(t)} onClick={() => toggleWhen(i, t)}>
                {l}
              </button>
            ))}
          </div>
        </div>
      )}
      {e.mode === "loop" ? (
        <div className="grp">
          <h4>How often</h4>
          <div className="nums" style={{ gridTemplateColumns: "1fr" }}>
            <label className="num">
              <span>Percent of drafts sent back</span>
              <input
                type="number"
                id="eP"
                min={0}
                max={100}
                key={String(Math.round((a.sendBack ?? 0.1) * 100))}
                defaultValue={Math.round((a.sendBack ?? 0.1) * 100)}
                ref={onCommit<HTMLInputElement>((v) => edit(() => (node(G().edges[i].from)!.sendBack = +v / 100)))}
              />
            </label>
          </div>
        </div>
      ) : null}
      <div className="grp">
        <button className="danger" id="eDel" onClick={delSel}>
          <Ic k="trash" />
          Delete this wire
        </button>
      </div>
    </>
  );
}

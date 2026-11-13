/**
 * The model step's "Reads" group: the context stack with its moves, drags
 * and module viewer, and the Add picker (spec-b.js lines 73-74, 102-110, 164
 * and 181-191). `setMod` lives here because the Modules page and this stack
 * both change a module's flags.
 */
import { Fragment, useRef } from "react";
import { BASE_MODULES, SRC_KINDS } from "../../data/modules";
import { ctxTokens } from "../../engine/sim";
import { isStable, mods, newModule } from "../../engine/modules";
import { edit, G, go, lab, MAIN, MODELS, node, set } from "../../engine/state";
import { useLab } from "../../store";
import type { LabGraph, LabModule, LabNode } from "../../types";
import { Ic } from "../ic";

const selId = () => (lab.sel?.t === "node" ? lab.sel.id : "");

/** Change one field of a module; a value equal to the base's is dropped so only real edits are kept. */
export function setMod(k: string, f: string, v: unknown) {
  edit(() => {
    const g = G();
    g.modules = g.modules || {};
    const base = BASE_MODULES[k];
    g.modules[k] = { ...(g.modules[k] || {}), [f]: v } as Partial<LabModule>;
    if (base) {
      const full = mods(MAIN.graph)[k] as unknown as Record<string, unknown>;
      const cur = g.modules[k] as Record<string, unknown>;
      for (const x in cur) if (JSON.stringify(cur[x]) === JSON.stringify(full[x])) delete cur[x];
      if (!Object.keys(cur).length) delete g.modules[k];
    }
  });
}

export function moveCtx(from: number, to: number) {
  edit(() => {
    const a = node(selId())!.ctx;
    if (to < 0 || to >= a.length) return;
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x);
  });
}

function addCtx(k: string) {
  edit(() => {
    node(selId())!.ctx.push(k);
  });
}

/** "New module…" in the picker: adds a module, puts it in the step's reads and opens it on the Modules page. */
function newModuleHere() {
  const id = selId();
  let k = "";
  edit(() => {
    k = newModule();
    node(id)!.ctx.push(k);
  });
  set({ addCtxOpen: false, modFocus: k });
  go("modules");
}

export function ReadsStack({ n, g }: { n: LabNode; g: LabGraph }) {
  useLab();
  const drag = useRef<number | null>(null);
  if (!n.ctx.length) return <p className="hint" style={{ margin: 0 }}>Reads nothing yet.</p>;
  const toks = n.ctx.map((c) => ctxTokens({ ctx: [c] }, g));
  const max = Math.max(...toks);
  const cut = n.ctx.findIndex((c) => !isStable(c, g));
  return (
    <>
      <div className="stack" id="stack">
        {n.ctx.map((c, i) => {
          const o = c.startsWith("out:");
          const nm = o ? (node(c.slice(4))?.label || c.slice(4)) + "'s output" : mods(g)[c]?.name || c;
          const tk = toks[i];
          const h = Math.round(26 + Math.sqrt(tk / max) * 34);
          const st = isStable(c, g);
          const when = st ? "Same every turn" : "Changes every turn";
          return (
            <Fragment key={c}>
              {i === cut && i > 0 ? (
                <div className="cutline">
                  <span>cached above</span>
                </div>
              ) : null}
              <div
                className={`blk2 ${st ? "st" : "vol"}`}
                draggable="true"
                data-i={i}
                data-openmod={o ? undefined : c}
                title={o ? undefined : "Open"}
                style={{ height: h }}
                onClick={
                  o
                    ? undefined
                    : (e) => {
                        if ((e.target as Element).closest("button")) return;
                        set({ viewer: { kind: "module", key: c } });
                      }
                }
                onDragStart={(e) => {
                  drag.current = i;
                  e.currentTarget.classList.add("drag");
                  try {
                    e.dataTransfer.setData("text/plain", String(i));
                  } catch {
                    /* some browsers refuse setData; the drag still works */
                  }
                }}
                onDragEnd={(e) => e.currentTarget.classList.remove("drag")}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add("over");
                }}
                onDragLeave={(e) => e.currentTarget.classList.remove("over")}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove("over");
                  if (drag.current != null && drag.current !== i) moveCtx(drag.current, i);
                  drag.current = null;
                }}
              >
                <span className="grip" aria-hidden="true">
                  <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
                    <circle cx="9" cy="7" r="1" fill="currentColor" />
                    <circle cx="15" cy="7" r="1" fill="currentColor" />
                    <circle cx="9" cy="12" r="1" fill="currentColor" />
                    <circle cx="15" cy="12" r="1" fill="currentColor" />
                    <circle cx="9" cy="17" r="1" fill="currentColor" />
                    <circle cx="15" cy="17" r="1" fill="currentColor" />
                  </svg>
                </span>
                {o ? null : (
                  <button
                    className="cdot"
                    data-flip={c}
                    aria-label={`${when}: click to switch`}
                    title={when}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMod(c, "stable", !isStable(c));
                    }}
                  />
                )}
                <span className="bn">
                  {o ? <Ic k={node(c.slice(4))?.icon || "code"} style={{ width: 14, height: 14 }} /> : null}
                  {nm}
                </span>
                <span className="k">{(tk / 1000).toFixed(1)}k</span>
                <span className="mv">
                  <button data-up={i} aria-label={`Move ${nm} up`} disabled={i === 0} onClick={() => moveCtx(i, i - 1)}>
                    <svg className="i" viewBox="0 0 24 24" style={{ width: 12, height: 12 }}>
                      <path d="M6 15l6-6 6 6" />
                    </svg>
                  </button>
                  <button data-dn={i} aria-label={`Move ${nm} down`} disabled={i === n.ctx.length - 1} onClick={() => moveCtx(i, i + 1)}>
                    <svg className="i" viewBox="0 0 24 24" style={{ width: 12, height: 12 }}>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <button
                    data-rm={i}
                    aria-label={`Remove ${nm}`}
                    onClick={() =>
                      edit(() => {
                        node(selId())!.ctx.splice(i, 1);
                      })
                    }
                  >
                    <svg className="i" viewBox="0 0 24 24" style={{ width: 12, height: 12 }}>
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div className="flex hint" style={{ marginTop: 6, fontSize: 11.5, gap: 12 }}>
        <span className="flex" style={{ gap: 5 }}>
          <span className="sw2 st"></span>same every turn
        </span>
        <span className="flex" style={{ gap: 5 }}>
          <span className="sw2 vol"></span>changes every turn
        </span>
      </div>
    </>
  );
}

/** The Add picker: modules by kind, "New module…", and other steps' outputs (spec line 164, handlers 181-182). */
export function AddPicker({ n, g }: { n: LabNode; g: LabGraph }) {
  useLab();
  if (!lab.addCtxOpen) return null;
  return (
    <div className="pick">
      {Object.entries(SRC_KINDS).map(([kk, K]) => {
        const l = Object.entries(mods(g)).filter(([k, v]) => v.kind === kk && !n.ctx.includes(k));
        return l.length ? (
          <Fragment key={kk}>
            <div className="h">{K.name}</div>
            {l.map(([k, v]) => (
              <button key={k} data-add={k} onClick={() => addCtx(k)}>
                <span>{v.name}</span>
                <span style={{ color: "var(--dim)", fontFamily: "var(--mono)", fontSize: 11 }}>{(v.tok / 1000).toFixed(1)}k</span>
              </button>
            ))}
          </Fragment>
        ) : null;
      })}
      <button data-newmod="1" style={{ color: "var(--accent)" }} onClick={newModuleHere}>
        <span className="flex" style={{ gap: 6, flexWrap: "nowrap" }}>
          <svg className="i" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
            <path d="M12 5v14M5 12h14" />
          </svg>
          New module…
        </span>
      </button>
      <div className="h">{"Another step's output"}</div>
      {g.nodes
        .filter((x) => x.id !== n.id && !n.ctx.includes("out:" + x.id) && MODELS[x.model]?.runs !== "code")
        .map((x) => (
          <button key={x.id} data-add={"out:" + x.id} onClick={() => addCtx("out:" + x.id)}>
            <span className="flex" style={{ gap: 8, flexWrap: "nowrap" }}>
              <Ic k={x.icon} style={{ width: 14, height: 14 }} />
              {x.label}
            </span>
          </button>
        ))}
    </div>
  );
}

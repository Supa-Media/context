/**
 * The Lab's Modules page (drawn inside `#modPg`): ported from the artifact's
 * `renderModules` (spec-b.js 75-99). Each module card's fields commit on
 * change, as the artifact's `onchange` did; the card a new module opens on is
 * scrolled to and its name selected once the page has drawn.
 */
import { useEffect, useRef } from "react";
import { SRC_KINDS } from "../data/modules";
import { mods, newModule } from "../engine/modules";
import { G, MAIN, edit, go, set } from "../engine/state";
import type { LabModule, LabNode } from "../types";
import { useLab } from "../store";
import { Ic } from "./ic";
import { onCommit } from "./props/change";
import { setMod } from "./props/ReadsStack.web";
import { PageHead } from "./parts";

export function Modules() {
  const lab = useLab();
  const selectNew = useRef<string | null>(null);
  const g = G();
  const M = mods(g);
  const main = mods(MAIN.graph);
  const used = (k: string) => g.nodes.filter((n) => n.ctx.includes(k));
  // The artifact drew the focus ring once and kept it until the page drew again; a toast coming or going did not
  // redraw the page, so a redraw that changed nothing but the toast keeps the ring.
  const shown = useRef<{ key: string | null; sig: string }>({ key: null, sig: "" });
  const sig = JSON.stringify([g, lab.sel, lab.view, lab.cur.id, lab.cur.name, lab.dirty, lab.viewer]);
  if (lab.modFocus) shown.current = { key: lab.modFocus, sig };
  else if (shown.current.sig !== sig) shown.current = { key: null, sig };
  const focusKey = shown.current.key;

  // After the page draws: scroll the focused card into view (the artifact's rAF), select a new module's name, then clear the focus without a redraw.
  useEffect(() => {
    const k = lab.modFocus;
    if (!k) return;
    const card = document.getElementById("mod-" + k);
    if (card) requestAnimationFrame(() => card.scrollIntoView({ block: "nearest" }));
    if (selectNew.current === k) card?.querySelector("input")?.select();
    selectNew.current = null;
    lab.modFocus = null;
  });

  const onNew = () => {
    let k = "";
    edit(() => {
      k = newModule();
    });
    selectNew.current = k;
    set({ modFocus: k });
  };

  return (
    <>
      <PageHead
        icon={
          <svg className="i" viewBox="0 0 24 24">
            <rect x="4" y="4" width="16" height="5" rx="1.5" />
            <rect x="4" y="11" width="16" height="4" rx="1.5" />
            <rect x="4" y="17" width="16" height="3" rx="1.5" />
          </svg>
        }
        title="Context modules"
      >
        What a step can read. Edits and new modules belong to this version.
      </PageHead>
      <div className="flex" style={{ margin: "0 0 14px" }}>
        <button className="primary" id="mNew" onClick={onNew}>
          <svg className="i" viewBox="0 0 24 24" style={{ width: 16, height: 16 }}>
            <path d="M12 5v14M5 12h14" />
          </svg>
          New module
        </button>
      </div>
      {Object.entries(SRC_KINDS).map(([kk, K]) => {
        const list = Object.entries(M)
          .filter(([, v]) => v.kind === kk)
          .sort((x, y) => (y[1].custom ? 1 : 0) - (x[1].custom ? 1 : 0));
        if (!list.length) return null;
        return (
          <section className="ksec" key={kk}>
            <div className="kh">
              <Ic k={K.icon} style={{ width: 16, height: 16 }} />
              <b>{K.name}</b>
              <span className="hint">{K.tip}</span>
            </div>
            <div className="mgrid">
              {list.map(([k, v]) => (
                <ModCard focus={focusKey === k}
                  key={k}
                  k={k}
                  v={v}
                  ch={!v.custom && JSON.stringify(v) !== JSON.stringify(main[k])}
                  u={used(k)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function ModCard({ k, v, ch, u, focus }: { k: string; v: LabModule; ch: boolean; u: LabNode[]; focus: boolean }) {
  useLab();
  const textHint = SRC_KINDS[v.kind ?? ""]?.edit || "Its text";
  return (
    <div className={"mcard " + (focus ? "focus" : "")} id={"mod-" + k}>
      <div className="mh">
        <span className={"sw2 " + (v.stable ? "st" : "vol")} />
        <input
          data-mk={k}
          data-mf="name"
          key={"name:" + v.name}
          defaultValue={v.name}
          aria-label="Module name"
          ref={onCommit((x) => setMod(k, "name", x.trim() || "Untitled"))}
        />
        {v.custom ? <span className="pill acc">new</span> : ch ? <span className="pill warn">edited</span> : null}
      </div>
      {v.custom ? (
        <>
          <div className="mrow">
            <label className="num" style={{ width: "auto", flex: 1 }}>
              <span>Comes from</span>
              <select
                data-mk={k}
                data-mf="kind"
                key={"kind:" + v.kind}
                defaultValue={v.kind}
                ref={onCommit((x) => setMod(k, "kind", x))}
              >
                {Object.entries(SRC_KINDS).map(([x, K]) => (
                  <option key={x} value={x}>
                    {K.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            className="mpath"
            data-mk={k}
            data-mf="path"
            key={"path:" + v.path}
            defaultValue={v.path}
            placeholder={v.kind === "ailc" ? "ai/production/…" : v.kind === "store" ? "tex/…" : "where it lives"}
            spellCheck={false}
            aria-label="Where it lives"
            ref={onCommit((x) => setMod(k, "path", x))}
          />
        </>
      ) : (
        <div className="mpath ro">{v.path}</div>
      )}
      <div className="mrow">
        <label className="num">
          <span>Tokens</span>
          <input
            type="number"
            min={0}
            step={100}
            data-mk={k}
            data-mf="tok"
            key={"tok:" + v.tok}
            defaultValue={v.tok}
            ref={onCommit((x) => setMod(k, "tok", Math.max(0, +x || 0)))}
          />
        </label>
        <div className="toggle" style={{ flex: 1 }}>
          <span>Changes every turn</span>
          <button
            className="sw"
            role="switch"
            data-mk={k}
            data-mf="stable"
            aria-checked={!v.stable}
            aria-label="Changes every turn"
            onClick={() => setMod(k, "stable", !v.stable)}
          />
        </div>
      </div>
      <textarea
        className="note"
        rows={2}
        data-mk={k}
        data-mf="about"
        key={"about:" + v.about}
        defaultValue={v.about}
        placeholder="What it holds"
        aria-label="What it holds"
        ref={onCommit((x) => setMod(k, "about", x))}
      />
      <textarea
        className="note mono"
        rows={2}
        data-mk={k}
        data-mf="text"
        key={"text:" + v.text}
        defaultValue={v.text}
        placeholder={textHint}
        aria-label={textHint}
        ref={onCommit((x) => setMod(k, "text", x))}
      />
      {v.text ? (
        <button className="lnk" data-mcount={k} onClick={() => setMod(k, "tok", Math.ceil((v.text ?? "").length / 4))}>
          {`Use ${Math.ceil(v.text.length / 4).toLocaleString()} tokens, counted from the text`}
        </button>
      ) : null}
      <div className="chips">
        {u.length ? (
          u.map((n) => (
            <button
              key={n.id}
              className="pill"
              data-mstep={n.id}
              onClick={() => {
                set({ sel: { t: "node", id: n.id } });
                go("canvas");
              }}
            >
              <Ic k={n.icon} style={{ width: 13, height: 13 }} />
              {n.label}
            </button>
          ))
        ) : (
          <span className="hint" style={{ fontSize: 12 }}>
            No step reads it yet
          </span>
        )}
      </div>
      {v.custom || ch ? (
        <div className="flex" style={{ justifyContent: "flex-end" }}>
          {ch ? (
            <button className="lnk" data-mreset={k} onClick={() => edit(() => void delete G().modules![k])}>
              Back to main
            </button>
          ) : null}
          {v.custom ? (
            <button
              className="danger sm"
              data-mdel={k}
              onClick={() =>
                edit(() => {
                  const gg = G();
                  delete gg.modules![k];
                  for (const n of gg.nodes) n.ctx = n.ctx.filter((c) => c !== k);
                })
              }
            >
              <Ic k="trash" style={{ width: 14, height: 14 }} />
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

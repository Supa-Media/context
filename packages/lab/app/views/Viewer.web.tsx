/**
 * The Lab's viewer: what the shell's `#viewer` holds (its `.vbox`). Ported
 * from the artifact's `openDiff` (the wording diff), `openViewer` (a module's
 * text) and `openWs` (the workspace browser, in ./Workspace.web). The shell
 * shows `#viewer` while `lab.viewer` is set; the backdrop click and Escape
 * close it from here.
 */
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { SRC_KINDS } from "../data/modules";
import { MODTEXT } from "../labData.generated";
import { mods, fp, wdiff, wcount } from "../engine/modules";
import { G, MAIN, edit, set } from "../engine/state";
import { useLab } from "../store";
import { Ic } from "./ic";
import { Workspace } from "./Workspace.web";

const close = () => set({ viewer: null });
const tokens = (t: string) => Math.ceil(t.length / 4).toLocaleString() + " tokens";

function CloseX() {
  return (
    <button className="ib" id="vX" aria-label="Close" onClick={close}>
      <svg className="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
  );
}

export function Viewer() {
  const s = useLab();

  useEffect(() => {
    const el = document.getElementById("viewer");
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      if (e.target === el) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("keydown", onKey);
    };
  }, []);

  const vw = s.viewer;
  if (!vw) return null;
  if (vw.kind === "ws") return <Workspace key={"ws:" + vw.ws} ws={vw.ws} at={vw.at} />;
  if (vw.kind === "diff") return <DiffView key={"diff:" + vw.key} k={vw.key} />;
  return <ModuleView key={"module:" + vw.key} k={vw.key} />;
}

function DiffView({ k }: { k: string }) {
  useLab();
  const v = mods()[k];
  if (!v) return null;
  const m0 = mods(MAIN.graph)[k] || { text: "" };
  const d = wdiff(m0.text || "", v.text || "");
  const c = wcount(d);
  return (
    <div className="vbox">
      <div className="vh">
        <Ic k="code" style={{ width: 18, height: 18 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{v.name}</b>
          <div className="mpath ro">
            main {m0.text ? fp(m0.text) : "(not in the Lab)"} → {fp(v.text || "")} · +{c.p} −{c.m} words
          </div>
        </div>
        <CloseX />
      </div>
      <div className="wdv">
        {d.map(([k2, t], i) =>
          k2 === "=" ? <Fragment key={i}>{t}</Fragment> : k2 === "+" ? <ins key={i}>{t}</ins> : <del key={i}>{t}</del>,
        )}
      </div>
      <div className="vf">
        <span className="spacer" />
        <button className="ghost" id="vEdit" onClick={() => set({ viewer: { kind: "module", key: k } })}>
          Edit
        </button>
      </div>
    </div>
  );
}

function ModuleView({ k }: { k: string }) {
  useLab();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const tokRef = useRef<HTMLSpanElement>(null);

  // The artifact focused the text at its start and scrolled it to the top.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (tokRef.current) tokRef.current.textContent = tokens(ta.value);
    ta.focus();
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
  }, []);

  const v = mods()[k];
  if (!v) return null;
  const K: { name?: string; icon?: string; edit?: string } = SRC_KINDS[v.kind ?? ""] || {};
  const main = mods(MAIN.graph)[k];
  const edited = !v.custom && main && v.text !== main.text;
  const none = !v.text && !MODTEXT[k];
  const hint =
    v.kind === "ailc"
      ? "Lives in @context-lc, not copied here. Paste the new text to try it."
      : v.kind === "derived"
        ? "Built each turn. Describe how to build it instead."
        : K.edit || "";

  const save = () => {
    const t = taRef.current?.value ?? "";
    close();
    if (t === v.text) return;
    edit(() => {
      const g = G();
      g.modules = g.modules || {};
      const m = (g.modules[k] = { ...(g.modules[k] || {}), text: t });
      if (t) m.tok = Math.ceil(t.length / 4);
      const full: Record<string, unknown> = main || {};
      for (const x in m) if (!v.custom && JSON.stringify(m[x as keyof typeof m]) === JSON.stringify(full[x])) delete m[x as keyof typeof m];
      if (!Object.keys(m).length) delete g.modules[k];
    });
  };

  const reset = () => {
    close();
    edit(() => {
      const g = G();
      const m = g.modules?.[k];
      if (m) {
        delete m.text;
        delete m.tok;
        if (!Object.keys(m).length) delete g.modules![k];
      }
    });
  };

  return (
    <div className="vbox">
      <div className="vh">
        <Ic k={K.icon || "code"} style={{ width: 18, height: 18 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{v.name}</b>
          <div className="mpath ro">
            {K.name || ""} · {v.path}
          </div>
        </div>
        <span className="hint" id="vTok" ref={tokRef} />
        <CloseX />
      </div>
      <textarea
        id="vText"
        ref={taRef}
        spellCheck={false}
        placeholder={hint}
        defaultValue={v.text}
        onInput={() => {
          if (tokRef.current && taRef.current) tokRef.current.textContent = tokens(taRef.current.value);
        }}
      />
      <div className="vf">
        {none ? <span className="hint">{hint}</span> : null}
        <span className="spacer" />
        {edited || (v.text && !main?.text) ? (
          <button className="ghost" id="vDiff" onClick={() => set({ viewer: { kind: "diff", key: k } })}>
            See the change
          </button>
        ) : null}
        {edited ? (
          <button className="ghost" id="vReset" onClick={reset}>
            Back to main
          </button>
        ) : null}
        <button className="primary" id="vSave" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

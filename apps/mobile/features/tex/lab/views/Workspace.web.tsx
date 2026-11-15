/**
 * The Lab's workspace browser: a port of the artifact's `openWs`. It draws the
 * inside of `#viewer` (the outer box is TexLab.web.tsx's): the workspace's notes
 * grouped by folder, and the chosen note's text. Closes on X, backdrop or Escape.
 */
import { Fragment, useEffect } from "react";
import { set } from "../engine/state";
import { Ic } from "./ic";
import { wsTree } from "./wsTree";

const close = () => set({ viewer: null });

export function Workspace({ ws, at }: { ws: string; at?: string }) {
  const { files, paths, cur, groups } = wsTree(ws, at);

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
    document.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="vbox wsbox">
      <div className="vh">
        <Ic k="door" style={{ width: 18, height: 18 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{ws}</b>
          <div className="mpath ro">
            apps/mcp/bench/ai/workspaces/{ws} · {paths.length} notes
          </div>
        </div>
        <button className="ib" id="vX" aria-label="Close" onClick={close}>
          <svg className="i" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="wsg">
        <nav className="wst">
          {Object.keys(groups)
            .sort()
            .map((d) => (
              <Fragment key={d}>
                {d ? <div className="wsd">{d}/</div> : null}
                {groups[d].map((q) => (
                  <button
                    key={q}
                    data-wf={q}
                    aria-current={String(q === cur) as "true" | "false"}
                    style={{ paddingLeft: d ? 20 : 8 }}
                    onClick={() => set({ viewer: { kind: "ws", ws, at: q } })}
                  >
                    {q.slice(d ? d.length + 1 : 0)}
                  </button>
                ))}
              </Fragment>
            ))}
        </nav>
        <pre className="wsn">{files[cur] || ""}</pre>
      </div>
    </div>
  );
}

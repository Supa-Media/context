/**
 * The hover card over a changed, new or removed step, and the legend for the marks (Dev2, 2026-11-15; design
 * https://claude.ai/artifact/VnAnSNDprEUJ4fFDEmXqhp, board 3): what changed, from what to what, who and in which
 * revision, with "Show ghost" and "Put back".
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { fieldText, putBack, wireKey, type Marks } from "../../engine/changeMarks";
import { stepById } from "../../engine/cases";
import { live, whoLabel } from "../../engine/live";
import { G, lab, set } from "../../engine/state";
import type { LabNode } from "../../types";

/** The newest change in the draft's feed that touched a step, for "Claude · rev 2". */
function lastTouch(id: string) {
  const mine = lab.me?.handle ?? (lab.myId ? lab.names?.[lab.myId] : null) ?? null;
  const c = [...live.feed.changes].reverse().find((x) => (x.keys || []).some((k) => k === "n:" + id || k.startsWith("n:" + id + ":") || k.startsWith("e:" + id + ">") || k.includes(">" + id + ">")));
  return c ? `${whoLabel(c, mine)} · rev ${c.rev}` : null;
}

/** What a step's wires gained and lost. */
function wireLines(m: Marks, id: string): { gone: string[]; added: string[] } {
  const name = (x: string) => stepById(x)?.label ?? x;
  const gone = m.goneWires.filter((w) => w.from.id === id || w.to.id === id).map((w) => `${w.from.label} → ${w.to.label} (${w.mode})`);
  const added = G()
    .edges.filter((e) => (e.from === id || e.to === id) && m.newWires.has(wireKey(e)))
    .map((e) => `${name(e.from)} → ${name(e.to)} (${e.mode})`);
  return { gone, added };
}

/** One step's changes as rows of field, what it was and what it is (shared with the step panel). */
export function ChangeRows({ m, id }: { m: Marks; id: string }) {
  const x = m.nodes[id];
  const cur = G().nodes.find((n) => n.id === id);
  if (!x || !cur) return null;
  const rows: Array<{ k: string; from: string; to: string }> = [];
  for (const f of x.fields) {
    if (f === "wires") {
      const w = wireLines(m, id);
      rows.push({ k: "wires", from: w.gone.join("; "), to: w.added.join("; ") });
    } else if (x.base && fieldText(x.base, f) !== "") rows.push({ k: f, from: fieldText(x.base, f), to: fieldText(cur, f) });
    else rows.push({ k: f, from: "", to: "" });
  }
  if (x.moved && x.base) rows.push({ k: "place", from: `${x.base.x}, ${x.base.y}`, to: `${cur.x}, ${cur.y}` });
  return (
    <div className="tr">
      {rows.map((r) => (
        <div key={r.k} style={{ display: "contents" }}>
          <span className="k">{r.k}</span>
          <span>
            {r.from ? <span className="vold">{r.from}</span> : null} {r.to ? <span className="vnew">{r.to}</span> : null}
            {!r.from && !r.to ? <span className="hint">changed</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ChangeTip({ marks, stage }: { marks: Marks | null; stage: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const now = useRef<Marks | null>(marks);
  now.current = marks;
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const markOf = (t: EventTarget | null) => {
      const el = (t as Element | null)?.closest?.("[data-id],[data-mark]") as Element | null;
      const id = el?.getAttribute("data-id") ?? el?.getAttribute("data-mark");
      const m = now.current;
      return el && id && m && (m.nodes[id] || m.removed.some((n) => n.id === id)) ? { el, id } : null;
    };
    const over = (e: PointerEvent) => {
      const hit = markOf(e.target);
      if (!hit) return;
      clearTimeout(hide.current);
      const r = hit.el.getBoundingClientRect();
      setTip({ id: hit.id, x: Math.max(12, Math.min(r.left, window.innerWidth - 412)), y: Math.min(r.bottom + 10, window.innerHeight - 200) });
    };
    const out = (e: PointerEvent) => {
      if (markOf(e.target)) hide.current = setTimeout(() => setTip(null), 350);
    };
    st.addEventListener("pointerover", over);
    st.addEventListener("pointerout", out);
    return () => {
      st.removeEventListener("pointerover", over);
      st.removeEventListener("pointerout", out);
      clearTimeout(hide.current);
    };
  }, [stage]);
  if (!tip || !marks) return null;
  const x = marks.nodes[tip.id];
  const gone = marks.removed.find((n) => n.id === tip.id);
  const n: LabNode | undefined = gone ?? G().nodes.find((y) => y.id === tip.id);
  if (!n || (!x && !gone)) return null;
  const head = gone ? "removed" : x!.kind === "new" ? "new" : `${x!.fields.length + (x!.moved ? 1 : 0)} change${x!.fields.length + (x!.moved ? 1 : 0) === 1 ? "" : "s"}`;
  const who = lastTouch(tip.id);
  return (
    <div className="chgtip" role="tooltip" id="chgTip" style={{ left: tip.x, top: tip.y }} onPointerEnter={() => clearTimeout(hide.current)} onPointerLeave={() => setTip(null)}>
      <div className="flex" style={{ gap: 8 }}>
        <b style={{ flex: 1, fontSize: 13 }}>
          {n.label} · {head}
        </b>
        {who ? <span style={{ color: "var(--team)", fontWeight: 600, fontSize: 11 }}>{who}</span> : null}
      </div>
      {x && x.kind === "changed" ? <ChangeRows m={marks} id={tip.id} /> : null}
      {gone ? <div className="hint">On {marks.vs}, not in this draft.</div> : null}
      {x?.kind === "new" ? <div className="hint">Not on {marks.vs}.</div> : null}
      <div className="flex" style={{ gap: 12 }}>
        <button className="lnk" id="tipGhost" onClick={() => set({ chg: marks.mode === "ghost" ? "marks" : "ghost" })}>
          {marks.mode === "ghost" ? "Show marks" : "Show ghost"}
        </button>
        {lab.mode === "replay" ? null : (
          <button
            className="lnk"
            id="tipPutBack"
            onClick={() => {
              putBack(tip.id);
              setTip(null);
            }}
          >
            {marks.vs === "main" ? "Put back main's" : `Put back ${marks.vs}'s`}
          </button>
        )}
      </div>
    </div>
  );
}

/** The marks' legend at the canvas's top. */
export function ChangeLegend({ mode, vs }: { mode: "marks" | "ghost"; vs: string }) {
  return (
    <div className="float chglegend" id="chgLegend">
      {mode === "marks" ? (
        <>
          <span>
            <i style={{ background: "var(--warn)" }} />~ changed
          </span>
          <span>
            <i style={{ background: "var(--ok)" }} />+ new
          </span>
          <span>
            <i style={{ background: "var(--bad)" }} />− removed
          </span>
          <span className="hint">unchanged steps fade back</span>
        </>
      ) : (
        <>
          <span>
            <i style={{ border: "1.5px dashed var(--muted)", borderRadius: 3, width: 20 }} />
            {vs}, as a ghost
          </span>
          <span>
            <i style={{ border: "1.5px solid var(--text)", borderRadius: 3, width: 20, background: "var(--page)" }} />
            this draft
          </span>
        </>
      )}
    </div>
  );
}

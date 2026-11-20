/**
 * The draft's live part of the Lab (Dev2, 2026-11-15): the top bar's "● Claude Code is editing" and "rev N · saved"
 * chips, and the Changes list in the sidebar: what each side just did to this draft, newest first.
 */
import { currentMarks, markCounts } from "../engine/changeMarks";
import { stepById } from "../engine/cases";
import { aiClient, ago, isLive, live, whoLabel, type Change } from "../engine/live";
import { emit, isMain, lab, MAIN, node, set } from "../engine/state";

const myHandle = () => lab.me?.handle ?? (lab.myId ? lab.names?.[lab.myId] : null) ?? null;

export function LiveChips() {
  if (!isLive()) return null;
  const ai = aiClient();
  return (
    <>
      {ai ? (
        <span className="lchip ai" id="liveAi" title="An AI client is changing this draft over the Context connection">
          {ai} is editing
        </span>
      ) : null}
      <span className="lchip" id="liveRev" title="Every edit is saved as it happens">
        rev {live.rev} · {lab.dirty || live.inflight ? "saving" : "saved"}
      </span>
    </>
  );
}

/**
 * The top bar's "Changes  Off | Marks | Ghost  against  main | last rev" (Dev2, 2026-11-15): how a draft's changes are
 * drawn on the graph (`engine/changeMarks.ts`). "last rev" steps back one revision a tap once it is on.
 */
export function ChangeToggles() {
  if (isMain()) return null;
  const canRev = isLive() && live.rev > 1;
  const vsRev = typeof lab.chgVs === "number";
  return (
    <span className="chgbar" id="chgBar">
      <span>Changes</span>
      <span className="segs" role="group" aria-label="Show changes">
        {(["off", "marks", "ghost"] as const).map((k) => (
          <button key={k} data-chg={k} aria-pressed={lab.chg === k} onClick={() => set({ chg: k })}>
            {k === "off" ? "Off" : k === "marks" ? "Marks" : "Ghost"}
          </button>
        ))}
      </span>
      <span>against</span>
      <span className="segs" role="group" aria-label="Compare against">
        <button data-vs="main" aria-pressed={!vsRev} onClick={() => set({ chgVs: "main", revBase: null })}>
          main
        </button>
        <button
          data-vs="rev"
          aria-pressed={vsRev}
          disabled={!canRev}
          title={canRev ? (vsRev ? "Tap again to go one revision further back" : "What the newest revision changed") : "A saved draft with two or more revisions"}
          onClick={() => {
            // First tap: the newest revision alone; each tap after reaches one revision further back, then main again.
            const n = vsRev ? (lab.chgVs as number) - 1 : live.rev;
            set(n >= 2 ? { chgVs: n, chg: lab.chg === "off" ? "marks" : lab.chg } : { chgVs: "main", revBase: null });
          }}
        >
          {vsRev ? `since rev ${(lab.chgVs as number) - 1}` : "last rev"}
        </button>
      </span>
    </span>
  );
}

/** The steps a change touched, by its keys (`n:<step>…`, `e:<from>><to>>…`). */
const stepsOf = (c: Change) => [...new Set((c.keys || []).flatMap((k) => (k.startsWith("n:") ? [k.split(":")[1]] : k.startsWith("e:") ? [k.slice(2).split(">")[0]] : [])))];

export function LiveChanges() {
  if (!isLive()) return null;
  const rows = [...live.feed.changes].sort((a, b) => b.rev - a.rev).slice(0, 30);
  const marks = currentMarks();
  const n = markCounts(marks);
  const sym = (id: string) => (marks?.removed.some((x) => x.id === id) ? "−" : marks?.nodes[id]?.kind === "new" ? "+" : marks?.nodes[id] ? "~" : "");
  const label = (id: string) => node(id)?.label ?? stepById(id)?.label ?? node(id, MAIN.graph)?.label ?? id;
  return (
    <>
      <div className="sec">
        <span>Changes{marks ? ` vs ${marks.vs}` : ""}</span>
        {marks ? (
          <span className="chgsum" id="chgSum">
            <span className="pill warn">{n.changed} ~</span>
            <span className="pill ok">{n.added} +</span>
            <span className="pill bad">{n.removed} −</span>
          </span>
        ) : null}
      </div>
      <div className="chg" id="changes">
        {rows.length ? (
          rows.map((c) => {
            const ids = stepsOf(c);
            const on = lab.sel?.t === "node" && ids.includes(lab.sel.id);
            return (
            <div
              key={c.rev}
              className={"row" + (c.via !== "lab" ? " ai" : "") + (on ? " on" : "")}
              data-rev={c.rev}
              title={ids.length ? "Show it on the graph" : undefined}
              onClick={() => {
                // Each row lights its step: selected, so the graph and the panel both show it.
                const id = ids.find((x) => node(x));
                if (id) set({ sel: { t: "node", id }, view: "canvas" });
                else emit();
              }}
            >
              <span>
                {ids.length ? (
                  <b>
                    {ids.slice(0, 2).map((id) => `${sym(id)} ${label(id)}`.trim()).join(", ")}
                  </b>
                ) : null}{" "}
                <b>{whoLabel(c, myHandle())}</b> {c.said.join("; ") || "changed the draft"}
              </span>
              <small>
                rev {c.rev} · {ago(c.at)}
              </small>
            </div>
            );
          })
        ) : (
          <div className="none">Nothing changed yet.</div>
        )}
        <div className="none">Each row lights its step. A mark stays until the draft matches {marks?.vs ?? "main"} again, or is promoted.</div>
      </div>
    </>
  );
}

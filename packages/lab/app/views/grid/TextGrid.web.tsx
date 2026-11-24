/**
 * Texts as a grid, the Testing tab's way (Dev2, 2026-11-16: "instead of the chat bubble format, im starting to like
 * the more grid format for texts since its a little more platform agnostic ... can even reuse the columns that show
 * each tool output, here and in replay as well"; "if possible lets use the same component"). One row per text, a
 * column per step with what that step gave and how long it took, columns resized and picked like Testing's. `slim`
 * is Speaker and Message only (Replay's left side, Dev2: "just keep it on the left only showing speaker and message").
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { G, stepsOf } from "../../engine/state";
import { ColButton, colW, HeadCell, shown, startResize, useGridCols, type GridCol } from "./GridParts.web";

export type StepCell = {
  node: string;
  out: string;
  ms: number | null;
  ok?: boolean;
  /** Still running (no `ms` yet, its text running): for how long, in ms. Its output shows only once it is logged. */
  runningFor?: number;
};
export type TextRow = {
  id: string;
  who: string;
  text: string;
  tex?: boolean;
  quiet?: boolean;
  /** A text from the real chat, before the test texts. */
  prod?: boolean;
  /** A text sent in the test chat. */
  test?: boolean;
  /** Its turn is running now: the steps still to come stay blank. */
  running?: boolean;
  /** A line across the grid instead of a text (a day, "Test texts"). */
  sep?: string;
  /** The separator is a day heading, not the test texts' line. */
  day?: boolean;
  steps?: StepCell[];
  /** The step running now. */
  hot?: string | null;
  title?: string;
  /** Extra attributes on the row (Replay's `data-moment`). */
  attrs?: Record<string, string>;
  /** A class on the speaker's name (Replay's start steps: "cds"). */
  whoCls?: string;
  /** A quoted reply: who and what it answers. */
  quote?: string;
  /** Pictures sent with it (https URLs). */
  pics?: string[];
  /** Tapbacks on it, each as its emoji. */
  reactions?: string[];
  edited?: boolean;
  /** A reaction or an edit, not a text: drawn in italics. */
  evt?: boolean;
};

/** The steps a text column starts with (the mockup's): the rest are in the Columns menu. */
export const FIRST_STEPS = ["triage", "decide", "lanes", "prepareTheAnswer", "fd", "tools", "checks", "send"];
const SLIM_STEPS: string[] = [];

/** The row actions' column, right after the row's number (Dev2, 2026-11-16: "these buttons need to not be hidden all the way on the right"). */
const ACT_W = 76;

/** The # column fits the highest row number (Dev2, 2026-11-16: "more space is needed to see the # column for longer numbers"): 8 px a digit plus the cell's padding. */
export const numColW = (count: number) => Math.max(32, 14 + 8 * String(Math.max(1, count)).length);

/** A message: what it quotes, its text, edited, its tapbacks, its options button and its pictures. */
function msgCell(r: TextRow, msgExtra?: (r: TextRow) => ReactNode) {
  return (
    <>
      {r.quote ? <span className="q">↩ {r.quote}</span> : null}
      {r.quiet ? <span className="muted">(stays quiet)</span> : r.text}
      {r.edited ? <span className="ed">edited</span> : null}
      {r.reactions?.length ? (
        <span className="rx">
          {r.reactions.map((e, k) => (
            <span key={k}>{e}</span>
          ))}
        </span>
      ) : null}
      {msgExtra ? msgExtra(r) : null}
      {r.pics?.length ? (
        <span className="pics">
          {r.pics.map((u) => (
            <img key={u} src={u} alt="Picture sent" />
          ))}
        </span>
      ) : null}
    </>
  );
}

export const msWords = (ms: number | null) => (ms === null ? "" : ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function TextGrid(p: {
  gridKey: string;
  rows: TextRow[];
  slim?: boolean;
  sel?: string | null;
  selCol?: string | null;
  onRow?: (r: TextRow, col: string | null) => void;
  actions?: (r: TextRow) => ReactNode;
  /** After a message's text: its options button (the test chat's ⋯). */
  msgExtra?: (r: TextRow) => ReactNode;
  head?: ReactNode;
  /** After the Columns button (the test chat's Reset). */
  headEnd?: ReactNode;
  /** The grid folded to its head (the test chat's ▾). */
  folded?: boolean;
  empty?: ReactNode;
  id?: string;
  /** Shown in the grid's place, its head kept (the test chat's Timeline): the grid stays mounted, hidden. */
  alt?: ReactNode;
  /** Under the head, over the grid and `alt` alike (a made-up group chat's people strip). */
  sub?: ReactNode;
  /** When this changes, the grid scrolls to its last row (the test chat opens at its newest texts, Dev2 2026-11-16: "bottom panel should also start scrolled to the bottom"). */
  bottomKey?: string;
}) {
  // A column per step, never per folded group box.
  const g = stepsOf(G());
  const nodes: GridCol[] = g.nodes.filter((n) => n.kind !== "input").map((n) => ({ id: n.id, name: n.label }));
  const all: GridCol[] = [{ id: "who", name: "Speaker" }, { id: "text", name: "Message" }, ...(p.slim ? [] : nodes)];
  const [cols, save, reset] = useGridCols("texLab.grid." + p.gridKey, all.map((c) => c.id), ["who", "text", ...(p.slim ? SLIM_STEPS : FIRST_STEPS)]);
  const vc = shown(cols, all);
  const table = useRef<HTMLTableElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (p.bottomKey === undefined || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [p.bottomKey]);
  const numW = numColW(p.rows.filter((r) => !r.sep).length);
  const stepCols = vc.filter((c) => c.id !== "who" && c.id !== "text");
  const act = !!p.actions;
  const tw = p.slim ? null : numW + vc.reduce((a, c) => a + colW(cols, c.id), 0) + (act ? ACT_W : 0);
  return (
    <div className="tst tgrid" id={p.id}>
      <div className="ph">
        {p.head}
        {p.slim || p.alt ? null : <ColButton cols={cols} all={all} save={save} reset={reset} id={p.id ? p.id + "ColBtn" : undefined} />}
        {p.headEnd}
      </div>
      {p.folded ? null : p.sub}
      <div className="scroll" ref={scroller} hidden={p.folded || !!p.alt}>
        <table className="chatgrid" ref={table} style={{ width: tw === null ? "100%" : tw }}>
          <colgroup>
            {p.slim ? null : <col style={{ width: numW }} />}
            {act ? <col style={{ width: ACT_W }} /> : null}
            {vc.map((c) => (
              <col key={c.id} style={p.slim && c.id === "text" ? undefined : { width: colW(cols, c.id) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {p.slim ? null : <th className="num">#</th>}
              {act ? <th className="ach" /> : null}
              {vc.map((c, k) => (
                <HeadCell key={c.id} col={c} onResize={(e) => startResize(e, table.current, k + (p.slim ? 0 : 1) + (act ? 1 : 0), colW(cols, c.id), (w) => save({ ...cols, w: { ...cols.w, [c.id]: w } }))} />
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              let n = 0;
              return p.rows.map((r) => {
                if (r.sep) {
                  return (
                    <tr key={r.id} className={"sepr" + (r.day ? " day" : "")}>
                      <td colSpan={vc.length + (p.slim ? 0 : 1) + (act ? 1 : 0)}>{r.sep}</td>
                    </tr>
                  );
                }
                n++;
                const cls = ["mr", r.tex ? "tex" : "", r.prod ? "prod" : "", r.test ? "test" : "", p.sel === r.id ? "sel" : ""].filter(Boolean).join(" ");
                return (
                  <tr key={r.id} className={cls} data-id={r.id} title={r.title} {...r.attrs} onClick={(e) => p.onRow && !(e.target as HTMLElement).closest("button, .popm") && p.onRow(r, (e.target as HTMLElement).closest("td")?.getAttribute("data-c") || null)}>
                    {p.slim ? null : <td className="num mono muted">{n}</td>}
                    {act ? <td className="ac">{p.actions!(r)}</td> : null}
                    {vc.map((c) => {
                      if (c.id === "who") return <td key="who" data-c="who"><b className={[r.tex ? "texwho" : "", r.whoCls || ""].join(" ").trim() || undefined}>{r.who}</b></td>;
                      if (c.id === "text") return <td key="text" data-c="text" className={"txt" + (r.evt ? " evt" : "")}>{msgCell(r, p.msgExtra)}</td>;
                      return null;
                    })}
                    {r.tex
                      ? stepCols.length ? <td colSpan={stepCols.length} className="texcell" /> : null
                      : stepCols.map((c) => {
                          const st = r.steps?.find((x) => x.node === c.id);
                          const hot = r.running && r.hot === c.id;
                          const on = p.sel === r.id && p.selCol === c.id;
                          return (
                            <td key={c.id} data-c={c.id} className={"o" + (hot ? " hot" : "") + (on ? " on" : "") + (st && st.ok === false ? " bad" : "")} title={st ? (st.ms === null && st.runningFor !== undefined ? `${c.name}: running` : `${c.name}: ${st.out} · ${msWords(st.ms)}`) : undefined}>
                              {st && st.ms === null && st.runningFor !== undefined ? (
                                <>
                                  <span className="muted">running</span>
                                  <span className="tm">{msWords(st.runningFor)}</span>
                                </>
                              ) : st ? (
                                <>
                                  {st.out}
                                  <span className="tm">{msWords(st.ms)}</span>
                                </>
                              ) : r.running ? null : (
                                <span className="muted">–</span>
                              )}
                            </td>
                          );
                        })}
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
        {p.rows.length ? null : p.empty}
      </div>
      {p.alt && !p.folded ? p.alt : null}
    </div>
  );
}

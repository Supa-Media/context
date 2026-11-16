/**
 * Texts as a grid, the Testing tab's way (Dev2, 2026-11-16: "instead of the chat bubble format, im starting to like
 * the more grid format for texts since its a little more platform agnostic ... can even reuse the columns that show
 * each tool output, here and in replay as well"; "if possible lets use the same component"). One row per text, a
 * column per step with what that step gave and how long it took, columns resized and picked like Testing's. `slim`
 * is Speaker and Message only (Replay's left side, Dev2: "just keep it on the left only showing speaker and message").
 */
import { useRef, type ReactNode } from "react";
import { G } from "../../engine/state";
import { ColButton, colW, HeadCell, shown, startResize, useGridCols, type GridCol } from "./GridParts.web";

export type StepCell = { node: string; out: string; ms: number | null; ok?: boolean };
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
};

/** The steps a text column starts with (the mockup's): the rest are in the Columns menu. */
export const FIRST_STEPS = ["triage", "decide", "lanes", "prepareTheAnswer", "fd", "tools", "checks", "send"];
const SLIM_STEPS: string[] = [];

export const msWords = (ms: number | null) => (ms === null ? "" : ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export function TextGrid(p: {
  gridKey: string;
  rows: TextRow[];
  slim?: boolean;
  sel?: string | null;
  selCol?: string | null;
  onRow?: (r: TextRow, col: string | null) => void;
  actions?: (r: TextRow) => ReactNode;
  head?: ReactNode;
  empty?: ReactNode;
  id?: string;
}) {
  const g = G();
  const nodes: GridCol[] = g.nodes.filter((n) => n.kind !== "input").map((n) => ({ id: n.id, name: n.label }));
  const all: GridCol[] = [{ id: "who", name: "Speaker" }, { id: "text", name: "Message" }, ...(p.slim ? [] : nodes)];
  const [cols, save, reset] = useGridCols("texLab.grid." + p.gridKey, all.map((c) => c.id), ["who", "text", ...(p.slim ? SLIM_STEPS : FIRST_STEPS)]);
  const vc = shown(cols, all);
  const table = useRef<HTMLTableElement>(null);
  const stepCols = vc.filter((c) => c.id !== "who" && c.id !== "text");
  const act = !!p.actions;
  const tw = p.slim ? null : 32 + vc.reduce((a, c) => a + colW(cols, c.id), 0) + (act ? 112 : 0);
  return (
    <div className="tst tgrid" id={p.id}>
      <div className="ph">
        {p.head}
        {p.slim ? null : <ColButton cols={cols} all={all} save={save} reset={reset} id={p.id ? p.id + "ColBtn" : undefined} />}
      </div>
      <div className="scroll">
        <table className="chatgrid" ref={table} style={{ width: tw === null ? "100%" : tw }}>
          <colgroup>
            {p.slim ? null : <col style={{ width: 32 }} />}
            {vc.map((c) => (
              <col key={c.id} style={p.slim && c.id === "text" ? undefined : { width: colW(cols, c.id) }} />
            ))}
            {act ? <col style={{ width: 112 }} /> : null}
          </colgroup>
          <thead>
            <tr>
              {p.slim ? null : <th className="num">#</th>}
              {vc.map((c, k) => (
                <HeadCell key={c.id} col={c} onResize={(e) => startResize(e, table.current, k + (p.slim ? 0 : 1), colW(cols, c.id), (w) => save({ ...cols, w: { ...cols.w, [c.id]: w } }))} />
              ))}
              {act ? <th /> : null}
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
                  <tr key={r.id} className={cls} data-id={r.id} title={r.title} {...r.attrs} onClick={(e) => p.onRow && !(e.target as HTMLElement).closest("button") && p.onRow(r, (e.target as HTMLElement).closest("td")?.getAttribute("data-c") || null)}>
                    {p.slim ? null : <td className="num mono muted">{n}</td>}
                    {vc.map((c) => {
                      if (c.id === "who") return <td key="who" data-c="who"><b className={[r.tex ? "texwho" : "", r.whoCls || ""].join(" ").trim() || undefined}>{r.who}</b></td>;
                      if (c.id === "text") return <td key="text" data-c="text" className="txt">{r.quiet ? <span className="muted">(stays quiet)</span> : r.text}</td>;
                      return null;
                    })}
                    {act ? <td className="ac">{p.actions!(r)}</td> : null}
                    {r.tex
                      ? stepCols.length ? <td colSpan={stepCols.length} className="texcell" /> : null
                      : stepCols.map((c) => {
                          const st = r.steps?.find((x) => x.node === c.id);
                          const hot = r.running && r.hot === c.id;
                          const on = p.sel === r.id && p.selCol === c.id;
                          return (
                            <td key={c.id} data-c={c.id} className={"o" + (hot ? " hot" : "") + (on ? " on" : "") + (st && st.ok === false ? " bad" : "")} title={st ? `${c.name}: ${st.out} · ${msWords(st.ms)}` : undefined}>
                              {st ? (
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
    </div>
  );
}

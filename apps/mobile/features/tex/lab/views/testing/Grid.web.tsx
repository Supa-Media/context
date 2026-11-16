/**
 * The prototype's middle panel: one row per message, one column per node, edited like a database. Click a cell to
 * select it, Enter or double-click to edit, arrows move, drag ⠿ or Alt+↑/↓ to reorder, Del clears a label, T makes
 * a cell a unit test; columns resize by their edge and are picked, hidden and ordered in the Columns menu.
 */
import { useEffect, useRef, useState } from "react";
import { G } from "../../engine/state";
import { bodyOf, cellOf, colWidth, defaultCols, labelFields, newRowAt, freshId, SET_INFO, starsIn, stepNodes, type Conversation, type Message } from "../../engine/sets";
import { change, colsFor, saveCols, setUi, sets, undo, useSets } from "../../engine/setsStore";
import { History } from "./History.web";
import type { LabNode } from "../../types";
import { ColMenu as SharedColMenu, HeadCell, startResize as resizeCol } from "../grid/GridParts.web";
import { MsgFields, SpeakerPick } from "./MsgFields.web";

type Col = { id: string; name: string; node?: LabNode };

function colDefs(): Col[] {
  return [{ id: "who", name: "Speaker" }, { id: "text", name: "Message" }, ...stepNodes(G()).map((n) => ({ id: n.id, name: n.label, node: n }))];
}
export function visibleCols(): Col[] {
  const cols = colsFor(G());
  const all = colDefs();
  return cols.order.filter((id) => !cols.hidden.includes(id)).map((id) => all.find((c) => c.id === id)).filter((c): c is Col => !!c);
}

/** Select a cell; a row that is still empty goes when you leave it. */
export function selectCell(c: Conversation, msg: string, col: string, editing = false) {
  dropFresh(c, msg);
  setUi({ msg, col, editing });
}
function dropFresh(c: Conversation, keep: string | null) {
  const f = sets.fresh && sets.fresh !== keep ? c.msgs.find((x) => x.id === sets.fresh) : null;
  if (f && !f.text && !f.kind && !f.pics?.length) change(c.id, [{ op: "remove", msg: f.id }]);
  if (sets.fresh !== keep) sets.fresh = null;
}
/** Leave the editor; a fresh row left empty goes. */
export function doneEditing(c: Conversation) {
  const conv = sets.convs.find((x) => x.id === c.id) || c;
  const m = conv.msgs.find((x) => x.id === sets.msg);
  if (m && sets.fresh === m.id && !m.text && !m.kind && !m.pics?.length) {
    change(c.id, [{ op: "remove", msg: m.id }]);
    sets.msg = null;
  }
  setUi({ editing: false, fresh: null });
}

function addRow(c: Conversation, after: string | null) {
  const { at, who } = newRowAt(c, after);
  const id = freshId(c);
  change(c.id, [{ op: "addMsg", at, msg: { id, who, text: "" } }]);
  setUi({ msg: id, col: "text", editing: true, fresh: id });
}

function CellSym({ m, n }: { m: Message; n: LabNode }) {
  const x = cellOf(m, n);
  const st = x.star ? <span className="starc">★</span> : null;
  const v = x.value ? (
    <>
      {" "}
      <span className="cv">{x.value}</span>
    </>
  ) : null;
  if (x.sym === "★") return (<>{st}{v}</>);
  if (x.sym === "✓") return (<><span className="c-ok">✓</span>{v}</>);
  return (<>{st}<span className={x.cls}>{x.sym}</span>{x.sym === "!" ? v : null}</>);
}

function Body({ c, m }: { c: Conversation; m: Message }) {
  const b = bodyOf(c, m);
  const late = b.late ? (
    <>
      {" "}
      <span className="kind bad" title="Moved above the message it points at">
        ⚠ later message
      </span>
    </>
  ) : null;
  const pics = m.pics?.length ? <Pics m={m} /> : null;
  if (!b.kind) return m.text || pics ? <>{m.text}{pics}</> : <span className="muted">(empty)</span>;
  return (
    <>
      <span className="kind">{b.kind}</span>
      {late}{" "}
      {b.quoted !== null ? <span className="muted">“{b.quoted}”</span> : b.struck ? <s className="muted">{b.text}</s> : b.text}
      {pics}
    </>
  );
}

/** A message's pictures, small; each opens full size. */
export function Pics({ m }: { m: Message }) {
  return (
    <span className="pics">
      {(m.pics ?? []).map((p, k) => (
        <a key={k} className="pic" href={p.url} target="_blank" rel="noreferrer" title={p.name || "Picture"} onClick={(e) => e.stopPropagation()}>
          <img src={p.url} alt={p.name || "Picture"} loading="lazy" />
        </a>
      ))}
    </span>
  );
}

/** A node cell's editor: its first pick, else its first text, else its first must line. */
function NodeEditor({ c, m, n }: { c: Conversation; m: Message; n: LabNode }) {
  const l = m.labels?.[n.id] || {};
  const f = labelFields(n);
  const pick = Object.entries(f.picks)[0];
  const done = () => setUi({ editing: false });
  const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, keep: () => void) => {
    e.stopPropagation();
    if (e.key === "Escape") done();
    else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      keep();
      done();
    }
  };
  if (pick) {
    const [field, opts] = pick;
    return (
      <select className="ed" data-ed="node" data-f={field} autoFocus value={(l[field] as string) || ""} onKeyDown={(e) => keys(e, () => undefined)} onChange={(e) => (change(c.id, [{ op: "field", msg: m.id, node: n.id, field, value: e.target.value || null }]), done())}>
        <option value="">(no label)</option>
        {[...opts, "any"].map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    );
  }
  const field = f.texts[0];
  if (field) return <TextEd init={(l[field] as string) || ""} ph={field + "…"} keep={(v) => change(c.id, [{ op: "field", msg: m.id, node: n.id, field, value: v || null }])} onKey={keys} />;
  const must = (l.must as string[]) || [];
  return <TextEd init={must[0] || ""} ph="must…" keep={(v) => change(c.id, [{ op: "field", msg: m.id, node: n.id, field: "must", value: v ? [v, ...must.slice(1)] : must.slice(1).length ? must.slice(1) : null }])} onKey={keys} />;
}
function TextEd({ init, ph, keep, onKey }: { init: string; ph: string; keep: (v: string) => void; onKey: (e: React.KeyboardEvent<HTMLInputElement>, keep: () => void) => void }) {
  const [v, setV] = useState(init);
  const commit = () => v.trim() !== init && keep(v.trim());
  return <input className="ed" data-ed="txt" autoFocus placeholder={ph} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => sets.editing && commit()} onKeyDown={(e) => onKey(e, commit)} />;
}

function ColMenu() {
  const cols = colsFor(G());
  return <SharedColMenu id="colMenu" resetId="resetCols" cols={cols} all={colDefs()} save={saveCols} reset={() => saveCols(defaultCols(G()))} />;
}

function Title({ c }: { c: Conversation }) {
  const [on, setOn] = useState(false);
  if (!on || c.set === "test")
    return (
      <b title={c.set === "test" ? undefined : "Double-click to rename"} onDoubleClick={() => setOn(true)}>
        {c.title}
      </b>
    );
  const keep = (v: string) => (v.trim() && v.trim() !== c.title && change(c.id, [{ op: "title", value: v.trim() }]), setOn(false));
  return <input className="txtf" autoFocus aria-label="Chat title" defaultValue={c.title} onBlur={(e) => keep(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" ? keep(e.currentTarget.value) : e.key === "Escape" && setOn(false))} />;
}

export function Grid({ c }: { c: Conversation }) {
  const s = useSets();
  const g = G();
  const cols = colsFor(g);
  const vc = visibleCols();
  const tw = 48 + vc.reduce((a, x) => a + colWidth(cols, x.id), 0) + 28;
  const info = SET_INFO[c.set];
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // The selected row stays in view; with nothing selected the chat opens at its end.
  useEffect(() => {
    const sr = scroller.current?.querySelector("tr.sel");
    if (sr && !s.editing) sr.scrollIntoView({ block: "nearest" });
    else if (!s.msg && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [s.msg, s.editing, c.id]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (sets.colMenu) setUi({ colMenu: false });
      if (sets.history && !(e.target as HTMLElement | null)?.closest?.(".hist")) setUi({ history: false });
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const startDrag = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(id);
    const root = document.querySelector(".tl");
    root?.classList.add("rowdrag");
    const line = document.createElement("div");
    line.className = "dropline";
    (root || document.body).appendChild(line);
    const rows = [...(table.current?.querySelectorAll<HTMLTableRowElement>("tr.mr") || [])];
    let to: string | null = null;
    const mv = (ev: MouseEvent) => {
      let best: { r: HTMLTableRowElement | null; y: number } | null = null;
      for (const r of rows) {
        const b = r.getBoundingClientRect();
        if (ev.clientY < b.top + b.height / 2) {
          best = { r, y: b.top };
          break;
        }
      }
      if (!best) best = { r: null, y: rows[rows.length - 1].getBoundingClientRect().bottom };
      to = best.r ? best.r.dataset.id || null : null;
      const tb = table.current!.getBoundingClientRect();
      Object.assign(line.style, { top: best.y - 1 + "px", left: tb.left + "px", width: Math.min(tb.width, scroller.current?.clientWidth || tb.width) + "px" });
    };
    const up = () => {
      document.removeEventListener("mousemove", mv);
      document.removeEventListener("mouseup", up);
      line.remove();
      root?.classList.remove("rowdrag");
      setDragging(null);
      if (to !== id) {
        const i = c.msgs.findIndex((x) => x.id === id);
        const next = c.msgs[i + 1]?.id ?? null;
        if (to !== next) change(c.id, [{ op: "move", msg: id, before: to }]);
        setUi({ msg: id });
      }
    };
    document.addEventListener("mousemove", mv);
    document.addEventListener("mouseup", up);
  };

  const startResize = (e: React.MouseEvent, id: string, k: number) => resizeCol(e, table.current, k, colWidth(cols, id), (w) => saveCols({ ...cols, w: { ...cols.w, [id]: w } }));

  const td = (m: Message, col: Col, inner: React.ReactNode, title = "", cls = "") => {
    const on = m.id === s.msg && s.col === col.id;
    return (
      <td
        key={col.id}
        className={"dc" + cls + (on ? " on" : "")}
        data-m={m.id}
        data-c={col.id}
        title={title || undefined}
        tabIndex={-1}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest(".ed")) return;
          const same = s.msg === m.id && s.col === col.id;
          selectCell(c, m.id, col.id, same && !(m.tex && col.node));
        }}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest(".ed") || (m.tex && col.node)) return;
          selectCell(c, m.id, col.id, true);
        }}
      >
        {on && s.editing ? editorFor(m, col) : inner}
      </td>
    );
  };
  const editorFor = (m: Message, col: Col) => {
    if (col.id === "who") return <SpeakerPick c={c} m={m} cls="ed" autoFocus onDone={() => doneEditing(c)} />;
    if (col.id === "text")
      return (
        <div className="edwrap">
          <MsgFields key={m.id + (m.kind || "")} c={c} m={m} cls="ed edp" autoFocus onDone={() => doneEditing(c)} />
        </div>
      );
    return col.node ? <NodeEditor c={c} m={m} n={col.node} /> : null;
  };

  return (
    <div className="panel" id="middle">
      <div className="ph">
        <Title key={c.id} c={c} />
        <span className="small" style={{ color: info.color, fontWeight: 600 }}>
          {info.name}
        </span>
        <span className="muted small">
          {c.kind === "one" ? "1:1" : "group"} · ★ {starsIn(c)} unit tests
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, position: "relative" }}>
          <button className="btn sm" id="undoBtn" disabled={!s.undo} title="Undo (⌘Z)" aria-label="Undo" onClick={() => undo()}>
            ↶ Undo
          </button>
          <button className="btn sm" id="redoBtn" disabled={!s.redo} title="Redo (⇧⌘Z)" aria-label="Redo" onClick={() => undo(true)}>
            ↷
          </button>
          <button
            className="btn sm"
            id="histBtn"
            aria-expanded={s.history}
            onClick={(e) => {
              e.stopPropagation();
              setUi({ history: !s.history, colMenu: false });
            }}
          >
            History
          </button>
          {s.history ? <History c={c} /> : null}
        </span>
        <span style={{ position: "relative" }}>
          <button
            className="btn sm"
            id="colBtn"
            aria-expanded={s.colMenu}
            onClick={(e) => {
              e.stopPropagation();
              setUi({ colMenu: !s.colMenu, history: false });
            }}
          >
            Columns ▾
          </button>
          {s.colMenu ? <ColMenu /> : null}
        </span>
      </div>
      {c.set === "test" ? <div className="banner">Test chat · people only. Keep agents away from these words.</div> : null}
      <div className="scroll" id="gridScroll" ref={scroller}>
        <table className="chatgrid" ref={table} style={{ width: tw }}>
          <colgroup>
            <col style={{ width: 48 }} />
            {vc.map((x) => (
              <col key={x.id} style={{ width: colWidth(cols, x.id) }} />
            ))}
            <col style={{ width: 28 }} />
          </colgroup>
          <thead>
            <tr>
              <th className="num">#</th>
              {vc.map((x, k) => (
                <HeadCell key={x.id} col={x} onResize={(e) => startResize(e, x.id, k + 1)} />
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {c.msgs.map((m, i) => {
              const sel = m.id === s.msg;
              const nodeCols = vc.filter((x) => x.node).length;
              return (
                <tr
                  key={m.id}
                  className={"mr" + (m.tex ? " tex" : "") + (sel ? " sel" : "") + (dragging === m.id ? " dragging" : "")}
                  data-id={m.id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("td.dc,button,.ed")) return;
                    selectCell(c, m.id, s.col || "text");
                  }}
                >
                  <td className="num mono muted" data-drag={m.id} title="Drag to move this message earlier or later (or Alt+↑/↓)" onMouseDown={(e) => startDrag(e, m.id)}>
                    <span className="grip" aria-hidden="true">
                      ⠿
                    </span>
                    <span className="n">{i + 1}</span>
                  </td>
                  {vc.map((col) => {
                    if (col.id === "who") return td(m, col, m.tex ? <b className="texwho">Tex</b> : <b>{m.who}</b>);
                    if (col.id === "text") return td(m, col, <Body c={c} m={m} />, "", " txt");
                    if (m.tex) return null;
                    const x = cellOf(m, col.node!);
                    return td(m, col, <CellSym m={m} n={col.node!} />, `${col.name}: ${x.title}`, " nc");
                  })}
                  {m.tex && nodeCols ? <td colSpan={nodeCols} className="texcell" /> : null}
                  <td className="x">
                    <button className="rowx" data-ins={m.id} title="Add a row below" aria-label={`Add a row below message ${i + 1}`} onClick={(e) => (e.stopPropagation(), addRow(c, m.id))}>
                      +
                    </button>
                    <button
                      className="rowx"
                      data-del={m.id}
                      title="Delete message"
                      aria-label={`Delete message ${i + 1}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        change(c.id, [{ op: "remove", msg: m.id }]);
                        if (s.msg === m.id) setUi({ msg: null });
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr className="addrow">
              <td />
              <td colSpan={vc.length + 1}>
                <button className="btn sm ghost" id="addRow" onClick={() => addRow(c, null)}>
                  + Add row
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="legend">
        <span className="c-ok">✓ labelled</span>
        <span className="c-open">○ ran, no label</span>
        <span>– didn't run</span>
        <span className="c-must">! must run, didn't</span>
        <span>
          <span className="starc">★</span> unit test
        </span>
      </div>
    </div>
  );
}

/** The grid's keys, while the Testing tab is open and nothing is being typed. */
export function gridKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (sets.editing || !sets.msg || (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
  const c = sets.convs.find((x) => x.id === sets.chat);
  if (!c) return;
  const i = c.msgs.findIndex((x) => x.id === sets.msg);
  if (i < 0) return;
  const vc = visibleCols().map((x) => x.id);
  let k = vc.indexOf(sets.col || "text");
  if (k < 0) k = vc.indexOf("text");
  const m = c.msgs[i];
  const isNode = (id: string) => !!G().nodes.find((n) => n.id === id) && id !== "who" && id !== "text";
  const col = vc[k];
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const j = e.key === "ArrowUp" ? i - 1 : i + 1;
    if (j < 0 || j >= c.msgs.length) return;
    change(c.id, [{ op: "move", msg: m.id, before: e.key === "ArrowUp" ? c.msgs[i - 1].id : (c.msgs[i + 2]?.id ?? null) }]);
  } else if (e.key === "ArrowDown" && i < c.msgs.length - 1) selectCell(c, c.msgs[i + 1].id, col);
  else if (e.key === "ArrowUp" && i > 0) selectCell(c, c.msgs[i - 1].id, col);
  else if (e.key === "ArrowRight" && k < vc.length - 1) selectCell(c, m.id, vc[k + 1]);
  else if (e.key === "ArrowLeft" && k > 0) selectCell(c, m.id, vc[k - 1]);
  else if (e.key === "Enter") {
    if (m.tex && isNode(col)) return;
    setUi({ col, editing: true });
  } else if ((e.key === "Delete" || e.key === "Backspace") && isNode(col) && m.labels?.[col]) change(c.id, [{ op: "label", msg: m.id, node: col, value: null }]);
  else if (e.key.toLowerCase() === "t" && !e.metaKey && !e.ctrlKey) {
    if (m.tex || !isNode(col)) return;
    change(c.id, [{ op: "field", msg: m.id, node: col, field: "star", value: !m.labels?.[col]?.star }]);
  } else return;
  e.preventDefault();
}

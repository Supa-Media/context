/**
 * The parts every text grid in the Lab shares (Dev2, 2026-11-16: "if possible lets use the same component"): the
 * Testing tab's database grid, the Architecture test chat and Replay's list. Columns resize by their edge and are
 * picked, hidden and ordered in the Columns menu; each grid keeps its own choice in this browser.
 */
import { useEffect, useState } from "react";
import { COL_W, type Cols } from "../../engine/sets";

export type GridCol = { id: string; name: string };

export const colW = (cols: Cols, id: string) => cols.w[id] || (id === "who" ? COL_W.who : id === "text" ? COL_W.text : COL_W.node);

/** The columns to draw: in the viewer's order, without the hidden ones. */
export function shown<T extends GridCol>(cols: Cols, all: T[]): T[] {
  return cols.order.filter((id) => !cols.hidden.includes(id)).map((id) => all.find((c) => c.id === id)).filter((c): c is T => !!c);
}

/** A column choice laid over the columns there are now: new ones join (hidden unless `first` names them), gone ones drop. */
export function fitTo(saved: Partial<Cols> | null, ids: string[], first: string[]): Cols {
  const base: Cols = { order: ids.slice(), hidden: ids.filter((id) => !first.includes(id)), w: {} };
  if (!saved?.order) return base;
  const order = saved.order.filter((id) => ids.includes(id));
  const hidden = (saved.hidden || []).filter((id) => ids.includes(id));
  for (const id of ids)
    if (!order.includes(id)) {
      order.push(id);
      if (!first.includes(id)) hidden.push(id);
    }
  return { order, hidden: hidden.filter((id) => id !== "text"), w: saved.w || {} };
}

/** One grid's columns, kept in this browser under `key`. */
export function useGridCols(key: string, ids: string[], first: string[]): [Cols, (c: Cols) => void, () => void] {
  const sig = ids.join(",");
  const read = (): Cols => {
    let saved: Partial<Cols> | null = null;
    try {
      saved = JSON.parse(globalThis.localStorage?.getItem(key) || "null");
    } catch {
      saved = null;
    }
    return fitTo(saved, ids, first);
  };
  const [cols, setCols] = useState<Cols>(read);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setCols(read()), [key, sig]);
  const save = (c: Cols) => {
    setCols(c);
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(c));
    } catch {
      /* the columns stay for this visit */
    }
  };
  return [cols, save, () => save({ order: ids.slice(), hidden: ids.filter((id) => !first.includes(id)), w: {} })];
}

/** Drag a header's edge to resize its column; the table widens with it and the width is kept on release. */
export function startResize(e: React.MouseEvent, table: HTMLTableElement | null, k: number, w0: number, keep: (w: number) => void) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const cg = table?.querySelectorAll("colgroup col")[k] as HTMLElement | undefined;
  const fixed = !!table?.style.width && !table.style.width.endsWith("%");
  const t0 = table?.offsetWidth || parseFloat(table?.style.width || "0") || 0;
  let w = w0;
  const mv = (ev: MouseEvent) => {
    w = Math.max(44, w0 + ev.clientX - x0);
    if (cg) cg.style.width = w + "px";
    if (table && fixed) table.style.width = t0 + (w - w0) + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", mv);
    document.removeEventListener("mouseup", up);
    keep(w);
  };
  document.addEventListener("mousemove", mv);
  document.addEventListener("mouseup", up);
}

/** The Columns menu: show or hide each column and move it left or right; Message always shows. */
export function ColMenu({ cols, all, save, reset, id, resetId }: { cols: Cols; all: GridCol[]; save: (c: Cols) => void; reset: () => void; id?: string; resetId?: string }) {
  const list = cols.order.map((x) => all.find((c) => c.id === x)).filter((c): c is GridCol => !!c);
  const mv = (k: number, d: number) => {
    const o = cols.order.slice();
    const a = o.indexOf(list[k].id);
    const b = o.indexOf(list[k + d].id);
    [o[a], o[b]] = [o[b], o[a]];
    save({ ...cols, order: o });
  };
  return (
    <div className="colmenu" id={id} onClick={(e) => e.stopPropagation()}>
      <div className="cap">Columns</div>
      {list.map((c, k) => (
        <div className="cm" key={c.id}>
          <label>
            <input type="checkbox" data-show={c.id} checked={!cols.hidden.includes(c.id)} disabled={c.id === "text"} onChange={(e) => save({ ...cols, hidden: e.target.checked ? cols.hidden.filter((x) => x !== c.id) : [...cols.hidden, c.id] })} /> {c.name}
          </label>
          <button className="btn sm ghost" data-up={k} aria-label={`Move ${c.name} left`} disabled={!k} onClick={() => mv(k, -1)}>
            ↑
          </button>
          <button className="btn sm ghost" data-dn={k} aria-label={`Move ${c.name} right`} disabled={k >= list.length - 1} onClick={() => mv(k, 1)}>
            ↓
          </button>
        </div>
      ))}
      <button className="btn sm" id={resetId} data-reset-cols onClick={reset}>
        Reset columns and widths
      </button>
    </div>
  );
}

/** The Columns button with its menu, closed by any click elsewhere. */
export function ColButton(p: { cols: Cols; all: GridCol[]; save: (c: Cols) => void; reset: () => void; open?: boolean; setOpen?: (v: boolean) => void; id?: string }) {
  const [own, setOwn] = useState(false);
  const open = p.open ?? own;
  const setOpen = p.setOpen ?? setOwn;
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open, setOpen]);
  return (
    <span style={{ marginLeft: "auto", position: "relative" }}>
      <button
        className="btn sm"
        id={p.id}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        Columns ▾
      </button>
      {open ? <ColMenu cols={p.cols} all={p.all} save={p.save} reset={p.reset} id={p.id ? p.id.replace(/Btn$/, "Menu") : undefined} /> : null}
    </span>
  );
}

/** A header cell with its resize edge. */
export function HeadCell({ col, onResize }: { col: GridCol; onResize: (e: React.MouseEvent) => void }) {
  return (
    <th data-col={col.id}>
      <span className="hname" title={col.name}>
        {col.name}
      </span>
      <span className="rs" data-rs={col.id} title="Drag to resize" onMouseDown={onResize} />
    </th>
  );
}

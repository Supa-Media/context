/**
 * Explore, at the foot of tex.lc/admin: slice every scored conversation in the
 * window by anything it carries (the owner, 2026-10-24: "slice by different
 * metrics and see what tasks people get frustrated with").
 *
 * One compact row: what to show, rows and columns as plain dropdowns, then one
 * dropdown per filter that opens a short checklist (the owner: "drop downs not
 * never ending bubbles"). The table sorts worst first and shades each cell by
 * how bad it is against the others; a cell under three conversations is faint.
 * Tapping a row's name filters to it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DIMENSIONS,
  MEASURES,
  applyFilters,
  filterButtonLabel,
  formatMeasure,
  heatOf,
  optionsOf,
  pivot,
  toggleFilter,
  type Dimension,
  type Measure,
  type TexFilters,
  type TexReview,
} from "./model";

/** A cell resting on fewer conversations than this is drawn faint. */
const THIN = 3;

export function DashboardExplore({ reviews, filters, onFilters }: { reviews: readonly TexReview[]; filters: TexFilters; onFilters: (next: TexFilters) => void }) {
  const [measure, setMeasure] = useState<Measure>("frustrated");
  const [rowDim, setRowDim] = useState<Dimension>("task");
  const [colDim, setColDim] = useState<Dimension | "">("chat");
  const kept = useMemo(() => applyFilters(reviews, filters), [reviews, filters]);
  const cols = colDim === "" || colDim === rowDim ? null : colDim;
  const table = useMemo(() => pivot(kept, rowDim, cols, measure), [kept, rowDim, cols, measure]);
  const filtering = Object.values(filters).some((values) => values.length > 0);
  const compared = table.cells.flat().filter((cell) => cell.n >= THIN).map((cell) => cell.value);
  const rowLabel = DIMENSIONS.find((d) => d.key === rowDim)?.label ?? rowDim;

  return (
    <section className="td-card" id="explore" data-testid="tex-dashboard-explore">
      <div className="td-card-head">
        <h2 className="td-h2">Explore</h2>
        <span className="td-meta" data-testid="tex-dashboard-explore-count">
          {kept.length} of {reviews.length} conversations
        </span>
      </div>
      <div className="td-filters">
        <Plain label="Show" value={measure} options={MEASURES.map((m) => ({ value: m.key, label: m.label }))} onChange={(v) => setMeasure(v as Measure)} testID="tex-dashboard-measure" />
        <Plain label="Rows" value={rowDim} options={DIMENSIONS.map((d) => ({ value: d.key, label: d.label }))} onChange={(v) => setRowDim(v as Dimension)} testID="tex-dashboard-rows" />
        <Plain
          label="Columns"
          value={colDim}
          options={[{ value: "", label: "Nothing" }, ...DIMENSIONS.filter((d) => d.key !== rowDim).map((d) => ({ value: d.key, label: d.label }))]}
          onChange={(v) => setColDim(v as Dimension | "")}
          testID="tex-dashboard-cols"
        />
      </div>
      <div className="td-filters" data-testid="tex-dashboard-filters">
        {DIMENSIONS.map((dimension) => (
          <Multi
            key={dimension.key}
            label={filterButtonLabel(dimension.key, filters[dimension.key] ?? [])}
            options={optionsOf(reviews, dimension.key)}
            picked={filters[dimension.key] ?? []}
            onToggle={(value) => onFilters(value === null ? { ...filters, [dimension.key]: [] } : toggleFilter(filters, dimension.key, value))}
            testID={`tex-dashboard-filter-${dimension.key}`}
          />
        ))}
        {filtering ? (
          <button type="button" className="td-clear" onClick={() => onFilters({})} data-testid="tex-dashboard-clear">
            Clear filters
          </button>
        ) : null}
      </div>
      {kept.length === 0 ? (
        <p className="td-empty">No conversations match. Loosen a filter, or pick a longer window.</p>
      ) : (
        <div className="td-table-wrap">
          <table className="td-table" data-testid="tex-dashboard-table">
            <thead>
              <tr>
                <th className="row">{rowLabel}</th>
                {table.cols.map((col) => (
                  <th key={col.value}>{col.label}</th>
                ))}
                {table.cols.length > 1 ? <th>All</th> : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={row.value}>
                  <td className="name">
                    <button type="button" onClick={() => onFilters({ ...filters, [rowDim]: [row.value] })} title={`Only ${row.label}`}>
                      {row.label}
                    </button>
                  </td>
                  {[...table.cells[r], ...(table.cols.length > 1 ? [table.totals[r]] : [])].map((cell, c) => {
                    const heat = cell.n >= THIN ? heatOf(measure, cell.value, compared) : null;
                    return (
                      <td key={c} className={cell.n > 0 && cell.n < THIN ? "thin" : undefined} style={heat === null ? undefined : { background: `rgba(154, 43, 31, ${(0.04 + heat * 0.22).toFixed(2)})` }}>
                        {cell.n === 0 ? null : (
                          <>
                            <span className="v num">{formatMeasure(measure, cell.value)}</span>
                            {measure === "count" ? null : <span className="n num">{cell.n}</span>}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Plain({ label, value, options, onChange, testID }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; testID: string }) {
  return (
    <span className="td-select">
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} data-testid={testID}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {label}: {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A dropdown that opens a short checklist; it stays open while ticking and closes on a click outside. */
function Multi({ label, options, picked, onToggle, testID }: { label: string; options: { value: string; label: string; count: number }[]; picked: readonly string[]; onToggle: (value: string | null) => void; testID: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span className="td-select" ref={box}>
      <button type="button" className={picked.length > 0 ? "on" : undefined} aria-expanded={open} onClick={() => setOpen((was) => !was)} data-testid={testID}>
        {label}
      </button>
      {open ? (
        <div className="td-pop" role="group" aria-label={label}>
          <label className="all">
            <input type="checkbox" checked={picked.length === 0} onChange={() => onToggle(null)} />
            All
          </label>
          {options.map((option) => (
            <label key={option.value}>
              <input type="checkbox" checked={picked.includes(option.value)} onChange={() => onToggle(option.value)} data-testid={`${testID}-${option.value}`} />
              {option.label}
              <span className="count num">{option.count}</span>
            </label>
          ))}
        </div>
      ) : null}
    </span>
  );
}

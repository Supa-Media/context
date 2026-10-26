/**
 * "Where it hurts" on tex.lc/admin: the problems the triage agent named,
 * unfixed first, then by how many scored chats hit them in two weeks, each
 * with what is being done about it and, once a fix shipped, how often it
 * happened before and since (`./insights`). The reports filed under each
 * open in the reading pane, never on the row.
 */

import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { Card } from "./DashboardPanels.web";
import { MIN_SINCE_N, PAIN_DAYS, shortDate, taskLabel, type PainRow } from "./insights";
import { SIGNAL_LABELS } from "./model";

const STATUS_TEXT: Record<PainRow["status"], string> = { none: "No fix yet", working: "Being fixed", shipped: "Shipped" };
const VERDICT_TEXT = { too_early: "too early", working: "working", still: "still happening" } as const;

export function PainPanel({
  rows,
  untriaged,
  onOpen,
  onSignal,
  onSend,
}: {
  rows: readonly PainRow[];
  untriaged: readonly { code: string; label: string; n: number }[];
  onOpen: (path: string) => void;
  onSignal: (code: string) => void;
  onSend: (path: string) => void;
}) {
  return (
    <Card title="Where it hurts" meta={`Problems triage named, unfixed first, then by chats hit in ${PAIN_DAYS} days`} testID="tex-dashboard-pain">
      {rows.length === 0 ? (
        <p className="td-empty">
          The triage agent has not named any problems yet. It keeps one note per problem in the reviews folder's themes, and they show here as it does.
        </p>
      ) : (
        <div className="td-table-wrap">
          <table className="td-pain">
            <thead>
              <tr>
                <th>Problem</th>
                <th>Chats hit</th>
                <th>Last {PAIN_DAYS} days</th>
                <th>Fix</th>
                <th>Before → since</th>
                <th aria-label="Next step" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PainLine key={row.key} row={row} onOpen={onOpen} onSend={onSend} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {untriaged.length > 0 ? (
        <p className="td-meta" data-testid="tex-dashboard-untriaged">
          Signals no problem covers yet:{" "}
          {untriaged.map((signal, index) => (
            <span key={signal.code}>
              {index > 0 ? ", " : ""}
              <button type="button" className="td-link" onClick={() => onSignal(signal.code)}>
                {signal.label} ×{signal.n}
              </button>
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  );
}

function PainLine({ row, onOpen, onSend }: { row: PainRow; onOpen: (path: string) => void; onSend: (path: string) => void }) {
  const meta = [row.theme.tasks.map(taskLabel).join(", "), row.theme.signals.map((code) => SIGNAL_LABELS[code] ?? code).join(", ")].filter((part) => part !== "").join(" · ");
  return (
    <tr data-testid={`tex-dashboard-pain-${row.key}`}>
      <td>
        <div className="td-pain-name">
          {row.name}
          {row.isNew ? <span className="td-chip new">New</span> : null}
        </div>
        {meta !== "" ? <div className="td-pain-meta">{meta}</div> : null}
      </td>
      <td className="num">
        {row.hits}
        {row.lastSeen !== null ? <div className="td-pain-meta">last {shortDate(row.lastSeen)}</div> : null}
      </td>
      <td>
        <Strip row={row} />
      </td>
      <td>
        <span className={`td-chip ${row.status}`}>{row.status === "shipped" && row.theme.merged !== null ? `Shipped ${shortDate(row.theme.merged)}` : STATUS_TEXT[row.status]}</span>
        {row.status === "shipped" ? <div className="td-pain-meta">{row.theme.retest !== null ? `Retested: ${row.theme.retest}` : "Not retested yet"}</div> : null}
        {row.theme.prs.length > 0 ? <div className="td-pain-meta">{row.theme.prs.map((pr) => `#${pr}`).join(" ")}</div> : null}
        {row.status === "working" && row.theme.fixThread !== null ? <div className="td-pain-meta">{row.theme.fixThread}</div> : null}
      </td>
      <td className="num">
        {row.before !== null && row.since !== null && row.verdict !== null ? (
          <>
            {row.before.hits} of {row.before.n} → {row.since.hits} of {row.since.n}
            <div className={`td-pain-meta ${row.verdict}`}>
              {VERDICT_TEXT[row.verdict]}
              {row.verdict === "too_early" ? `, needs ${MIN_SINCE_N} since` : ""}
            </div>
          </>
        ) : (
          <span className="td-pain-meta">—</span>
        )}
      </td>
      <td className="td-pain-act">
        {row.status === "none" ? (
          <button type="button" className="td-btn" onClick={() => onSend(row.theme.path)}>
            Send to triage
          </button>
        ) : null}
        {row.reports.length > 0 ? (
          <button type="button" className="td-link" onClick={() => onOpen(row.reports[0]!.path)}>
            {row.reports.length} {row.reports.length === 1 ? "report" : "reports"}
          </button>
        ) : (
          <button type="button" className="td-link" onClick={() => onOpen(row.theme.path)}>
            Open
          </button>
        )}
      </td>
    </tr>
  );
}

/** Hits a day for two weeks: a dot per day, sized by hits, a ring where there were none, and a rule where the fix shipped. */
function Strip({ row }: { row: PainRow }) {
  const width = PAIN_DAYS * 10;
  const shippedAt =
    row.theme.merged === null ? null : PAIN_DAYS - 1 - Math.floor((Date.now() - row.theme.merged) / 86_400_000);
  return (
    <svg viewBox={`0 0 ${width} 16`} width={width} height={16} role="img" aria-label={`${row.hits} chats in ${PAIN_DAYS} days`}>
      {row.strip.map((n, index) => (
        <circle
          key={index}
          cx={5 + index * 10}
          cy={8}
          r={n === 0 ? 2 : Math.min(6, 2.5 + n * 1.2)}
          fill={n === 0 ? "none" : shippedAt !== null && index >= shippedAt ? C.blue : C.bad}
          stroke={n === 0 ? C.hair : "none"}
        />
      ))}
      {shippedAt !== null && shippedAt >= 0 && shippedAt < PAIN_DAYS ? <rect x={shippedAt * 10} y={0} width={1.5} height={16} fill={C.ink} /> : null}
    </svg>
  );
}

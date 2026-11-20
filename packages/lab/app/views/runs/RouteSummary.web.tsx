/**
 * The "By route" block of a run's detail (Dev2, 2026-11-18): per-route pass rate and cost per turn, router accuracy with
 * its confusion table, the specialist doors' fallback rate and the cost per turn. Shown only when the run has a route
 * to read (`runRouteSummary`'s `any`). The arithmetic and the words are `engine/routeSummary.ts` and the shared
 * `texRouteSummary.cjs`; the same summary is tex_dev's `byRoute`.
 */
import { useMemo } from "react";
import { sets } from "../../engine/setsStore";
import { PICKS, ROUTES, perTurnWords, routerWords, runRouteSummary, specialistWords, usdWords, type RouteSummary } from "../../engine/routeSummary";
import type { RunRow } from "../../engine/labRuns";

export function RouteSummaryBlock({ rows }: { rows: RunRow[] }) {
  const summary: RouteSummary = useMemo(() => runRouteSummary(rows, sets.convs), [rows, sets.convs]);
  if (!summary.any) return null;
  const perRoute = summary.perRoute.filter((b) => b.route !== "untagged" || b.total > 0);
  return (
    <div id="byRoute">
      <div className="cap">By route</div>
      <div className="tbl">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th>Right</th>
              <th>Turns</th>
              <th>$/turn</th>
            </tr>
          </thead>
          <tbody>
            {perRoute.map((b) => (
              <tr key={b.route} data-route={b.route}>
                <td>{b.route}</td>
                <td>{b.total > 0 ? `${b.pass}/${b.total}` : "—"}</td>
                <td>{b.total}</td>
                <td>{b.total > 0 ? usdWords(b.usdPerTurn) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small">
        <b id="routerWords">{routerWords(summary.router)}</b>
      </div>
      <div className="tbl">
        <table id="routerConfusion">
          <thead>
            <tr>
              <th>Gold \ picked</th>
              {PICKS.map((p) => (
                <th key={p}>{p}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROUTES.map((g) => (
              <tr key={g} data-gold={g}>
                <td>{g}</td>
                {PICKS.map((p) => (
                  <td key={p} style={g === p ? { fontWeight: 600 } : undefined}>
                    {summary.router.confusion[g][p]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small" id="specialistWords">
        {specialistWords(summary.fallback)}
      </div>
      <div className="small" id="perTurnWords">
        {perTurnWords(summary.costPerTurn)}
      </div>
    </div>
  );
}

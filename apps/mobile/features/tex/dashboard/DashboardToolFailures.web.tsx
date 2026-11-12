/**
 * "Why tools fail" on tex.lc/admin (Dev2, 2026-11-10: "whenever there is a
 * tool call failure, I want it logged and visible for us to understand why").
 * Every failed tool call of every Tex model that holds tools, kept with nobody
 * on it (`texToolFailures`): failures a day across the window, and each
 * reason, most first, with the tool, the cause, how often, when last and where
 * it ran. A reason is the sentence our code wrote with its values taken out
 * (`<path>`, `<q>`, `<n>`), so the same failure groups across every chat.
 */

import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { AreaChart, Axis, Card } from "./DashboardPanels.web";
import { KIND_LABELS, type TexReport } from "./model";

/** What each cause code means, in a few words. */
export const CAUSE_LABELS: Record<string, string> = {
  refused: "said no",
  threw: "crashed",
  timed_out: "too slow",
  out_of_time: "turn out of time",
  not_offered: "not given that tool",
  no_such_action: "no such action",
  repeated: "asked twice",
};

const WHERE: Record<string, string> = { ...KIND_LABELS, check_in: "Check-in" };

function ago(at: number, now: number): string {
  const hours = Math.max(0, Math.round((now - at) / 3_600_000));
  if (hours < 1) return "this hour";
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ToolFailuresPanel({ report }: { report: TexReport }) {
  const failures = report.toolFailures;
  const now = Date.now();
  const days = failures.byDay.map((day) => day.day);
  return (
    <Card title="Why tools fail" meta={`${failures.total.toLocaleString("en-US")} failed calls in ${report.days} days · each reason with its values taken out`} testID="tex-dashboard-tool-failures" wide>
      {failures.total === 0 ? (
        <p className="td-empty">No tool call failed in this window.</p>
      ) : (
        <>
          <AreaChart values={failures.byDay.map((day) => day.failures)} color={C.bad} fill={C.badWash} label="Failed tool calls a day" />
          <Axis days={days} />
          {failures.truncated ? <p className="td-pain-meta">More failed than the page reads at once: the newest are counted.</p> : null}
          <div className="td-table-wrap">
            <table className="td-table td-failures" data-testid="tex-dashboard-tool-failure-reasons">
              <thead>
                <tr>
                  <th className="row">Tool</th>
                  <th className="row">Cause</th>
                  <th className="row">Why</th>
                  <th>Times</th>
                  <th>Last</th>
                  <th className="row">Where</th>
                </tr>
              </thead>
              <tbody>
                {failures.reasons.map((reason) => (
                  <tr key={`${reason.tool}|${reason.cause}|${reason.why}`}>
                    <td className="row">{reason.tool}</td>
                    <td className="row">{CAUSE_LABELS[reason.cause] ?? reason.cause}</td>
                    <td className="row why">{reason.why}</td>
                    <td className="num">{reason.count.toLocaleString("en-US")}</td>
                    <td>{ago(reason.last, now)}</td>
                    <td className="row">{reason.kinds.map((kind) => WHERE[kind] ?? kind).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

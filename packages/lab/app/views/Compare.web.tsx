/**
 * The Lab's Compare view: a port of the artifact's `renderCompare`. One row per
 * version: its name (opens it on the canvas), who made it, the reply time and
 * cost for the picked test, then each area's latest pasted run.
 */
import { AREAS } from "../data/areas";
import { fmtS, fmtUsd, simulate } from "../engine/sim";
import { scnLabel } from "../engine/traces";
import { go, lab, openVersion } from "../engine/state";
import { compareRuns, devScoreWords, fidelityWords, modelsWords, pairedWords, runStats, statsWords, type ComparedRuns, type LabRun } from "../engine/labRuns";
import { useLab } from "../store";
import { PageHead } from "./parts";
import { latest } from "./run/runText";
import { useRuns } from "./runs/Runs.web";

/** A version's latest finished Dev set run, the one its Dev set column shows (Dev2, 2026-11-19). */
const devRunOf = (runs: LabRun[], versionId: string) => runs.find((r) => r.versionId === versionId && r.kind === "dev" && r.stage === "done" && r.results);

/**
 * A draft's Dev set run against main's latest on the same models (Dev2, 2026-11-19): the paired rule (`compareRuns`), so
 * "wins" only when the 95% interval of the draft's per-row difference from main excludes 0; the min..max band decides
 * only when a run has no rows. A draft with no run says so; a base on other models is no base, since they aren't comparable.
 */
function verdictOf(runs: LabRun[], draft: LabRun | undefined, models: "gw" | "cc"): { verdict: string; why: string; paired?: ComparedRuns["paired"] } {
  if (!draft) return { verdict: "no run", why: "this version has no finished Dev set run" };
  const base = devRunOf(
    runs.filter((r) => r.models === models),
    "main",
  );
  if (!base) return { verdict: "no base", why: `main has no finished Dev set run on ${modelsWords({ kind: "dev", models })} to compare with` };
  return compareRuns(draft.results, base.results);
}

export function Compare() {
  useLab();
  const runs = useRuns();
  const names = lab.names || {};
  const ac = Object.keys(AREAS);
  return (
    <>
      <PageHead
        icon={
          <svg className="i" viewBox="0 0 24 24">
            <path d="M5 20V10M12 20V4M19 20v-7" />
          </svg>
        }
        title="Compare versions"
      >
        {"Speed and cost are guesses from each version's steps, for the test picked on the canvas. Area columns are each version's latest pasted run. Dev set run is each version's latest run on GitHub: the mean of its repeats, with pass^k (the chance every repeat of a row passes) and a Wilson interval on the pass rate. vs main is paired on the rows both runs scored, clustered by conversation: a draft wins only when the 95% interval of its difference from main excludes 0, and the line under it names the smallest change this comparison could detect at 80% power. With no rows to pair, the min–max band decides. A run on Claude Code is model family only, so measure an effort, temperature or token-cap change with an AI gateway run."}
      </PageHead>
      <div className="tbl">
        <table>
          <tbody>
            <tr>
              <th>Version</th>
              <th>By</th>
              <th>{`Reply · ${scnLabel(lab.scn).slice(0, 40)}`}</th>
              <th>Cost</th>
              <th>Dev set run</th>
              <th>vs main</th>
              {ac.map((a) => (
                <th key={a}>{AREAS[a]}</th>
              ))}
            </tr>
            {lab.versions.map((v) => {
              const L = latest(v);
              const sim = simulate(v.graph, lab.scn, null);
              const run = devRunOf(runs, v.id);
              const verdict = v.id === "main" ? null : verdictOf(runs, run, run?.models ?? "gw");
              const stats = run ? statsWords(runStats(run.results)) : "";
              const paired = verdict?.paired ? pairedWords(verdict.paired) : "";
              return (
                <tr key={v.id}>
                  <td>
                    <button
                      className="rowi"
                      style={{ padding: 0, fontWeight: 600, color: "var(--accent)" }}
                      data-cv={v.id}
                      onClick={() => {
                        openVersion(v.id);
                        go("canvas");
                      }}
                    >
                      {v.name}
                    </button>
                  </td>
                  <td>
                    {v.authorId ? (
                      names[v.authorId] || "Someone"
                    ) : (
                      <span className="hint">live</span>
                    )}
                  </td>
                  <td>{fmtS(sim.reply)}</td>
                  <td>{fmtUsd(sim.usd)}</td>
                  <td>
                    {run ? (
                      <>
                        {devScoreWords(run)}
                        <br />
                        <span className="hint">
                          {modelsWords(run)}
                          {fidelityWords(run) ? ` · ${fidelityWords(run)}` : ""}
                        </span>
                        {stats ? (
                          <>
                            <br />
                            <span className="hint" data-stats>
                              {stats}
                            </span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <span className="hint">·</span>
                    )}
                  </td>
                  <td>
                    {verdict === null ? (
                      <span className="hint">base</span>
                    ) : (
                      <span
                        data-verdict={verdict.verdict}
                        title={verdict.why}
                        className={verdict.verdict === "loses" ? "c-bad" : verdict.verdict === "no run" || verdict.verdict === "no base" ? "hint" : undefined}
                        style={verdict.verdict === "wins" ? { color: "var(--ok)", fontWeight: 600 } : undefined}
                      >
                        {verdict.verdict}
                      </span>
                    )}
                    {paired ? (
                      <>
                        <br />
                        <span className="hint" data-paired>
                          {paired}
                        </span>
                      </>
                    ) : null}
                  </td>
                  {ac.map((a) => (
                    <td key={a}>
                      {L[a] ? (
                        <>
                          {L[a].practice[0]}/{L[a].practice[1]}
                          <br />
                          <span className="hint">
                            held {L[a].held[0]}/{L[a].held[1]}
                          </span>
                        </>
                      ) : (
                        <span className="hint">·</span>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

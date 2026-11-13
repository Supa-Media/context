/**
 * The Lab's Compare view: a port of the artifact's `renderCompare`. One row per
 * version: its name (opens it on the canvas), who made it, the reply time and
 * cost for the picked test, then each area's latest pasted run.
 */
import type { LabVersion } from "../types";
import { AREAS } from "../data/areas";
import { fmtS, fmtUsd, simulate } from "../engine/sim";
import { scnLabel } from "../engine/traces";
import { go, lab, openVersion } from "../engine/state";
import { useLab } from "../store";
import { PageHead } from "./parts";

type AreaRun = { practice: [number, number]; held: [number, number] };

/** Each area's latest run on a version: the last result that names it (`latest`). */
function latest(v: LabVersion): Record<string, AreaRun> {
  const o: Record<string, AreaRun> = {};
  for (const r of v.results || []) for (const [a, x] of Object.entries(r.areas)) o[a] = x as AreaRun;
  return o;
}

export function Compare() {
  useLab();
  const names = (lab as unknown as { names?: Record<string, string> }).names || {};
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
        {"Speed and cost are guesses from each version's steps, for the test picked on the canvas. Area columns are each version's latest pasted run."}
      </PageHead>
      <div className="tbl">
        <table>
          <tbody>
            <tr>
              <th>Version</th>
              <th>By</th>
              <th>{`Reply · ${scnLabel(lab.scn).slice(0, 40)}`}</th>
              <th>Cost</th>
              {ac.map((a) => (
                <th key={a}>{AREAS[a]}</th>
              ))}
            </tr>
            {lab.versions.map((v) => {
              const L = latest(v);
              const sim = simulate(v.graph, lab.scn, null);
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
                      names[v.authorId] || (v.authorId === lab.myId ? "You" : "Someone")
                    ) : (
                      <span className="hint">live</span>
                    )}
                  </td>
                  <td>{fmtS(sim.reply)}</td>
                  <td>{fmtUsd(sim.usd)}</td>
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

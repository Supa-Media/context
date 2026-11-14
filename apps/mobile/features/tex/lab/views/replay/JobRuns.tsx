/**
 * A background job's runs in Replay's right panel (`engine/jobRuns.ts`): each run's time, the job check's verdict and
 * advice, what it thought, every tool call with what it was given and what came back, and what it said. Opened from a
 * moment whose turn ran or reported a job, so a text Tex sent from a job shows everything that led up to it.
 */
import { useEffect } from "react";

import { jobWork, stateWords, type JobRun } from "../../engine/jobRuns";
import { fmtS } from "../../engine/sim";
import type { LedgerEntry } from "../../../page/texPageTypes";
import { readJobWork } from "../mine/useMine";

const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1) ?? "");

function Run({ r, n }: { r: JobRun; n: number }) {
  const what = r.report !== null ? "Report" : `Run ${n}`;
  return (
    <details className="iofold jrun" data-turn={r.turn}>
      <summary>
        {what} · {time(r.start)} · {fmtS(r.end - r.start)} · {r.tools.length} {r.tools.length === 1 ? "tool call" : "tool calls"} · {stateWords(r.state)}
      </summary>
      {r.advice ? (
        <div className="io">
          <b>Job check said</b>
          <pre>{r.advice}</pre>
        </div>
      ) : null}
      {r.tools.map((t, i) => (
        <details key={i} className="iofold jtool">
          <summary>
            {time(t.at)} · {t.name}
            {t.ms !== null ? " · " + fmtS(t.ms) : ""}
            {t.ok ? "" : " · failed"}
          </summary>
          <div className="io">
            <b>Got</b>
            <pre>{shown(t.args)}</pre>
          </div>
          <div className="io">
            <b>Gave</b>
            <pre>{shown(t.result)}</pre>
          </div>
        </details>
      ))}
      {r.thinking.map((t, i) => (
        <div key={"t" + i} className="io">
          <b>Thought{t.ms !== null ? " · " + fmtS(t.ms) : ""}</b>
          <pre>{t.text}</pre>
        </div>
      ))}
      {r.steps.map((s, i) => (
        <div key={"s" + i} className="io">
          <b>{String(s.step ?? s.kind)}{typeof s.ms === "number" ? " · " + fmtS(s.ms) : ""}</b>
          <pre>{shown({ input: s.input, output: s.output ?? s.text ?? s.notice })}</pre>
        </div>
      ))}
      {r.said || r.report ? (
        <div className="io">
          <b>{r.report !== null ? "Reported" : "Said"}{r.model ? " · " + r.model.replace(/^anthropic\//, "") : ""}</b>
          <pre>{r.report ?? r.said}</pre>
        </div>
      ) : null}
    </details>
  );
}

export function JobRuns({ id, entries }: { id: string; entries: LedgerEntry[] }) {
  useEffect(() => {
    void readJobWork(id);
  }, [id]);
  const w = jobWork(entries, id);
  let n = 0;
  return (
    <div className="grp" id="rJob" data-job={id}>
      <h4>Background job · {w.title}</h4>
      <p className="hint">
        {w.runs.length} {w.runs.length === 1 ? "run" : "runs"}
        {w.runs.length ? ` from ${time(w.runs[0].start)} to ${time(w.runs[w.runs.length - 1].end)}` : ", reading its work…"}
      </p>
      {w.runs.map((r) => (
        <Run key={r.turn} r={r} n={r.report !== null ? n : ++n} />
      ))}
    </div>
  );
}

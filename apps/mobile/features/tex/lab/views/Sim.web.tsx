/**
 * The Lab's Speed and cost view, ported from the artifact's `renderSim` and `readLog` (template.html
 * 1145-1176): the test and the version compared with, the KPI cards, the waterfall of where the time
 * goes, and the "Measured from a run" paste that swaps guesses for measured times.
 */
import { useRef, useState, type ReactNode } from "react";
import { simulate, fmtS, fmtUsd } from "../engine/sim";
import { G, MAIN, MODELS, node, set, toast } from "../engine/state";
import { useLab } from "../store";
import { Ic } from "./ic";
import { PageHead, ScnOptions } from "./parts";
import { readLog } from "./simLog";

const LANE_ORDER: Record<string, number> = { reply: 0, job: 1, behind: 2 };
const LANE_NAME: Record<string, string> = { reply: "Before the reply", job: "Background job", behind: "After the reply" };

export function Sim() {
  const s = useLab();
  const [baseId, setBaseId] = useState("main");
  const logRef = useRef<HTMLTextAreaElement>(null);

  const base = s.versions.find((v) => v.id === baseId) || MAIN;
  const a = simulate(G(), s.scn, s.logRows);
  const b = simulate(base.graph, s.scn, null);

  const delta = (x: number, y: number, f: (n: number) => string): ReactNode => {
    const d = x - y;
    if (Math.abs(d) < 1e-9) return <span style={{ color: "var(--dim)" }}>same as {base.name}</span>;
    return (
      <span style={{ color: `var(--${d < 0 ? "ok" : "bad"})` }}>
        {d > 0 ? "+" : "−"}
        {f(Math.abs(d))} vs {base.name}
      </span>
    );
  };

  const rows = Object.entries(a.T)
    .filter(([, t]) => t.ms > 0 || t.lane !== "reply")
    .sort((x, y) => (LANE_ORDER[x[1].lane] - LANE_ORDER[y[1].lane]) || x[1].start - y[1].start);
  const max = Math.max(1, ...rows.map(([, t]) => t.end));

  const wf: ReactNode[] = [];
  let lane: string | null = null;
  for (const [id, t] of rows) {
    if (t.lane !== lane) {
      lane = t.lane;
      wf.push(<div key={"lane-" + id} className="lane">{LANE_NAME[lane]}</div>);
    }
    const n = node(id)!;
    const m = MODELS[n.model] || MODELS.code;
    wf.push(
      <div key={id} className="r">
        <span className="flex" style={{ gap: 6, flexWrap: "nowrap", minWidth: 0 }}>
          <span style={{ color: `var(${m.c})`, display: "inline-grid" }}>
            <Ic k={n.icon} />
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
        </span>
        <div className="tr">
          <div className="bb" style={{ left: `${(t.start / max) * 100}%`, width: `${Math.max(0.6, (t.ms / max) * 100)}%`, background: `var(${m.c})` }} />
        </div>
        <span className="t">{fmtS(t.ms)}</span>
      </div>,
    );
  }
  wf.push(
    <div key="reply-sent" className="r" style={{ marginTop: 8 }}>
      <b>Reply sent</b>
      <div className="tr" style={{ background: "none" }}>
        <div className="bb" style={{ left: `${(a.reply / max) * 100}%`, width: "2px", background: "var(--text)" }} />
      </div>
      <span className="t">
        <b>{fmtS(a.reply)}</b>
      </span>
    </div>,
  );

  // The artifact rebuilds this page on each of these actions, which empties the paste box; the textarea is
  // uncontrolled here, so it is emptied by hand.
  const emptyLog = () => {
    if (logRef.current) logRef.current.value = "";
  };

  const useLog = () => {
    const r = readLog(logRef.current?.value ?? "", G(), MODELS);
    emptyLog();
    set({ logRows: r.rows });
    toast(r.rows ? `Measured ${Object.keys(r.rows).length} steps${r.bad ? `, skipped ${r.bad} lines` : ""}` : "No lines matched this version's steps");
  };

  return (
    <>
      <PageHead icon={<svg className="i" viewBox="0 0 24 24"><circle cx="12" cy="13" r="7"/><path d="M12 13l3-3M10 3h4"/></svg>} title="Speed and cost">
        A guess for <b>{s.cur.name}</b> from each step's model, effort, rounds and what it reads. Paste a run's step log below to swap guesses for measured times.
      </PageHead>
      <div className="flex" style={{ marginBottom: 14 }}>
        <span className="hint">Test</span>
        <select id="simScn" className="search" style={{ maxWidth: 420 }} value={s.scn} onChange={(e) => {
            emptyLog();
            set({ scn: e.target.value });
          }}>
          <ScnOptions />
        </select>
        <span className="hint">Compared with</span>
        <select id="cmpBase" className="search" style={{ maxWidth: 220 }} value={base.id} onChange={(e) => {
            emptyLog();
            setBaseId(e.target.value);
          }}>
          {s.versions.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
      </div>
      <div className="cards">
        <div className="kpi">
          <div className="l">Until the reply</div>
          <div className="v">{fmtS(a.reply)}</div>
          <div className="d">{delta(a.reply, b.reply, fmtS)}</div>
        </div>
        <div className="kpi">
          <div className="l">Model calls before it</div>
          <div className="v">{a.replyCalls.toFixed(1)}</div>
          <div className="d">{delta(a.replyCalls, b.replyCalls, (x) => x.toFixed(1))}</div>
        </div>
        <div className="kpi">
          <div className="l">This test costs</div>
          <div className="v">{fmtUsd(a.usd)}</div>
          <div className="d">{delta(a.usd, b.usd, fmtUsd)}</div>
        </div>
        {a.jobEnd ? (
          <div className="kpi">
            <div className="l">Job done after</div>
            <div className="v">{fmtS(a.jobEnd)}</div>
            <div className="d">{delta(a.jobEnd, b.jobEnd, fmtS)}</div>
          </div>
        ) : null}
      </div>
      <div className="blk">
        <h2>Where the time goes</h2>
        <div className="wf">{wf}</div>
        <p className="hint" style={{ marginTop: 12 }}>
          Live on 13 Nov: 1:1 median 14.0 s, groups 14.6 s, target 5 s. Sendblue and queue waits aren't steps here, so the guess reads lower.
        </p>
      </div>
      <div className="blk">
        <h2>Measured from a run</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          One line a model call. Claude stand-ins are re-timed from their tokens; API steps keep their real time.
        </p>
        <textarea
          ref={logRef}
          className="code"
          id="logIn"
          rows={5}
          placeholder={'{"node":"fd","model":"haiku-5-5","ms":4100,"in":21000,"out":310,"thinking":"…","steps":["search"],"output":"…"}'}
        />
        <div className="flex" style={{ marginTop: 8 }}>
          <button className="primary" id="logBtn" onClick={useLog}>Use this log</button>
          {s.logRows ? (
            <>
              <button className="ghost" id="logClear" onClick={() => {
                  emptyLog();
                  set({ logRows: null });
                }}>Back to guesses</button>
              <span className="hint">{Object.keys(s.logRows).length} steps measured</span>
            </>
          ) : null}
        </div>
        {s.logRows ? (
          <div className="tbl" style={{ marginTop: 10 }}>
            <table>
              <tbody>
                <tr>
                  <th>Step</th>
                  <th>Calls</th>
                  <th>Logged</th>
                  <th>In production</th>
                </tr>
                {Object.entries(s.logRows).map(([id, r]) => (
                  <tr key={id}>
                    <td>{node(id)?.label || id}</td>
                    <td>{r.calls}</td>
                    <td>{fmtS(r.wall)}</td>
                    <td>
                      {fmtS(r.prodMs)} <span className="hint">{r.api ? "real" : "from " + r.out + " tokens"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}

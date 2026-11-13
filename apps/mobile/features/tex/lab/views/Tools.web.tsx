/**
 * The Lab's Tools view: the artifact's `renderTools` (tex.lc/lab, its
 * lines 1126-1143). Tex's tool inventory with how often each tool and action
 * ran and failed. The numbers come from a paste (the artifact's only source)
 * or, when there is none, the live feed of every chat (`texLabToolStats`),
 * which the artifact did not have.
 */
import { Fragment, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { TOOL_INV } from "../data/tools";
import { fmtS } from "../engine/sim";
import { focusOn, G, set, toast } from "../engine/state";
import { useLab } from "../store";
import { Ic } from "./ic";
import { PageHead } from "./parts";
import { fromFeed, med, readToolLog, type Feed, type ToolStat, type ToolStats } from "./toolStats";

const ARTIFACT_NOTE = " Live numbers across every chat need a feed: failures alone are kept today, on tex.lc/admin under Why tools fail.";

/** One numeric cell (`cell()` in the artifact): calls, median, errors, or dashes. */
function Cells({ s, stats }: { s: ToolStat | undefined; stats: ToolStats | null }) {
  if (!stats) {
    return (
      <>
        <td className="tn hint">–</td>
        <td className="tn hint">–</td>
        <td className="tn hint">–</td>
      </>
    );
  }
  if (!s) {
    return (
      <>
        <td className="tn">0</td>
        <td className="tn">–</td>
        <td className="tn">–</td>
      </>
    );
  }
  const m = med(s.ms);
  return (
    <>
      <td className="tn">{s.calls}</td>
      <td className="tn">{m != null ? fmtS(m) : "–"}</td>
      <td className="tn">
        {s.err ? (
          <span className="lgno" title={Object.entries(s.why).map(([w, c]) => c + "× " + w).join("\n")}>
            {`${s.err} (${Math.round((s.err / s.calls) * 100)}%)`}
          </span>
        ) : (
          "0"
        )}
      </td>
    </>
  );
}

export function Tools() {
  const s = useLab();
  // Asked only while this view is open: every view is mounted (hidden) before the staff check answers, and the
  // query reads up to 2,500 turns, rerunning on each new one, so a hidden Tools tab should cost nothing.
  const feed = useQuery(api.functions.texLabToolStats.toolStats, s.view === "tools" ? { days: 7 } : "skip") as Feed | undefined;
  const pasted = s.toolStats;
  const feedStats = !pasted && feed && feed.rows.length ? fromFeed(feed) : null;
  const S = pasted ?? feedStats;
  const g = G();
  const users = g.nodes.filter((n) => n.ctx.includes("tools") || g.edges.some((e) => e.to === "tools" && e.from === n.id));
  const rows = TOOL_INV.map(([t, kind, what, acts]) => ({ t, kind, what, acts, s: S?.[t] })).sort((a, b) =>
    S ? (b.s?.calls || 0) - (a.s?.calls || 0) : 0,
  );
  const note = feedStats && feed ? ` Showing every chat's calls over the last ${feed.days} days (${feed.turns} turns${feed.truncated ? ", the newest only" : ""}); a paste replaces them here.` : pasted ? "" : ARTIFACT_NOTE;
  const text = useRef<HTMLTextAreaElement>(null);

  const read = () => {
    const { stats, n } = readToolLog(text.current?.value ?? "");
    if (text.current) text.current.value = "";
    set({ toolStats: n ? stats : null });
    toast(n ? `Read ${n} tool calls` : "No tool entries in that paste");
  };

  return (
    <>
      <PageHead icon={<Ic k="tools" />} title="Tools">
        Added only in code. Called by{" "}
        {users.length
          ? users.map((n, i) => (
              <Fragment key={n.id}>
                {i > 0 ? ", " : null}
                <button className="lnk" data-tfoc={n.id} onClick={() => focusOn(n.id)}>
                  {n.label}
                </button>
              </Fragment>
            ))
          : "no step on this version"}
        .
      </PageHead>
      <div className="blk" style={{ marginTop: 0 }}>
        <div className="tbl">
          <table className="ttbl">
            <tbody>
              <tr>
                <th>Tool</th>
                <th>Does</th>
                <th>Calls</th>
                <th>Median</th>
                <th>Errors</th>
              </tr>
              {rows.map((r) => (
                <tr key={r.t}>
                  <td>
                    <code>{r.t}</code> <span className={`cvk ${r.kind}`}>{r.kind}</span>
                  </td>
                  <td>
                    {r.what}
                    {r.acts.length ? (
                      <div className="tacts" style={{ marginTop: 6 }}>
                        {r.acts.map((a) => {
                          const st = S?.[r.t + "." + a];
                          const m = st ? med(st.ms) : null;
                          return (
                            <span
                              key={a}
                              className={`tact ${st?.err ? "err" : ""}`}
                              title={st ? `${st.calls} calls · ${st.err} errors${m != null ? " · median " + fmtS(m) : ""}` : ""}
                            >
                              {a}
                              {st ? <b>{st.calls}</b> : null}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </td>
                  <Cells s={r.s} stats={S} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="blk">
        <h2>Measure</h2>
        <p className="hint" style={{ margin: "0 0 8px" }}>
          Paste a chat's record (tex/history.ledger.json, or its tool lines). Every tool call there carries its time and whether it worked.
          {note}
        </p>
        <textarea
          className="note"
          id="tlIn"
          rows={4}
          ref={text}
          placeholder='{"kind":"tool","name":"write","args":{"action":"save"},"ok":true,"ms":412}'
        />
        <div className="flex" style={{ marginTop: 8 }}>
          <button className="primary" id="tlRead" onClick={read}>
            Read
          </button>
          {pasted ? (
            <button className="ghost" id="tlClear" onClick={() => set({ toolStats: null })}>
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

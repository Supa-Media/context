/**
 * The Lab's Evals (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval, and build out the adapter
 * for this eval"; "LongMemEval is primarily for context, its not supposed to test tex"; chose "Save each session raw,
 * then file"). Public benchmarks run against Context as an AI client's memory: per question a throwaway workspace,
 * every past session saved raw at its date, housekeeping filing it, and a fresh reader answering with the Context
 * endpoint only (`apps/mcp/bench/evals/`). Runs go to GitHub (`functions/labEvals.ts`), so they keep going after the
 * tab closes. Scores per skill, each question's answer and verdict, and every run kept. `tex_dev` `evals`, `eval_run`
 * and `eval_remove` do everything here. Public data, separate from the Training, Dev and Test sets; nothing gates CI.
 */
import { Fragment, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { ago, codeLink, commitLink, stageWords } from "../engine/labRuns";
import { toast } from "../engine/state";
import { Ic } from "./ic";
import { PageHead } from "./parts";

type Share = { n: number; correct: number; pct: number | null };
type Summary = {
  total: number;
  n: number;
  reader: string;
  judge: string;
  filings: number;
  ms: number;
  fullRunUsd: number;
  scores: Share & { asked: number; failed: number; byAbility: Record<string, Share>; byType: Record<string, Share>; usd: { filing: number; reading: number; judging: number; total: number } };
};
type Question = {
  id: string;
  type: string;
  ability: string;
  question: string;
  expected: string;
  date: string;
  answer: string;
  correct: boolean | null;
  judgeSaid: string;
  sessions: number;
  saved: number;
  saveErrors: number;
  filings: number;
  filingErrors: number;
  calls: Array<{ tool: string; input: string; chars: number; error: boolean }>;
  usd: { filing: number; reading: number; judging: number };
  ms: number;
  error: string | null;
};
type EvalRun = {
  id: string;
  bench: string;
  n: number;
  models: "gw" | "cc";
  code: string | null;
  commit: string | null;
  stage: "queued" | "running" | "done" | "failed";
  ghRunUrl: string | null;
  via: string;
  startedAt: number;
  finishedAt: number | null;
  rows: number;
  summary: Summary | null;
  error: string | null;
  questions?: Question[];
};
type Bench = { id: string; title: string; variant: string; total: number; about: string };

/** LongMemEval's five abilities, in the paper's order. */
const ABILITIES: Array<[string, string]> = [
  ["extraction", "Information extraction"],
  ["multi", "Multi-session reasoning"],
  ["temporal", "Temporal reasoning"],
  ["update", "Knowledge updates"],
  ["abstention", "Abstention"],
];

const usd = (x: number) => (x >= 10 ? `$${x.toFixed(0)}` : x >= 0.1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`);
const pct = (s: Share | undefined) => (s && s.n ? `${s.pct ?? Math.round((100 * s.correct) / s.n)}%` : "–");
const live = (r: EvalRun) => r.stage === "queued" || r.stage === "running";
const benchName = (benches: Bench[], id: string) => {
  const b = benches.find((x) => x.id === id);
  return b ? `${b.title} ${b.variant}` : id;
};

function Stage({ r }: { r: EvalRun }) {
  const [cls, words] = stageWords[r.stage];
  return (
    <span className={"pill " + cls} data-stage={r.stage}>
      {live(r) ? <span className="spin" /> : null}
      {r.stage === "running" && r.rows ? `${words} · ${r.rows}/${r.n}` : words}
    </span>
  );
}

/** One skill's bar: the share right, with its count. */
function Bar({ label, s }: { label: string; s: Share | undefined }) {
  const p = s && s.n ? (100 * s.correct) / s.n : 0;
  return (
    <div className="evbar" style={{ display: "grid", gridTemplateColumns: "minmax(0,200px) minmax(0,1fr) 92px", gap: 10, alignItems: "center", margin: "6px 0" }}>
      <span>{label}</span>
      <span style={{ height: 8, borderRadius: 4, background: "var(--line, rgba(127,127,127,.25))", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${p}%`, background: "var(--accent, #4b7bec)" }} />
      </span>
      <span className="tn" style={{ textAlign: "right" }}>
        {pct(s)} <span className="hint">{s && s.n ? `${s.correct}/${s.n}` : ""}</span>
      </span>
    </div>
  );
}

function RunDetail({ id, benches }: { id: string; benches: Bench[] }) {
  const run = useQuery(api.functions.labEvals.get, { id }) as EvalRun | null | undefined;
  const [open, setOpen] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "wrong" | "right">("all");
  if (run === undefined) return <p className="hint">Loading…</p>;
  if (run === null) return <p className="hint">This run is gone.</p>;
  const s = run.summary;
  const qs = (run.questions ?? []).filter((q) => (only === "all" ? true : only === "wrong" ? q.correct !== true : q.correct === true));
  return (
    <>
      <div className="blk" id="evRun">
        <h2>
          {benchName(benches, run.bench)}, {run.n} questions <Stage r={run} />
        </h2>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          On{" "}
          <a href={codeLink(run.code)} target="_blank" rel="noreferrer">
            {run.code ?? "main"}
          </a>
          {run.commit ? (
            <>
              {" "}
              at{" "}
              <a href={commitLink(run.commit)} target="_blank" rel="noreferrer">
                <code>{run.commit.slice(0, 7)}</code>
              </a>
            </>
          ) : null}
          , {run.models === "cc" ? "Claude Code ($0)" : "the AI gateway"}, started {ago(run.startedAt)} from {run.via}.
          {run.ghRunUrl ? (
            <>
              {" "}
              <a href={run.ghRunUrl} target="_blank" rel="noreferrer">
                GitHub run
              </a>
            </>
          ) : null}
        </p>
        {run.error ? <p className="lgno">{run.error}</p> : null}
        {s ? (
          <>
            <p style={{ fontSize: 28, margin: "4px 0 2px" }} id="evScore">
              {pct(s.scores)} <span className="hint" style={{ fontSize: 14 }}>{`${s.scores.correct}/${s.scores.n} right${s.scores.failed ? `, ${s.scores.failed} could not run` : ""}`}</span>
            </p>
            <p className="hint" style={{ margin: "0 0 10px" }}>
              Reader {s.reader}, judge {s.judge}, filing {s.filings}× per question. This run {usd(s.scores.usd.total)} (filing {usd(s.scores.usd.filing)}, reading {usd(s.scores.usd.reading)}, judging {usd(s.scores.usd.judging)}
              ), all {s.total} questions about {usd(s.fullRunUsd)}, {Math.round(s.ms / 60000)} min.
            </p>
            {ABILITIES.map(([k, label]) => (
              <Bar key={k} label={label} s={s.scores.byAbility[k]} />
            ))}
            <details style={{ marginTop: 8 }}>
              <summary className="hint">By question type</summary>
              {Object.entries(s.scores.byType).map(([k, v]) => (
                <Bar key={k} label={k} s={v} />
              ))}
            </details>
          </>
        ) : live(run) ? (
          <p className="hint">Scores appear when the run finishes.</p>
        ) : null}
      </div>
      {run.questions?.length ? (
        <div className="blk">
          <h2>Questions</h2>
          <div className="flex" style={{ gap: 6, marginBottom: 8 }}>
            {(["all", "wrong", "right"] as const).map((k) => (
              <button key={k} className={only === k ? "primary" : "ghost"} onClick={() => setOnly(k)}>
                {k === "all" ? "All" : k === "wrong" ? "Wrong" : "Right"}
              </button>
            ))}
          </div>
          <div className="tbl">
            <table className="ttbl" id="evQs">
              <tbody>
                <tr>
                  <th />
                  <th>Question</th>
                  <th>Skill</th>
                  <th>Cost</th>
                </tr>
                {qs.map((q) => (
                  <Fragment key={q.id}>
                    <tr data-q={q.id} style={{ cursor: "pointer" }} onClick={() => setOpen(open === q.id ? null : q.id)}>
                      <td>{q.correct === true ? <span className="lgok">✓</span> : q.correct === false ? <span className="lgno">✗</span> : <span className="hint">–</span>}</td>
                      <td>{q.question}</td>
                      <td className="hint">{ABILITIES.find(([k]) => k === q.ability)?.[1] ?? q.ability}</td>
                      <td className="tn">{usd(q.usd.filing + q.usd.reading + q.usd.judging)}</td>
                    </tr>
                    {open === q.id ? (
                      <tr>
                        <td />
                        <td colSpan={3}>
                          <p>
                            <b>Expected:</b> {q.expected}
                          </p>
                          <p style={{ whiteSpace: "pre-wrap" }}>
                            <b>Answered:</b> {q.answer || <span className="hint">(nothing)</span>}
                          </p>
                          <p className="hint">
                            {q.id} · {q.type} · asked {q.date} · {q.saved}/{q.sessions} sessions saved{q.saveErrors ? ` (${q.saveErrors} failed)` : ""} · filed {q.filings}×{q.filingErrors ? ` (${q.filingErrors} failed)` : ""} · judge said “{q.judgeSaid}” · {Math.round(q.ms / 1000)} s
                          </p>
                          {q.calls.length ? (
                            <p className="hint">
                              Reader:{" "}
                              {q.calls.map((c, i) => (
                                <span key={i} className={`tact ${c.error ? "err" : ""}`} title={c.input}>
                                  {c.tool}
                                  <b>{c.chars}</b>
                                </span>
                              ))}
                            </p>
                          ) : null}
                          {q.error ? <p className="lgno">{q.error}</p> : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Evals({ visible = true }: { visible?: boolean }) {
  const benches = (useQuery(api.functions.labEvals.benches, visible ? {} : "skip") as Bench[] | undefined) ?? [];
  const runs = (useQuery(api.functions.labEvals.list, visible ? {} : "skip") as EvalRun[] | undefined) ?? [];
  const start = useMutation(api.functions.labEvals.start);
  const remove = useMutation(api.functions.labEvals.remove);
  const [bench, setBench] = useState("longmemeval-s");
  const [n, setN] = useState(50);
  const [models, setModels] = useState<"gw" | "cc">("gw");
  const [code, setCode] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked ?? runs[0]?.id ?? null;
  const total = benches.find((b) => b.id === bench)?.total ?? 500;

  const run = async () => {
    try {
      const { runId } = await start({ bench, n, models, ...(code.trim() ? { code: code.trim() } : {}) });
      setPicked(runId);
      toast("Started on GitHub");
    } catch (e) {
      const why = (e as { data?: unknown })?.data;
      toast(typeof why === "string" ? why : e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /, "") : "The run didn't start");
    }
  };

  return (
    <>
      <PageHead icon={<Ic k="star" />} title="Evals">
        Public benchmarks of Context as an AI client's memory. Each question gets an empty workspace; every past session is saved raw at its date, Context files it, and a fresh reader answers
        with only the Context endpoint. Separate from the Training, Dev and Test sets; nothing here gates CI.
      </PageHead>
      <div className="blk" style={{ marginTop: 0 }}>
        <h2>Run</h2>
        <div className="flex" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select id="evBench" className="search" style={{ maxWidth: 220 }} value={bench} onChange={(e) => setBench(e.target.value)}>
            {(benches.length ? benches : [{ id: "longmemeval-s", title: "LongMemEval", variant: "S", total: 500, about: "" }]).map((b) => (
              <option key={b.id} value={b.id}>
                {b.title} {b.variant}
              </option>
            ))}
          </select>
          <label className="hint">
            Questions{" "}
            <input id="evN" className="search" type="number" min={1} max={total} value={n} style={{ width: 80 }} onChange={(e) => setN(Math.max(1, Math.min(total, Math.round(Number(e.target.value) || 1))))} />
          </label>
          <select id="evModels" className="search" style={{ maxWidth: 200 }} value={models} onChange={(e) => setModels(e.target.value as "gw" | "cc")}>
            <option value="gw">AI gateway</option>
            <option value="cc">Claude Code ($0)</option>
          </select>
          <input id="evCode" className="search" placeholder="main, #PR or branch" value={code} style={{ maxWidth: 200 }} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" id="evRunBtn" onClick={() => void run()}>
            ▶ Run
          </button>
        </div>
        <p className="hint" style={{ margin: "8px 0 0" }}>
          {benches.find((b) => b.id === bench)?.about} The same number of questions is the same slice every time, stratified by question type.
        </p>
      </div>
      {runs.length ? (
        <div className="blk">
          <h2>Runs</h2>
          <div className="tbl">
            <table className="ttbl" id="evRuns">
              <tbody>
                <tr>
                  <th>Started</th>
                  <th>Benchmark</th>
                  <th>Code</th>
                  <th>Score</th>
                  <th>Cost</th>
                  <th />
                </tr>
                {runs.map((r) => (
                  <tr key={r.id} data-run={r.id} aria-current={r.id === shown} style={{ cursor: "pointer", fontWeight: r.id === shown ? 600 : undefined }} onClick={() => setPicked(r.id)}>
                    <td>{ago(r.startedAt)}</td>
                    <td>
                      {benchName(benches, r.bench)} · {r.n}
                    </td>
                    <td>
                      <code>{r.code ?? "main"}</code> {r.models === "cc" ? <span className="hint">cc</span> : null}
                    </td>
                    <td>{r.summary ? pct(r.summary.scores) : <Stage r={r} />}</td>
                    <td className="tn">{r.summary ? usd(r.summary.scores.usd.total) : "–"}</td>
                    <td>
                      {!live(r) ? (
                        <button
                          className="ghost"
                          title="Remove this run"
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove({ id: r.id }).then(() => setPicked(null));
                          }}
                        >
                          ✕
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {shown ? <RunDetail id={shown} benches={benches} /> : null}
    </>
  );
}

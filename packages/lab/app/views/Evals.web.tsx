/**
 * The Lab's Evals (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval, and build out the adapter
 * for this eval"; "LongMemEval is primarily for context, its not supposed to test tex"; chose "Save each session raw,
 * then file"). Public benchmarks run against Context as an AI client's memory: per question a throwaway workspace,
 * every past session saved raw at its date, housekeeping filing it, and a fresh reader answering with the Context
 * endpoint only (`apps/mcp/bench/evals/`). The Search suite (search-hard, search-real, longmemeval-retrieval; Dev2,
 * 2026-11-21) asks whether search puts the right note first: embeddings only, no Claude, so no cost and no Claude Code
 * choice. Runs go to GitHub (`functions/labEvals.ts`), so they keep going after the tab closes. Scores per skill or per
 * search metric, each question's answer and verdict, and every run kept. `tex_dev` `evals`, `eval_run` and
 * `eval_remove` do everything here. Public data, separate from the Training, Dev and Test sets; nothing gates CI.
 */
import { Fragment, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { ago, codeLink, commitLink, stageWords } from "../engine/labRuns";
import { toast } from "../engine/state";
import { Ic } from "./ic";
import { PageHead } from "./parts";
import { AI_KEYS, keyState } from "@context/tex/src/aiKeys.cjs";

type Share = { n: number; correct: number; pct: number | null };
/** The Search suite's scores (`apps/mcp/bench/evals/searchSuite.mjs`): right note first, top 5, MRR and time. */
type SearchScores = {
  n: number;
  first: number;
  top5: number;
  found: number;
  firstPct: number | null;
  top5Pct: number | null;
  foundPct: number | null;
  mrr: number;
  p50Ms: number;
  p95Ms: number;
  errors: number;
  /** longmemeval-retrieval only: is any / every answer session in the top 5. */
  recallAny5Pct?: number | null;
  recallAll5Pct?: number | null;
  byKind?: Record<string, { n: number; firstPct: number | null }>;
  byAbility?: Record<string, { n: number; recallAny5Pct: number | null }>;
  byPath?: Record<string, number>;
  objects?: { n: number; first: number; firstPct: number | null; top5Pct: number | null; mrr: number; same: number; better: number; worse: number };
  /** NanoBEIR only (`nanoBeir.mjs`): BEIR's scores at 10 as the mean over sets, BM25's own ranking scored the same way. */
  ndcg10?: number | null;
  recall10?: number | null;
  mrr10?: number | null;
  bm25Ndcg10?: number | null;
  objectNdcg10?: number | null;
  bySet?: Record<string, { n: number; ndcg10: number | null; recall10: number | null; mrr10: number | null; firstPct: number | null; bm25Ndcg10: number | null; objectNdcg10: number | null }>;
};
type Summary = {
  total: number;
  n: number;
  reader: string;
  judge: string;
  filings: number;
  ms: number;
  fullRunUsd: number;
  /** A Claude Code run's spend: measured tokens and the weekly limit's share (`ccUsage.mjs`); absent on a gateway run. */
  cc?: { calls: number; tokens: number; weeklyPct: number | null; weeklyWhy: string | null; fullRunTokens: number | null; fullRunWeeklyPct: number | null };
  /** A Search suite run's scores; absent on a benchmark that asks a model. */
  search?: SearchScores;
  scores: Share & { asked: number; failed: number; byAbility: Record<string, Share>; byType: Record<string, Share>; usd: { filing: number; reading: number; judging: number; total: number; estimated?: boolean } };
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
  /** Search suite rows: the rank of the first expected note (null: not found, or none expected) and the hits' count. */
  rank?: number | null;
  hits?: number;
  judgeSaid: string;
  sessions: number;
  saved: number;
  saveErrors: number;
  filings: number;
  filingErrors: number;
  calls: Array<{ tool: string; input: string; chars: number; error: boolean }>;
  usd: { filing: number; reading: number; judging: number };
  tokens?: { filing: number; reading: number; judging: number };
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
type Bench = { id: string; title: string; variant: string; total: number; about: string; search: boolean };

/** LongMemEval's five abilities, in the paper's order. */
const ABILITIES: Array<[string, string]> = [
  ["extraction", "Information extraction"],
  ["multi", "Multi-session reasoning"],
  ["temporal", "Temporal reasoning"],
  ["update", "Knowledge updates"],
  ["abstention", "Abstention"],
];

const toks = (x: number) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : `${x}`);
/** A Claude Code run's spend, in tokens and the weekly limit's share, never as dollars it did not cost. */
const ccSpend = (s: Summary) =>
  s.cc
    ? `${toks(s.cc.tokens)} tokens${s.cc.weeklyPct !== null ? `, ${s.cc.weeklyPct}% of the weekly limit` : ""}`
    : "tokens not recorded";
const usd = (x: number) => (x >= 10 ? `$${x.toFixed(0)}` : x >= 0.1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`);
const pct = (s: Share | undefined) => (s && s.n ? `${s.pct ?? Math.round((100 * s.correct) / s.n)}%` : "–");
/** A search percentage, or a dash when it was not measured (no expected note, or nothing to count). */
const sp = (x: number | null | undefined) => (typeof x === "number" ? `${x}%` : "–");
const secs = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const live = (r: EvalRun) => r.stage === "queued" || r.stage === "running";
const benchName = (benches: Bench[], id: string) => {
  const b = benches.find((x) => x.id === id);
  return b ? `${b.title} ${b.variant}` : id;
};
/** A Search suite run: embeddings only, so no model's cost and no Claude Code choice. */
const searchRun = (r: EvalRun, benches: Bench[]) => benches.find((b) => b.id === r.bench)?.search === true || r.summary?.search !== undefined;
/** A query's rank: the place of its first expected note in the search's answer, or that it was not found. */
const rankOf = (q: Question) => (!q.expected ? "–" : q.rank ? `#${q.rank}` : "not found");
/** The first two notes the search answered with (all of them are in the question's own view). */
const firstHits = (q: Question) => q.answer.split("\n").slice(0, 2).join(", ");

function Stage({ r }: { r: EvalRun }) {
  const [cls, words] = stageWords[r.stage];
  return (
    <span className={"pill " + cls} data-stage={r.stage}>
      {live(r) ? <span className="spin" /> : null}
      {r.stage === "running" && r.rows ? `${words} · ${r.rows}/${r.n}` : words}
    </span>
  );
}

/** One bar: a width of the row, its value and a detail after it. */
function BarRow({ label, width, value, detail }: { label: string; width: number; value: string; detail: string }) {
  return (
    <div className="evbar" style={{ display: "grid", gridTemplateColumns: "minmax(0,200px) minmax(0,1fr) 92px", gap: 10, alignItems: "center", margin: "6px 0" }}>
      <span>{label}</span>
      <span style={{ height: 8, borderRadius: 4, background: "var(--line, rgba(127,127,127,.25))", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${width}%`, background: "var(--accent, #4b7bec)" }} />
      </span>
      <span className="tn" style={{ textAlign: "right" }}>
        {value} <span className="hint">{detail}</span>
      </span>
    </div>
  );
}

/** One skill's bar: the share right, with its count. */
function Bar({ label, s }: { label: string; s: Share | undefined }) {
  const p = s && s.n ? (100 * s.correct) / s.n : 0;
  return <BarRow label={label} width={p} value={pct(s)} detail={s && s.n ? `${s.correct}/${s.n}` : ""} />;
}

/** A Search suite run's scores: right note first, top 5, MRR and time; Recall@5 for longmemeval-retrieval. */
function SearchScore({ s }: { s: Summary }) {
  const x = s.search;
  if (!x) return null;
  const two = (v: number | null | undefined) => (typeof v === "number" ? v.toFixed(3) : "–");
  const tiles: Array<[string, string]> = [];
  // NanoBEIR's headline is BEIR's own score, so it leads, with BM25's ranking of the same queries beside it.
  // HERB has no BM25 list (`herb.mjs`), so its run leaves that tile out rather than show a dash.
  const bm25 = typeof x.bm25Ndcg10 === "number";
  if (x.ndcg10 !== undefined) tiles.push(["nDCG@10", two(x.ndcg10)], ...(bm25 ? [["BM25 nDCG@10", two(x.bm25Ndcg10)] as [string, string]] : []), ["Objects nDCG@10", two(x.objectNdcg10)], ["Recall@10", two(x.recall10)]);
  tiles.push(
    ["Right note first", sp(x.firstPct)],
    ["Top 5", sp(x.top5Pct)],
    ["MRR", x.mrr.toFixed(2)],
    ["p50 time", secs(x.p50Ms)],
  );
  if (x.recallAny5Pct !== undefined) tiles.push(["Recall@5, any", sp(x.recallAny5Pct)], ["Recall@5, all", sp(x.recallAll5Pct)]);
  return (
    <>
      <div className="flex" id="evScore" style={{ gap: 28, flexWrap: "wrap", margin: "4px 0 6px" }}>
        {tiles.map(([label, value], i) => (
          <div key={label}>
            <div className="hint">{label}</div>
            <div className="tn" style={{ fontSize: i === 0 ? 28 : 20 }}>
              {value}
            </div>
          </div>
        ))}
      </div>
      <p className="hint" style={{ margin: "0 0 10px" }}>
        Embeddings only: no model answers, so no cost. {x.n} questions in {Math.round(s.ms / 1000)} s; {x.first} with the right note first, {x.found} found at all
        {x.errors ? `, ${x.errors} errors` : ""}; p95 {secs(x.p95Ms)}.
        {x.byPath ? ` Answered by ${Object.entries(x.byPath).map(([p, n]) => `${p} ${n}`).join(", ")}.` : ""}
        {x.objects
          ? ` In workspace objects: ${x.objects.first} of ${x.objects.n} right note first (${x.objects.firstPct ?? "-"}%), top 5 ${x.objects.top5Pct ?? "-"}%, MRR ${x.objects.mrr.toFixed(2)}; same rank ${x.objects.same}, better ${x.objects.better}, worse ${x.objects.worse}.`
          : ""}
      </p>
      {x.byAbility
        ? Object.entries(x.byAbility).map(([k, v]) => (
            <BarRow key={k} label={ABILITIES.find(([a]) => a === k)?.[1] ?? k} width={v.recallAny5Pct ?? 0} value={sp(v.recallAny5Pct)} detail={`${v.n} questions`} />
          ))
        : null}
      {x.bySet ? (
        <div id="evSets" style={{ marginTop: 8 }}>
          <div className="hint" style={{ marginBottom: 4 }}>{bm25 ? <>nDCG@10 per set: ours (bar) against BM25&apos;s ranking of the same queries</> : <>nDCG@10 per question type</>}</div>
          {Object.entries(x.bySet).map(([k, v]) => (
            <BarRow
              key={k}
              label={bm25 ? `${k} (BM25 ${two(v.bm25Ndcg10)}, objects ${two(v.objectNdcg10)})` : `${k}, ${v.n} questions (objects ${two(v.objectNdcg10)})`}
              width={100 * (v.ndcg10 ?? 0)}
              value={two(v.ndcg10)}
              detail=""
            />
          ))}
        </div>
      ) : null}
      {x.byKind && !x.bySet ? (
        <details style={{ marginTop: 8 }}>
          <summary className="hint">By kind of question</summary>
          {Object.entries(x.byKind).map(([k, v]) => (
            <BarRow key={k} label={k} width={v.firstPct ?? 0} value={sp(v.firstPct)} detail={`${v.n} questions`} />
          ))}
        </details>
      ) : null}
    </>
  );
}

function RunDetail({ id, benches }: { id: string; benches: Bench[] }) {
  const run = useQuery(api.functions.labEvals.get, { id }) as EvalRun | null | undefined;
  const [open, setOpen] = useState<string | null>(null);
  const [only, setOnly] = useState<"all" | "wrong" | "right">("all");
  if (run === undefined) return <p className="hint">Loading…</p>;
  if (run === null) return <p className="hint">This run is gone.</p>;
  const s = run.summary;
  const search = searchRun(run, benches);
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
          , {search ? "embeddings only" : run.models === "cc" ? "Claude Code" : "the AI gateway"}, started {ago(run.startedAt)} from {run.via}.
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
        {s && search ? (
          <SearchScore s={s} />
        ) : s ? (
          <>
            <p style={{ fontSize: 28, margin: "4px 0 2px" }} id="evScore">
              {pct(s.scores)} <span className="hint" style={{ fontSize: 14 }}>{`${s.scores.correct}/${s.scores.n} right${s.scores.failed ? `, ${s.scores.failed} could not run` : ""}`}</span>
            </p>
            <p className="hint" style={{ margin: "0 0 10px" }}>
              Reader {s.reader}, judge {s.judge}, filing {s.filings}× per question.{" "}
              {run.models === "cc" ? (
                <>
                  Claude Code: this run {ccSpend(s)}
                  {s.cc?.fullRunTokens ? `; all ${s.total} questions about ${toks(s.cc.fullRunTokens)} tokens${s.cc.fullRunWeeklyPct !== null ? `, ${s.cc.fullRunWeeklyPct}% of a week` : ""}` : ""}, {Math.round(s.ms / 60000)} min.
                  {s.cc && s.cc.weeklyPct === null ? ` The weekly share was not read (${s.cc.weeklyWhy ?? "no read"}).` : ""}
                  {s.cc?.weeklyPct !== null && s.cc ? " The weekly share is the account's, read before and after, so other use meanwhile is in it." : ""}
                </>
              ) : (
                <>
                  This run {s.scores.usd.estimated ? "≈ " : ""}
                  {usd(s.scores.usd.total)} (filing {usd(s.scores.usd.filing)}, reading {usd(s.scores.usd.reading)}, judging {usd(s.scores.usd.judging)}), all {s.total} questions about {usd(s.fullRunUsd)}, {Math.round(s.ms / 60000)} min.
                </>
              )}
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
                  {search ? (
                    <>
                      <th>Rank</th>
                      <th>Query</th>
                      <th>Expected</th>
                      <th>First hits</th>
                    </>
                  ) : (
                    <>
                      <th />
                      <th>Question</th>
                      <th>Skill</th>
                      <th>Cost</th>
                    </>
                  )}
                </tr>
                {qs.map((q) => (
                  <Fragment key={q.id}>
                    <tr data-q={q.id} style={{ cursor: "pointer" }} onClick={() => setOpen(open === q.id ? null : q.id)}>
                      {search ? (
                        <>
                          <td className={q.expected && !q.rank ? "lgno tn" : "tn"}>{rankOf(q)}</td>
                          <td>{q.question}</td>
                          <td className="hint">{q.expected || "–"}</td>
                          <td className="hint" title={q.answer}>
                            {firstHits(q)}
                          </td>
                        </>
                      ) : (
                        <>
                          <td>{q.correct === true ? <span className="lgok">✓</span> : q.correct === false ? <span className="lgno">✗</span> : <span className="hint">–</span>}</td>
                          <td>{q.question}</td>
                          <td className="hint">{ABILITIES.find(([k]) => k === q.ability)?.[1] ?? q.ability}</td>
                          <td className="tn">{run.models === "cc" ? (q.tokens ? `≈ ${toks(q.tokens.filing + q.tokens.reading + q.tokens.judging)} tok` : "–") : usd(q.usd.filing + q.usd.reading + q.usd.judging)}</td>
                        </>
                      )}
                    </tr>
                    {open === q.id ? (
                      <tr>
                        <td />
                        <td colSpan={3}>
                          {search ? (
                            <>
                              <p>
                                <b>Expected:</b> {q.expected || <span className="hint">(none: a privacy case)</span>}
                              </p>
                              <p style={{ whiteSpace: "pre-wrap" }}>
                                <b>First hits:</b> {q.answer || <span className="hint">(none)</span>}
                              </p>
                              <p className="hint">
                                {q.id} · {q.type} · {q.hits ?? 0} hits · {q.ms} ms
                              </p>
                            </>
                          ) : (
                            <>
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
                            </>
                          )}
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
  // Whose Anthropic key pays first (`packages/tex/src/aiKeys.json`); "" is that file's evals order.
  const [key, setKey] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked ?? runs[0]?.id ?? null;
  const choices: Bench[] = benches.length ? benches : [{ id: "longmemeval-s", title: "LongMemEval", variant: "S", total: 500, about: "", search: false }];
  const chosen = choices.find((b) => b.id === bench);
  const total = chosen?.total ?? 500;
  const isSearch = chosen?.search === true;

  const pick = (id: string) => {
    setBench(id);
    const b = choices.find((x) => x.id === id);
    if (!b) return;
    // A Search set is embeddings only: its whole set is its slice, and it never asks Claude.
    if (b.search) {
      setModels("gw");
      setN(Math.max(1, b.total));
    } else setN(Math.min(50, b.total));
  };

  const run = async () => {
    try {
      const { runId } = await start({ bench, n, models: isSearch ? "gw" : models, ...(!isSearch && models === "gw" && key ? { key } : {}), ...(code.trim() ? { code: code.trim() } : {}) });
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
        Public benchmarks of Context. LongMemEval runs Context as an AI client's memory: each question gets an empty workspace, every past session is saved raw at its date, Context files
        it, and a fresh reader answers with only the Context endpoint. The Search suite asks whether search puts the right note first (embeddings only, no Claude). Separate from the
        Training, Dev and Test sets; nothing here gates CI.
      </PageHead>
      <div className="blk" style={{ marginTop: 0 }}>
        <h2>Run</h2>
        <div className="flex" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select id="evBench" className="search" style={{ maxWidth: 240 }} value={bench} onChange={(e) => pick(e.target.value)}>
            <optgroup label="LongMemEval">
              {choices
                .filter((b) => !b.search)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} {b.variant}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Search">
              {choices
                .filter((b) => b.search)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} {b.variant}
                  </option>
                ))}
            </optgroup>
          </select>
          <label className="hint">
            Questions{" "}
            <input id="evN" className="search" type="number" min={1} max={Math.max(1, total)} value={n} style={{ width: 80 }} onChange={(e) => setN(Math.max(1, Math.min(total, Math.round(Number(e.target.value) || 1))))} />
          </label>
          {isSearch ? null : (
            <select id="evModels" className="search" style={{ maxWidth: 200 }} value={models} onChange={(e) => setModels(e.target.value as "gw" | "cc")}>
              <option value="gw">AI gateway</option>
              <option value="cc">Claude Code (subscription)</option>
            </select>
          )}
          {isSearch || models !== "gw" ? null : (
            <select id="evKey" className="search" style={{ maxWidth: 220 }} title="Whose Anthropic key pays first; one that can't pay falls back to the default order" value={key} onChange={(e) => setKey(e.target.value)}>
              <option value="">Default key order</option>
              {AI_KEYS.map((k) => (
                <option key={k.alias} value={k.alias}>
                  {k.owner}'s key first{keyState(k) ? ` (${keyState(k)})` : ""}
                </option>
              ))}
            </select>
          )}
          <input id="evCode" className="search" placeholder="main, #PR or branch" value={code} style={{ maxWidth: 200 }} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" id="evRunBtn" disabled={total === 0} onClick={() => void run()}>
            ▶ Run
          </button>
        </div>
        <p className="hint" style={{ margin: "8px 0 0" }}>
          {chosen?.about} {isSearch ? "The same number of questions is the same set every time." : "The same number of questions is the same slice every time, stratified by question type."}
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
                    <td>{r.summary ? (searchRun(r, benches) ? sp(r.summary.search?.firstPct) : pct(r.summary.scores)) : <Stage r={r} />}</td>
                    <td className="tn">
                      {r.summary ? (
                        searchRun(r, benches) ? (
                          <span className="hint">Embeddings only</span>
                        ) : r.models === "cc" ? (
                          ccSpend(r.summary)
                        ) : (
                          usd(r.summary.scores.usd.total)
                        )
                      ) : (
                        "–"
                      )}
                    </td>
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

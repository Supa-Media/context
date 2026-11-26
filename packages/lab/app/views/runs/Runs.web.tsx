/**
 * Running from the Lab (mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): starting a run (the top bar's
 * ▶ Run Dev set, `views/bar/TopBar.web.tsx`, picks the version and models), and the Runs panel with each run's score, misses and the same
 * run as a tex_dev call. Scores come from the Dev set only; the Test set runs only in its locked service, behind
 * Promote's pull request.
 */
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { lab, node, toast } from "../../engine/state";
import { ago, CC_FIDELITY_WHY, codeLink, commitLink, costWords, fidelityWords, fixedWords, live, mcpLines, modelsWords, oneDp, rowRate, runLabel, runsUi, scoreWords, setRunsUi, stageWords, useRunsUi, worldWords, type LabRun, type RunKind, type RunRow } from "../../engine/labRuns";
import { setUi, sets } from "../../engine/setsStore";
import { RouteSummaryBlock } from "./RouteSummary.web";

const nodeName = (id: string) => node(id)?.label ?? id;
const chatTitle = (id: string) => sets.convs.find((c) => c.id === id)?.title ?? id;
const verName = (id: string) => (id === "main" ? "main" : lab.versions.find((v) => v.id === id)?.name ?? id);

/** Every run, newest first, as Convex keeps them. */
export function useRuns(versionId?: string): LabRun[] {
  return ((useQuery(api.functions.texLabRuns.list, versionId ? { versionId } : {}) as LabRun[] | undefined) ?? []).slice();
}

/** Start a run on GitHub and open it in the Runs panel; a refusal (too many waiting, the day's cap) says why. */
export function useStartRun(where: "testing" | "lab") {
  const start = useMutation(api.functions.texLabRuns.start);
  return async (kind: Exclude<RunKind, "gate">, extra: { convId?: string; nodeId?: string } = {}, versionId = runsUi.ver) => {
    try {
      const { runId } = await start({ versionId, kind, models: runsUi.models, repeats: runsUi.repeats, ...(runsUi.key && runsUi.models === "gw" ? { key: runsUi.key } : {}), ...extra });
      setRunsUi({ open: true, run: runId });
    } catch (e) {
      const why = (e as { data?: unknown })?.data;
      const say = typeof why === "string" ? why : e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /, "") : "The run didn't start";
      if (where === "testing") setUi({ problem: say });
      else toast(say);
    }
  };
}

/** A gate run's outcome: counts only, and a change that reaches no Test set area needs none. */
export const gateWords = (r: LabRun) => (!r.results ? "" : r.results.total === 0 ? "No Test set needed: the change reaches no area it covers." : `${r.results.pass}/${r.results.total} passed.`);

export function StagePill({ r }: { r: LabRun }) {
  if (r.fixedSince) {
    return (
      <span className="pill d" data-stage="fixed">
        {fixedWords}
      </span>
    );
  }
  const [cls, words] = stageWords[r.stage];
  return (
    <span className={"pill " + cls} data-stage={r.stage}>
      {live(r) ? <span className="spin" /> : null}
      {words}
    </span>
  );
}

/** The Testing tab's run controls: which version, which models, ▶ Run Dev set and the Runs panel. */
/** The Runs panel, in place of the cell's labels while it is open. */
export function RunsPanel() {
  const ui = useRunsUi();
  const runs = useRuns();
  const r = runs.find((x) => x.id === ui.run) ?? runs[0] ?? null;
  const detail = useQuery(api.functions.texLabRuns.get, r ? { id: r.id } : "skip") as LabRun | null | undefined;
  const full = detail ?? r;
  // A row misses when it failed, or when it ran more than once and passed fewer repeats than it ran (Dev2, 2026-11-19).
  const isMiss = (x: RunRow) => !x.ok || ((x.runs ?? 1) > 1 && (x.passes ?? 0) < (x.runs ?? 1));
  const misses = (full?.results?.rows ?? []).filter(isMiss);
  const removeRun = useMutation(api.functions.texLabRuns.remove);
  const remove = async (id: string) => {
    try {
      await removeRun({ id });
      if (ui.run === id) setRunsUi({ run: null });
    } catch (e) {
      toast(e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /, "") : "The run wasn't removed");
    }
  };
  return (
    <div className="panel" id="runsPanel">
      <div className="insp">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="cap">Runs</div>
          <button className="btn sm ghost" id="closeRuns" style={{ marginLeft: "auto" }} onClick={() => setRunsUi({ open: false })}>
            Close
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {runs.length ? (
            runs.map((x) => (
              <button key={x.id} className={"runrow" + (full && x.id === full.id ? " on" : "")} data-run={x.id} onClick={() => setRunsUi({ run: x.id })}>
                <span className="l1">
                  <b className="small">{runLabel(x, chatTitle, nodeName)}</b>
                  <StagePill r={x} />
                </span>
                <span className="muted small">
                  {verName(x.versionId)}
                  {x.code ? ` · ${x.code}` : ""}
                  {x.commit ? ` @ ${x.commit.slice(0, 7)}` : ""} · {modelsWords(x)} · {x.by ?? "you"} · {ago(x.startedAt)}
                  {x.stage === "done" && x.kind !== "gate" ? " · " + scoreWords(x) : ""}
                  {fidelityWords(x) ? ` · ${fidelityWords(x)}` : ""}
                </span>
              </button>
            ))
          ) : (
            <div className="note">No runs yet. ▶ Run Dev set at the top, ▶ Run this chat, or ▶ Run node in a cell.</div>
          )}
        </div>
        {full ? (
          <>
            <div className="cap">{runLabel(full, chatTitle, nodeName)}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <StagePill r={full} />
              {live(full) ? null : (
                <button className="btn sm ghost" id="removeRun" style={{ marginLeft: "auto" }} onClick={() => void remove(full.id)}>
                  Remove
                </button>
              )}
            </div>
            {full.kind === "gate" ? (
              <div className="small">
                The sealed Test set, run by the pull request's own check in the locked eval service. It reports pass or fail and counts by step only.
                {full.stage === "done" && full.results ? <b id="gateResult"> {gateWords(full)}</b> : null}
                {full.pr ? (
                  <>
                    {" "}
                    <a href={full.pr} target="_blank" rel="noopener noreferrer">
                      Its pull request ↗
                    </a>
                  </>
                ) : null}
              </div>
            ) : (
              <div className="small muted">
                On {verName(full.versionId)}. A GitHub run on {full.code ? (full.code.startsWith("#") ? `pull request ${full.code}'s code` : `branch ${full.code}'s code`) : "main's code"} with this version's config; {full.models === "cc" ? "every model call answered by Claude Code on the subscription token" : "the same models live Tex uses, through the AI gateway"}; scored by the bench and saved here. Nothing personal goes into GitHub's public log: it prints counts only.
              </div>
            )}
            {full.kind !== "gate" ? (
              <div className="small" id="runCode">
                <a href={codeLink(full.code)} target="_blank" rel="noopener noreferrer">
                  {full.code ?? "main"} ↗
                </a>
                {full.key ? <span id="runKeyUsed">{` · ${full.key} first`}</span> : null}
                {full.commit ? (
                  <>
                    {" · ran commit "}
                    <a id="runCommit" href={commitLink(full.commit)} target="_blank" rel="noopener noreferrer">
                      <code>{full.commit.slice(0, 7)}</code> ↗
                    </a>
                  </>
                ) : (
                  <span className="muted"> · {live(full) ? "commit not checked out yet" : "no commit reported"}</span>
                )}
              </div>
            ) : null}
            {full.error ? <div className={"small " + (full.fixedSince ? "muted" : "c-bad")}>{full.fixedSince ? `${fixedWords}. It failed then: ${full.error}` : full.error}</div> : null}
            {full.stage === "done" && full.results && full.kind !== "gate" ? (
              <>
                <div>
                  <b>{scoreWords(full)}</b> · {costWords(full)}
                  {worldWords(full.results?.world) !== "" ? <> · {worldWords(full.results?.world)}</> : null}
                </div>
                {fidelityWords(full) ? (
                  <div className="small" id="runFidelity">
                    <span className="pill" data-fidelity="cc">
                      {fidelityWords(full)}
                    </span>
                    <div className="small muted">{full.results.fidelityWhy ?? CC_FIDELITY_WHY}</div>
                  </div>
                ) : null}
                {(full.results.perNode ?? []).length ? (
                  <div className="small">
                    {(full.results.perNode ?? []).map((p) => (
                      <span key={p.node} className="pernode">
                        {nodeName(p.node)} {oneDp(p.pass)}/{p.total}
                        {p.min !== undefined && p.max !== undefined ? ` (${p.min}–${p.max})` : ""}
                      </span>
                    ))}
                  </div>
                ) : null}
                <RouteSummaryBlock rows={full.results.rows ?? []} />
                {misses.map((x, k) => (
                  <div className="miss" key={k}>
                    <b>
                      {chatTitle(x.convId)} #{x.msgIndex + 1} · {nodeName(x.node)}
                    </b>
                    <div className="muted">
                      {x.ran === false ? "didn't run" : `got ${x.got || "nothing"}; wanted ${x.want}`}
                      {rowRate(x) ? ` · ${rowRate(x)}` : ""}
                    </div>
                    <button className="btn sm ghost" data-goto={`${x.convId}|${x.msgIndex}|${x.node}`} onClick={() => openCell(x.convId, x.msgIndex, x.node)}>
                      Open cell
                    </button>
                  </div>
                ))}
              </>
            ) : null}
            {full.ghRunUrl ? (
              <a href={full.ghRunUrl} target="_blank" rel="noopener noreferrer">
                GitHub run ↗
              </a>
            ) : null}
            <div className="cap">Same from any MCP session</div>
            <div className="mcp">{mcpLines(full)}</div>
          </>
        ) : null}
        <div className="note">Scores come from the Dev set only. Training chats don’t run here, because Tex reads their labels in its prompts as examples. The Test set never runs here: it runs only in the locked eval service when a pull request is gated.</div>
      </div>
    </div>
  );
}

function openCell(convId: string, i: number, node: string) {
  const c = sets.convs.find((x) => x.id === convId);
  const m = c?.msgs[i];
  if (!c || !m) return;
  setUi({ chat: c.id, msg: m.id, col: node, editing: false });
  setRunsUi({ open: false });
}

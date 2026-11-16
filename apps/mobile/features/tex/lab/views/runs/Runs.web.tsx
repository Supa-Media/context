/**
 * Running from the Lab (mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): the controls (which version, which
 * models, ▶ Run Dev set, Runs), each chat's latest run, and the Runs panel with each run's score, misses and the same
 * run as a tex_dev call. Scores come from the Dev set only; the Test set runs only in its locked service, behind
 * Promote's pull request.
 */
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { G, lab, toast } from "../../engine/state";
import { ago, costWords, live, mcpLines, modelsWords, runLabel, runsUi, scoreWords, setRunsUi, stageWords, useRunsUi, type LabRun, type RunKind } from "../../engine/labRuns";
import { setUi, sets } from "../../engine/setsStore";

const nodeName = (id: string) => G().nodes.find((x) => x.id === id)?.label ?? id;
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
      const { runId } = await start({ versionId, kind, models: runsUi.models, ...extra });
      setRunsUi({ open: true, run: runId });
    } catch (e) {
      const why = (e as { data?: unknown })?.data;
      const say = typeof why === "string" ? why : e instanceof Error ? e.message.replace(/^.*Uncaught ConvexError: /, "") : "The run didn't start";
      if (where === "testing") setUi({ problem: say });
      else toast(say);
    }
  };
}

export function StagePill({ r }: { r: LabRun }) {
  const [cls, words] = stageWords[r.stage];
  return (
    <span className={"pill " + cls} data-stage={r.stage}>
      {live(r) ? <span className="spin" /> : null}
      {words}
    </span>
  );
}

/** The Testing tab's run controls: which version, which models, ▶ Run Dev set and the Runs panel. */
export function RunControls() {
  const ui = useRunsUi();
  const runs = useRuns();
  const go = useStartRun("testing");
  const busy = runs.filter(live).length;
  return (
    <div className="runctl" id="runCtl">
      <label className="small muted" htmlFor="runVer">
        Run
      </label>
      <select id="runVer" aria-label="Which version runs" value={ui.ver} onChange={(e) => setRunsUi({ ver: e.target.value })}>
        {lab.versions.map((v) => (
          <option key={v.id} value={v.id}>
            {v.id === "main" ? "main" : `draft “${v.name}”`}
          </option>
        ))}
      </select>
      <ModelsPick />
      <button className="btn sm p" id="runDev" title="Runs every Dev set unit test on GitHub, with the models you pick" onClick={() => void go("dev")}>
        ▶ Run Dev set
      </button>
      <button className="btn sm" id="runsBtn" aria-pressed={ui.open} onClick={() => setRunsUi({ open: !ui.open })}>
        Runs{runs.length ? <b> {runs.length}</b> : null}
        {busy ? <span className="spin" /> : null}
      </button>
    </div>
  );
}

export function ModelsPick() {
  const ui = useRunsUi();
  return (
    <select id="runModels" aria-label="Which models answer" value={ui.models} onChange={(e) => setRunsUi({ models: e.target.value === "cc" ? "cc" : "gw" })}>
      <option value="gw">Models: as live Tex (AI gateway)</option>
      <option value="cc">Models: Claude Code (subscription)</option>
    </select>
  );
}

/** Above a chat's grid: its latest run (the chat alone, or the Dev set it is in). */
export function RunBar({ convId, dev }: { convId: string; dev: boolean }) {
  const runs = useRuns();
  const r = runs.find((x) => (x.kind === "chat" && x.convId === convId) || (dev && x.kind === "dev"));
  if (!r)
    return (
      <div className="runbar" id="runBar">
        <span className="muted">No run on this chat yet. ▶ Run this chat, or ▶ Run Dev set at the top, runs its unit tests on GitHub.</span>
      </div>
    );
  return (
    <div className="runbar" id="runBar">
      <StagePill r={r} />
      <b>{runLabel(r, chatTitle, nodeName)}</b>
      <span className="muted">
        on {verName(r.versionId)} · started {ago(r.startedAt)}
      </span>
      {r.stage === "done" ? (
        <span>
          {scoreWords(r)} · {costWords(r)}
        </span>
      ) : null}
      <a href="#" data-openrun={r.id} onClick={(e) => (e.preventDefault(), setRunsUi({ open: true, run: r.id }))}>
        Details
      </a>
      {r.ghRunUrl ? (
        <a href={r.ghRunUrl} target="_blank" rel="noopener noreferrer">
          GitHub run ↗
        </a>
      ) : null}
    </div>
  );
}

/** The Runs panel, in place of the cell's labels while it is open. */
export function RunsPanel() {
  const ui = useRunsUi();
  const runs = useRuns();
  const r = runs.find((x) => x.id === ui.run) ?? runs[0] ?? null;
  const detail = useQuery(api.functions.texLabRuns.get, r ? { id: r.id } : "skip") as LabRun | null | undefined;
  const full = detail ?? r;
  const misses = (full?.results?.rows ?? []).filter((x) => !x.ok);
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
                  {verName(x.versionId)} · {modelsWords(x)} · {x.by ?? "you"} · {ago(x.startedAt)}
                  {x.stage === "done" && x.kind !== "gate" ? " · " + scoreWords(x) : ""}
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
            <div>
              <StagePill r={full} />
            </div>
            {full.kind === "gate" ? (
              <div className="small">
                The sealed Test set, run by the pull request's own check in the locked eval service. It reports pass or fail and counts by step only.
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
                On {verName(full.versionId)}. A GitHub run on main's code with this version's config; {full.models === "cc" ? "every model call answered by Claude Code on the subscription token" : "the same models live Tex uses, through the AI gateway"}; scored by the bench and saved here. Nothing personal goes into GitHub's public log: it prints counts only.
              </div>
            )}
            {full.error ? <div className="small c-bad">{full.error}</div> : null}
            {full.stage === "done" && full.results && full.kind !== "gate" ? (
              <>
                <div>
                  <b>{scoreWords(full)}</b> · {costWords(full)}
                </div>
                {(full.results.perNode ?? []).length ? (
                  <div className="small">
                    {(full.results.perNode ?? []).map((p) => (
                      <span key={p.node} className="pernode">
                        {nodeName(p.node)} {p.pass}/{p.total}
                      </span>
                    ))}
                  </div>
                ) : null}
                {misses.map((x, k) => (
                  <div className="miss" key={k}>
                    <b>
                      {chatTitle(x.convId)} #{x.msgIndex + 1} · {nodeName(x.node)}
                    </b>
                    <div className="muted">{x.ran === false ? "didn't run" : `got ${x.got || "nothing"}; wanted ${x.want}`}</div>
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

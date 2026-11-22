/**
 * The step panel's "Run details" card (Lab live sandbox, approved mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5):
 * what one step did for the test text picked in the test chat, in tabs Summary (first), Output, Input, Thinking and Calls.
 * A step still running keeps the tabs and shows only how long it has been going, in each; nothing of its output, calls,
 * tokens or cost is shown before it is logged. The card never shows change info: that lives on the Settings card.
 */
import { useEffect, useState, type ReactNode } from "react";
import { fmtReal, fmtUsd } from "../../engine/sim";
import { sandbox, useSandbox } from "../../engine/sandbox";
import { usePlay } from "../../engine/sandboxPlay";
import { callsHeading, summaryOf, type RunStep, type StepCall } from "../../engine/stepRun";
import { panelRow, playedStepRun, stepRunOf, type StepRunState } from "../../engine/stepRunNow";
import { lab, MODELS, set } from "../../engine/state";
import { useLab } from "../../store";
import type { LabNode } from "../../types";
import { ProdDetails } from "../canvas/ProdDetails.web";

const TABS: Array<[typeof lab.runTab, string]> = [
  ["sum", "Summary"],
  ["out", "Output"],
  ["in", "Input"],
  ["think", "Thinking"],
  ["calls", "Calls"],
];

/** The picked text's row, and how step `n` stands in it now; draws again every quarter second while it runs. */
export function useStepRun(n: LabNode): { has: boolean; run: StepRunState } {
  useLab();
  const { play, pick } = usePlay();
  useSandbox();
  const [, tick] = useState(0);
  const row = panelRow(pick, play);
  const run = playedStepRun(play, n.id) ?? stepRunOf(row, n.id, play && row && play.msgId === row.id ? play.t : null);
  const running = run.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [running]);
  // A real text played from production's log has its steps on the run, not the row.
  return { has: !!row?.steps?.length || !!sandbox.running || !!play, run };
}

const sum = (xs: Array<number | undefined>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const known = (xs: Array<number | undefined>) => xs.some((x) => x !== undefined);
const json = (s: RunStep) => (s.data !== undefined ? JSON.stringify(s.data, null, 2) : s.out);
/** Tokens as the mockup says them: "18.4k", or the number under a thousand. */
const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Ran, Running or Didn't run: beside the step's name, as the mockup has it. */
export function StatusBadge({ run }: { run: StepRunState }) {
  return run.state === "ran" ? <span className="st ok">Ran</span> : run.state === "running" ? <span className="st run">Running</span> : <span className="st none">Didn't run</span>;
}

/** The one-line facts under a step's name: what ran it and, for the run card, how long it took. */
export function StatusRow({ n, card, run, draft }: { n: LabNode; card: "run" | "set"; run: StepRunState; draft: string }) {
  const m = MODELS[n.model] || MODELS.code;
  const steps = run.state === "ran" ? run.steps : [];
  const last = steps[steps.length - 1];
  const model = last?.model ? last.model.replace(/^anthropic\//, "") : m.runs === "code" ? "Code" : m.name + (n.effort && m.runs !== "api" ? " · " + n.effort : "");
  const ms = sum(steps.map((s) => s.ms ?? undefined));
  const tokIn = steps.reduce((a, s) => a + (s.tokIn ?? 0), 0);
  const tokOut = steps.reduce((a, s) => a + (s.tokOut ?? 0), 0);
  const cost = sum(steps.map((s) => s.cost));
  return (
    <div className="runhead">
      <div className="runmeta">
        <span>{model}</span>
        {card === "set" ? <span>{`settings in draft ${draft}`}</span> : null}
        {card === "run" && run.state === "running" ? <span>{fmtReal(run.elapsed)}</span> : null}
        {card === "run" && run.state === "ran" ? (
          <>
            <span>{fmtReal(ms) + (run.times > 1 ? ` · ${run.times} times` : "")}</span>
            {tokIn || tokOut ? <span>{`${tok(tokIn)} in · ${tok(tokOut)} out`}</span> : null}
            {known(steps.map((s) => s.cost)) ? <span>{fmtUsd(cost)}</span> : null}
            {steps.some((s) => s.bg) ? <span>in the background</span> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

const BADGE: Record<StepCall["kind"], [string, string]> = { read: ["real", "Real read"], write: ["swr", "Test write"], prod: ["line", "Ran in prod"] };

function Calls({ calls }: { calls: StepCall[] }) {
  return (
    <>
      {calls.map((c, i) => (
        <div key={i} className="call">
          <div className="top">
            <b>{c.tool}</b>
            <span className={`bdg ${BADGE[c.kind][0]}`}>{BADGE[c.kind][1]}</span>
            <span className="ms">{fmtReal(c.ms)}</span>
          </div>
          {c.d ? <div className="d">{c.d}</div> : null}
        </div>
      ))}
    </>
  );
}

function Summary({ n, steps }: { n: LabNode; steps: RunStep[] }) {
  const m = MODELS[n.model] || MODELS.code;
  const x = steps[steps.length - 1];
  const s = summaryOf(x);
  const calls = steps.flatMap((y) => y.calls ?? []);
  const ms = sum(steps.map((y) => y.ms ?? undefined));
  const tiles: Array<[string, string]> = [
    [fmtReal(ms), "took"],
    [x.tokIn !== undefined ? `${tok(x.tokIn)} in` : "–", x.tokIn !== undefined || m.runs !== "code" ? "tokens in" : "no model"],
    [x.cost !== undefined ? fmtUsd(x.cost) : m.runs === "code" ? "$0" : "–", "cost"],
  ];
  const go = (runTab: typeof lab.runTab) => set({ runTab });
  return (
    <div className="sum">
      <div className="stats">
        {tiles.map(([b, l]) => (
          <div key={l} className="stat">
            <b>{b}</b>
            <span>{l}</span>
          </div>
        ))}
      </div>
      {s.decided.length ? (
        <div>
          <div className="lbl">Decided</div>
          <div className="pills">
            {s.decided.map((w) => (
              <span key={w} className="pill">
                {w}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {s.said ? (
        <div>
          <div className="lbl">{s.said.kind}</div>
          <div className="said">{s.said.text}</div>
        </div>
      ) : null}
      {s.why ? (
        <div>
          <div className="lbl">Why</div>
          <div className="why">{s.why}</div>
        </div>
      ) : null}
      {s.details.length ? (
        <div>
          <div className="lbl">Details</div>
          <div className="kvs">
            {s.details.map(([k, v]) => (
              <span key={k} style={{ display: "contents" }}>
                <span>{k}</span>
                <span>{v}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {calls.length ? (
        <div>
          <div className="lbl">{callsHeading(calls)}</div>
          {calls.map((c, i) => (
            <div key={i} className="cl">
              <code>{c.tool}</code>
              <span className={`bdg ${BADGE[c.kind][0]}`}>{BADGE[c.kind][1]}</span>
              <span className="ms">{fmtReal(c.ms)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex" style={{ gap: 12 }}>
        <button className="more" onClick={() => go("out")}>
          Full output
        </button>
        <button className="more" onClick={() => go("in")}>
          Input
        </button>
        {x.think ? (
          <button className="more" onClick={() => go("think")}>
            Thinking
          </button>
        ) : null}
        {calls.length ? (
          <button className="more" onClick={() => go("calls")}>
            Call details
          </button>
        ) : null}
      </div>
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

/** The card: the tabs and their body for step `n`, given how it stands in the picked text. */
export function RunCard({ n, has, run }: { n: LabNode; has: boolean; run: StepRunState }) {
  const m = MODELS[n.model] || MODELS.code;
  // Another step (followed, or clicked) opens on Summary, as the mockup's.
  const [shownFor, setShownFor] = useState(n.id);
  if (shownFor !== n.id) {
    setShownFor(n.id);
    if (lab.runTab !== "sum") lab.runTab = "sum";
  }
  const tab = lab.runTab;
  const tabs = (
    <div className="tabs" role="tablist" aria-label="Run details">
      {TABS.map(([k, l]) => (
        <button key={k} role="tab" data-tab={k} aria-pressed={tab === k} onClick={() => set({ runTab: k })}>
          {l}
        </button>
      ))}
    </div>
  );
  // Running: the tabs, as for a step that ran, and every one of them says only how long it has been going.
  if (run.state === "running")
    return (
      <>
        {tabs}
        <div className="runbody">
          {tab === "sum" ? (
            <div className="sum">
              <div className="stats">
                <div className="stat">
                  <b>{fmtReal(run.elapsed)}</b>
                  <span>running</span>
                </div>
              </div>
              <div className="why">Running now. What it decided, wrote and called lands here the moment it logs it; nothing is shown before it happens.</div>
            </div>
          ) : (
            <Empty>{`Running for ${fmtReal(run.elapsed)}… ${tab === "out" ? "its output" : tab === "in" ? "its input" : tab === "think" ? "its thinking" : "its tool calls"} land${tab === "calls" ? "" : "s"} here when it finishes.`}</Empty>
          )}
        </div>
      </>
    );
  if (run.state === "none")
    return (
      <div className="runbody">
        <Empty>{!has ? "Send a test text, or pick one in the test chat, to see what each step did." : n.on ? "Didn't run for this text, so there's nothing to show." : "Turned off in this version."}</Empty>
      </div>
    );
  const x = run.steps[run.steps.length - 1];
  const calls = run.steps.flatMap((y) => y.calls ?? []);
  let body: ReactNode;
  if (tab === "out") body = <pre>{json(x) || "Nothing logged."}</pre>;
  else if (tab === "in")
    body = x.in !== undefined ? <pre>{typeof x.in === "string" ? x.in : JSON.stringify(x.in, null, 2)}</pre> : <Empty>{m.runs === "code" ? "Code step: its input is the previous step's output." : "Its input wasn't logged for this text."}</Empty>;
  else if (tab === "think") body = x.think ? <div className="think">{x.think}</div> : <Empty>{`No thinking: ${m.runs === "code" ? "code step" : "the model returned none"}.`}</Empty>;
  else if (tab === "calls") body = calls.length ? <Calls calls={calls} /> : <Empty>No tool calls.</Empty>;
  else body = <Summary n={n} steps={run.steps} />;
  return (
    <>
      {tabs}
      <div className="runbody">{body}</div>
      <ProdDetails node={n.id} />
    </>
  );
}

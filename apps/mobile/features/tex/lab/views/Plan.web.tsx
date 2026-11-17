/**
 * The Lab's Eval plan page: the problem, the three eval milestones each built on the last, and the Milestone 1 trial.
 * Ported from Dev2's eval plan diagram for Seyi and Sayo (2026-11-16, asked to live at /lab). Static: every figure
 * here is from the 2026-11-14 trial run or the providers' own reports, as each row's source says. Styles are
 * `labCssPlan.ts`.
 */
import type { ReactNode } from "react";
import { PageHead } from "./parts";

const Dot = ({ m }: { m: 1 | 2 | 3 }) => <i className={`d m${m}`}>{m}</i>;

const Arrow = () => (
  <div className="link" aria-hidden="true">
    <svg viewBox="0 0 40 24">
      <path d="M2 12h30M24 4l10 8-10 8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <span>
      carries
      <br />
      over
    </span>
  </div>
);

const PAINS: Array<{ title: string; line: string; ex: ReactNode; cost: string; by: Array<1 | 2 | 3> }> = [
  {
    title: "Every bad reply gets its own patch",
    line: "When Tex gets something wrong, we write code that catches that one case.",
    ex: (
      <>
        Tex sent two long texts when one line was wanted. The prompt already said "keep it short", so we added <code>wordy.js</code> to count
        reply shapes. The same happened for unfinished research (<code>stopsShort.js</code>), made-up claims (<code>claimCheck.js</code>) and more.
      </>
    ),
    cost: "Patches pile up, every reply runs through more of them, and nobody knows which ones still help.",
    by: [2, 3],
  },
  {
    title: "We cannot tell if a change made Tex better",
    line: "Each patch is tested only on its own scripted cases.",
    ex: (
      <>
        The tests for <code>wordy.js</code> only check it on a few scripted replies. They say nothing about whether Tex now answers worse, slower,
        or too briefly everywhere else.
      </>
    ),
    cost: "No one can say whether Tex is better this week than last.",
    by: [1, 2, 3],
  },
  {
    title: "Most of our test questions are made up",
    line: "The main AI benchmark runs on invented people and notes.",
    ex: <>Its README says "Everything here is invented". The exception is the sealed test set, written by people, which already blocks merges.</>,
    cost: "Tex can pass most of our tests and still fail on how real people text.",
    by: [1, 2],
  },
];

type Chip = string | [1 | 2, string];
const MILESTONES: Array<{
  m: 1 | 2 | 3;
  status: string;
  name: string;
  ask: string;
  why: ReactNode[];
  how: string[];
  onMain?: string[];
  reuses?: Chip[];
  adds: string[];
}> = [
  {
    m: 1,
    status: "Trial done",
    name: "Context memory",
    ask: "Does Context find the right note?",
    why: [
      <>Tells us if a bad reply is <em>memory or the model</em>, before we patch</>,
      <>A score next to Mem0, Zep and Supermemory <em>for the landing page</em></>,
      <>Helps <em>every app</em> on Context, not only Tex</>,
    ],
    how: ["Load the public benchmark (LongMemEval)", "Grade search with code, answers with an AI judge", "Check the judge against our own grades", "Run all 500 questions, then the MCP tools"],
    adds: ["test runner", "code grader", "AI judge", "score ranges", "scoreboard"],
  },
  {
    m: 2,
    status: "Next",
    name: "Our own data",
    ask: "Does Context hold up on our real data?",
    why: [
      <>Public tests are not how <em>our users talk</em></>,
      <>A hold set means <em>a fix cannot quietly break</em> what already works</>,
      <>Replaces AI-written tests <em>we do not trust</em></>,
    ],
    how: ["Collect real chats, shared with consent", "Write questions from our notes, in our own words", "Turn each real failure into a case", "Split into a set to hold and a set to climb"],
    onMain: ["Lab replay of real texts", "chats shared with devs"],
    reuses: [[1, "runner"], [1, "graders"], [1, "judge"], [1, "scoreboard"]],
    adds: ["real cases", "hold set (~99%)", "target set"],
  },
  {
    m: 3,
    status: "Later",
    name: "Tex",
    ask: "Does Tex reply right, fast and short?",
    why: [
      <>See each change's trade-off: <em>faster vs. better</em></>,
      <>Patches that never move a score <em>get deleted</em>, so the code gets simpler</>,
      <>Shows exactly <em>where to train</em> our own model</>,
    ],
    how: ["Write up to 20 cases per part of Tex", "Grade replies by hand first", "Let the judge take over once it agrees", "Score every change against main"],
    onMain: ["sealed test set", "merge check against main"],
    reuses: [[1, "graders"], [1, "judge"], [2, "real cases"], [2, "hold + target sets"]],
    adds: ["Tex cases", "speed + cost", "all 3 milestones in that check"],
  },
];

/** LongMemEval, answers right, on a 50% to 100% axis: `left = (pct - 50) * 2`. `bar` is a [from, to] range, `pts` single scores. */
const RANKS: Array<{ name: string; bar?: [number, number]; pts?: number[]; val: string; src: string; kind?: "us" | "base" }> = [
  { name: "Mem0", bar: [93, 94], val: "93 to 94%", src: "own blog, models not stated" },
  { name: "Context", bar: [82, 97], pts: [90], val: "90%", src: "our trial: Sonnet answers, Haiku grades, 60 questions", kind: "us" },
  { name: "Zep", pts: [71.2, 90.2], val: "71 or 90%", src: "71% own paper (GPT-4o, 2025); 90% ContextStream (gpt-5.4)" },
  { name: "Supermemory", bar: [84.6, 85.2], val: "85%", src: "own site" },
  { name: "No memory", pts: [60.6], val: "61%", src: "whole history pasted in, GPT-4o (LongMemEval paper)", kind: "base" },
];
const at = (pct: number) => `${(pct - 50) * 2}%`;

export function Plan() {
  return (
    <div className="plan">
      <PageHead
        icon={
          <svg className="i" viewBox="0 0 24 24">
            <path d="M4 12h4l3-7 3 14 3-7h3" />
          </svg>
        }
        title="Eval plan"
      >
        {"How we stop patching Tex one bad reply at a time: three milestones of evals, each built on the last."}
      </PageHead>

      <section aria-label="The problem today">
        <span className="label">The problem today, across Context and Tex</span>
        <div className="pains">
          {PAINS.map((p) => (
            <div key={p.title} className="pain">
              <b>{p.title}</b>
              <span>{p.line}</span>
              <div className="ex">
                <span className="label">Example</span>
                {p.ex}
              </div>
              <em>{p.cost}</em>
              <span className="fix">
                Fixed by {p.by.map((m) => <Dot key={m} m={m} />)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="Three milestones">
        <span className="label">The plan: three milestones, each built on the last</span>
        <div className="path">
          {MILESTONES.map((c, i) => [
            i ? <Arrow key={`a${c.m}`} /> : null,
            <div key={c.m} className={`card m${c.m}`}>
              <div className="top">
                <div className="num">{c.m}</div>
                <div>
                  <span className="status">{c.status}</span>
                  <b>{c.name}</b>
                </div>
              </div>
              <div className="ask">{c.ask}</div>
              <div className="why">
                <span className="label">Why care</span>
                <ul>
                  {c.why.map((w, j) => (
                    <li key={j}>{w}</li>
                  ))}
                </ul>
              </div>
              <div>
                <span className="label">How</span>
                <ol className="steps">
                  {c.how.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ol>
              </div>
              {c.onMain ? (
                <div className="built">
                  <span className="label">Already on main</span>
                  <div className="chips">
                    {c.onMain.map((x) => (
                      <span key={x}>{x}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {c.reuses ? (
                <div>
                  <span className="label">Reuses from earlier milestones</span>
                  <div className="chips">
                    {c.reuses.map((x) => (
                      <span key={String(x)}>
                        {typeof x === "string" ? x : (<><Dot m={x[0]} />{x[1]}</>)}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              <div>
                <span className="label">{c.m === 1 ? "Builds" : "Adds"}</span>
                <div className="chips">
                  {c.adds.map((x) => (
                    <span key={x}>{x}</span>
                  ))}
                </div>
              </div>
            </div>,
          ])}
        </div>
      </section>

      <section className="trial m1" aria-label="Milestone 1 trial run">
        <div className="thead">
          <div className="num">1</div>
          <div>
            <span className="status">Milestone 1 · trial run</span>
            <b>What we tried, and what it showed</b>
          </div>
        </div>
        <div>
          <span className="label">How we ran it</span>
          <ol className="mflow">
            <li><b>Load</b><span>60 LongMemEval questions, 10 per type. Each one's ~50 past chats become notes in Context.</span></li>
            <li><b>Search</b><span>Context ranks the chats. Code checks if the right one is first. Runs in our GitHub benchmark.</span></li>
            <li><b>Answer</b><span>10 <em>Claude Sonnet</em> subagents answer from Context's top 5 chats. 4 more get the right chats directly, for the ceiling.</span></li>
            <li><b>Grade</b><span>3 <em>Claude Haiku</em> subagents grade every answer blind, with LongMemEval's own grading prompt.</span></li>
            <li><b>Range</b><span>Resample the 60 scores 1,000 times to get the likely range.</span></li>
          </ol>
          <p className="mnote">Answering and grading ran as Claude Code subagents inside one session, not through a separate API setup.</p>
        </div>
        <div className="two">
          <div>
            <span className="label">What it showed</span>
            <div className="tnums">
              <div><strong>87%</strong><span>right note ranked first</span><small>likely 80 to 95%</small></div>
              <div><strong>90%</strong><span>answers right</span><small>likely 82 to 97%</small></div>
              <div><strong>95%</strong><span>answers right with perfect memory</span><small>the ceiling for this model</small></div>
            </div>
            <p>Weakest: questions that span several chats, and date reasoning (80% each).</p>
          </div>
          <div>
            <span className="label">Why it is only a trial</span>
            <ul>
              <li>60 of 500 questions, so the ranges are wide</li>
              <li>The grader has not been checked against our own grades</li>
              <li>Vendors use other models and graders, so their numbers are not a ranking</li>
            </ul>
          </div>
        </div>
        <div>
          <span className="label">Next to other memory providers (LongMemEval, answers right)</span>
          <div className="rank">
            {RANKS.map((r) => (
              <div key={r.name} className={`rrow ${r.kind ?? ""}`}>
                <b>{r.name}</b>
                <div className="rbar">
                  {r.bar ? <i style={{ left: at(r.bar[0]), width: `${(r.bar[1] - r.bar[0]) * 2}%` }} /> : null}
                  {r.pts?.map((p) => <s key={p} style={{ left: at(p) }} />)}
                </div>
                <span className="rv">{r.val}</span>
                <span className="rsrc">{r.src}</span>
              </div>
            ))}
            <div className="rrow" aria-hidden="true">
              <span />
              <div className="rticks">
                <span style={{ left: "0%" }}>50%</span>
                <span style={{ left: "50%" }}>75%</span>
                <span style={{ left: "100%" }}>100%</span>
              </div>
            </div>
          </div>
          <p className="mnote">Same league, not a ranking: each provider used different models and graders, and none has been re-run by anyone else.</p>
        </div>
      </section>
    </div>
  );
}

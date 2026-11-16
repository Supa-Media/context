/**
 * The Lab's Eval plan page (`/lab?page=evals`): one place for how the team measures its AI work, beside the rest of
 * the Lab's tinkering (Seyi, 2026-11-16: "Can you build it into /lab somehow, that way we have one place for all the
 * ai tinkering"). It says what is measured today (Tex's replies, through Testing's sets and the replay gate), the gap
 * (nothing here measures context retrieval), and the two milestones that close it.
 *
 * Static on purpose: the targets are a plan, not results, so nothing here reads a run. When a milestone has runs,
 * its card should read them rather than restate a number.
 *
 * The structure diagram is a placeholder: the team's picture of the eval layers has not been added to the repository,
 * and its layers are not written down anywhere this page could quote, so nothing here guesses at them.
 */
import { set } from "../engine/state";
import { PageHead } from "./parts";

const ICON = (
  <svg className="i" viewBox="0 0 24 24">
    <path d="M9 5h10M9 12h10M9 19h10" />
    <path d="M4 5l1 1 2-2M4 12l1 1 2-2" />
    <circle cx="5" cy="19" r="1.2" />
  </svg>
);

/** Milestone one's targets, shown as cards. Targets, not measurements. */
export const MEMORY_TRIAL_TARGETS: Array<[string, string, string]> = [
  ["Right note ranked first", "87%", "of questions"],
  ["Answers right", "90%", "of questions"],
  ["Questions in the trial", "60", "written with their right note and answer"],
];

export function EvalPlan() {
  const openTesting = () => set({ mode: "testing", sel: null, cfocus: null, view: "canvas" });
  return (
    <div data-testid="eval-plan">
      <PageHead icon={ICON} title="Eval plan">
        How we measure Tex and Context, in one place: what is tested today, what is not, and the next two milestones.
      </PageHead>

      <div className="blk" id="evalStructure">
        <h2>Structure</h2>
        <div
          className="box"
          data-testid="eval-structure-placeholder"
          style={{ borderStyle: "dashed", minHeight: 120, placeItems: "center", textAlign: "center", color: "var(--muted)" }}
        >
          <b>Jhon's structure picture goes here.</b>
          <span>It has not been added yet. Drop the picture in as it is rather than redrawing it from memory.</span>
        </div>
      </div>

      <div className="blk" id="evalToday">
        <h2>What we measure today: Tex's replies</h2>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, lineHeight: 1.5, maxWidth: "68ch" }}>
          <li>
            <b>Testing sets.</b> The Lab's Testing mode holds the Training, Dev and Test sets as conversations, labelled per
            message and per step.{" "}
            <button className="lnk" style={{ fontSize: "inherit" }} onClick={openTesting}>
              Open Testing
            </button>
          </li>
          <li>
            <b>Run Dev set.</b> Runs a draft on the Dev set only, on GitHub, and can run a pull request's code. Never the
            Training set (a step has seen it as examples) and never the Test set.
          </li>
          <li>
            <b>The replay gate.</b> The sealed Test set, kept from agents, gates a Promote's pull request through the{" "}
            <i>Tex test set</i> check.
          </li>
          <li>
            <b>Compare versions</b> shows each saved version's run numbers side by side.
          </li>
        </ul>
      </div>

      <div className="blk" id="evalGap">
        <h2>The gap: context retrieval</h2>
        <p className="lede" style={{ marginBottom: 0 }}>
          Nothing in the Lab measures whether Tex finds the right note before it answers. A reply can read well and still
          rest on the wrong note, and today no score here would show it. An older search benchmark (50 queries, run from a
          GitHub Action in October) lives outside the Lab and is not part of this plan's runs yet.
        </p>
      </div>

      <div className="blk" id="evalM1">
        <h2>Milestone 1: memory trial</h2>
        <p className="lede">
          A fixed set of 60 questions, each with the note that answers it and the right answer. Retrieval is scored on
          whether that note is ranked first; the answer is scored on whether it is right.
        </p>
        <div className="cards">
          {MEMORY_TRIAL_TARGETS.map(([label, value, detail]) => (
            <div className="kpi" key={label}>
              <div className="l">{label}</div>
              <div className="v">{value}</div>
              <div className="d">{detail}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="blk" id="evalM2">
        <h2>Milestone 2: testing on real chat data</h2>
        <p className="lede" style={{ marginBottom: 0 }}>
          Run the same scoring on questions drawn from real chats. <b>Consent comes first:</b> no real chat is used until
          the people in it have said yes.
        </p>
      </div>
    </div>
  );
}

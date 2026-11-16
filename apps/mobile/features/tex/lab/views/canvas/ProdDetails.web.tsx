/**
 * Under a step's Run details while a real text plays (Lab live sandbox, Dev2 2026-11-16): the prompt the turn that ran
 * the step was sent (`replay/PromptAt.tsx`) and the background jobs the moment ran or reported (`replay/JobRuns.tsx`),
 * as production logged them (`views/mine/playProd.ts`). Nothing for a test text.
 */
import { playingProd, usePlay } from "../../engine/sandboxPlay";
import { runOf } from "../../engine/sandboxPlay";
import { replayEntries } from "../mine/useMine";
import { JobRuns } from "../replay/JobRuns";
import { PromptAt } from "../replay/PromptAt";

export function ProdDetails({ node }: { node: string }) {
  const { play } = usePlay();
  const p = playingProd();
  const run = play ? runOf(play.id) : null;
  if (!p || !run) return null;
  const ids = new Set(run.steps.filter((s) => s.node === node && s.at <= (play?.t ?? 0)).map((s) => s.id));
  const turn = p.turns.find((t) => t.steps.some((id) => ids.has(id)) && t.prompt);
  if (!turn?.prompt && !p.jobs.length) return null;
  return (
    <div className="proddet" id="prodDetails">
      {turn?.prompt ? <PromptAt p={turn.prompt} /> : null}
      {p.jobs.map((id) => (
        <JobRuns key={id} id={id} entries={replayEntries()} />
      ))}
    </div>
  );
}

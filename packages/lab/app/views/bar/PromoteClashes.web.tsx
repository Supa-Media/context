/**
 * A refused Promote's clashes, to pick from (Dev2, 2026-11-17: "how are we avoiding merge conflicts"; chose "A + B +
 * schema, no split"). Promote merges only the draft's own changes onto main as it is now (`scripts/tex-lab-merge.mjs`);
 * a setting, wire or prompt's words that main changed too since the draft was made is refused by name. Here the person
 * picks main's or this draft's for each and promotes again; tex_dev does the same with `promote { draft, picks }`.
 * A clash with no draft side (an edit main has made impossible, such as a wire to a step main removed) is shown, not
 * offered: it is made again in a fresh draft.
 */
import { useState } from "react";
import { promoteVersion, type ClashPick } from "../../store";
import type { LabVersion } from "../../types";

type Clash = NonNullable<NonNullable<LabVersion["promote"]>["clashes"]>[number];

/** The picks to send: one per clash that may be picked, or null while any is unpicked or can't be picked. */
export function picksToSend(clashes: Clash[], chosen: Record<string, "main" | "draft">): ClashPick[] | null {
  if (clashes.some((c) => !c.pick)) return null;
  const out: ClashPick[] = [];
  for (const c of clashes) {
    const take = chosen[c.what];
    if (!take) return null;
    out.push({ what: c.what, take });
  }
  return out;
}

export function PromoteClashes({ promote, dirty, onDone }: { promote: LabVersion["promote"]; dirty: boolean; onDone: () => void }) {
  const clashes = promote?.state === "refused" ? (promote.clashes ?? []) : [];
  const [chosen, setChosen] = useState<Record<string, "main" | "draft">>(() => Object.fromEntries((promote?.picks ?? []).map((p) => [p.what, p.take])));
  if (promote?.state !== "refused") return null;
  if (clashes.length === 0) return promote.why ? <div className="mnote" id="promoteWhy">Refused: {promote.why}</div> : null;
  const picks = picksToSend(clashes, chosen);
  const stuck = clashes.some((c) => !c.pick);
  return (
    <div className="clashes" id="promoteClashes">
      <div className="mnote">
        Main changed {clashes.length === 1 ? "this" : "these"} since this draft was made. {stuck ? "One can't be picked: make that change again in a fresh draft." : "Pick a side for each, then promote again."}
      </div>
      {clashes.map((c) => (
        <div className="clash" key={c.what} data-clash={c.what}>
          <div className="cw">{c.what}</div>
          <div className="seg" role="group" aria-label={`Pick for ${c.what}`}>
            <button aria-pressed={chosen[c.what] === "main"} disabled={!c.pick} title="Keep main's" onClick={() => setChosen({ ...chosen, [c.what]: "main" })}>
              Main: {c.main}
            </button>
            <button aria-pressed={chosen[c.what] === "draft"} disabled={!c.pick} title="Write this draft's over main's" onClick={() => setChosen({ ...chosen, [c.what]: "draft" })}>
              Draft: {c.draft}
            </button>
          </div>
        </div>
      ))}
      <button
        className="mi"
        id="promotePicked"
        disabled={dirty || picks === null}
        onClick={() => {
          if (!picks) return;
          void promoteVersion(picks);
          onDone();
        }}
      >
        Promote with these picks
        <span className="meta">{picks ? "opens its pull request" : stuck ? "can't" : `${Object.keys(chosen).filter((w) => clashes.some((c) => c.what === w)).length}/${clashes.length} picked`}</span>
      </button>
    </div>
  );
}

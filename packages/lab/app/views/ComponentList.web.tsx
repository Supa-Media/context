/**
 * Components in the sidebar (Dev2, 2026-11-26: "a concept of components like figma has so we can reference something
 * and reuse it wherever it is"): under Architecture, every group marked `component: true`, with how many places use it
 * (`components.ts` `componentUses`). Picking one opens it on the canvas, as clicking its reference card does. They are
 * listed by name; one the open draft added (Make component, Dev 2026-11-27) has a small yellow dot, "new in this draft".
 */
import { componentUses, isComponent } from "../engine/components";
import { groupsOf } from "../data/graph";
import { changeBase } from "../engine/changeMarks";
import { focusOn, G } from "../engine/state";
import { useLab } from "../store";

const ICON = '<path d="M12 3.5l8.5 8.5-8.5 8.5-8.5-8.5z"/>';

export function ComponentList({ onPick }: { onPick: () => void }) {
  const s = useLab();
  const groups = groupsOf(G());
  const ids = Object.keys(groups)
    .filter((id) => isComponent(groups, id))
    .sort((a, b) => groups[a].label.localeCompare(groups[b].label));
  if (ids.length === 0) return null;
  const base = changeBase();
  const baseGroups = base ? groupsOf(base.graph) : null;
  const uses = componentUses(G(), groups);
  return (
    <div className="archpages comps" id="componentList" role="group" aria-label="Components">
      <div className="comphd">Components</div>
      {ids.map((id) => {
        const n = uses[id]?.length ?? 0;
        const isNew = !!baseGroups && !baseGroups[id];
        return (
          <button
            key={id}
            className={"rowi archpage comp" + (isNew ? " newc" : "")}
            data-component={id}
            aria-current={s.view === "canvas" && s.cfocus === id}
            title={`${groups[id].label}: used in ${n} place${n === 1 ? "" : "s"}${isNew ? ", new in this draft" : ""}`}
            onClick={() => {
              onPick();
              focusOn(id);
            }}
          >
            <svg className="i ic" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICON }} />
            <span className="nm">{groups[id].label}</span>
            {isNew ? <span className="cdot" title="New in this draft" /> : null}
            <span className="tag">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

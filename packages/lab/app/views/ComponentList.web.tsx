/**
 * Components in the sidebar (Dev2, 2026-11-26: "a concept of components like figma has so we can reference something
 * and reuse it wherever it is"): under Architecture, every group marked `component: true`, with how many places use it
 * (`components.ts` `componentUses`). Picking one opens it on the canvas, as clicking its reference card does.
 */
import { componentUses, isComponent } from "../engine/components";
import { groupsOf } from "../data/graph";
import { focusOn, G } from "../engine/state";
import { useLab } from "../store";

const ICON = '<path d="M12 3.5l8.5 8.5-8.5 8.5-8.5-8.5z"/>';

export function ComponentList({ onPick }: { onPick: () => void }) {
  const s = useLab();
  const groups = groupsOf(G());
  const ids = Object.keys(groups).filter((id) => isComponent(groups, id));
  if (ids.length === 0) return null;
  const uses = componentUses(G(), groups);
  return (
    <div className="archpages comps" id="componentList" role="group" aria-label="Components">
      <div className="comphd">Components</div>
      {ids.map((id) => {
        const n = uses[id]?.length ?? 0;
        return (
          <button
            key={id}
            className="rowi archpage comp"
            data-component={id}
            aria-current={s.view === "canvas" && s.cfocus === id}
            title={`${groups[id].label}: used in ${n} place${n === 1 ? "" : "s"}`}
            onClick={() => {
              onPick();
              focusOn(id);
            }}
          >
            <svg className="i ic" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: ICON }} />
            <span className="nm">{groups[id].label}</span>
            <span className="tag">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

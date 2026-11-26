/**
 * The focus bar as a path (mockup 5y8sZpxqRYNZEdqqXTjq6J v3, Dev2 2026-11-16): "← Whole graph / Tools & subagents /
 * Checks ▾", each group around the focus a step back up, the focus last, on one line at any depth (long names cut
 * with "…", and the middle groups folded into one "…" past two). A group focused last has a ▾ that lists the
 * groups beside it (the same parent) with how many steps each holds, to hop between them. Esc goes up one level
 * (`focusUp`, `useStageInput.web.ts`).
 */
import { useState } from "react";
import { groupsOf } from "../../data/graph";
import { groupChain } from "../../engine/groups";
import { focusOn, node, stepsOf, unfocus } from "../../engine/state";
import type { LabGraph } from "../../types";

/** How many steps each group holds, nested groups' included. */
export function groupSizes(g: LabGraph): Record<string, number> {
  const groups = groupsOf(g);
  const out: Record<string, number> = {};
  for (const n of stepsOf(g).nodes) if (n.group) for (const id of groupChain(groups, n.group)) out[id] = (out[id] ?? 0) + 1;
  return out;
}

export function FocusPath({ g, id, opened }: { g: LabGraph; id: string; opened: boolean }) {
  const [open, setOpen] = useState(false);
  const groups = groupsOf(g);
  const sizes = groupSizes(g);
  const around = opened ? groupChain(groups, id).slice(1) : (() => {
    const own = node(id, g)?.group;
    return own ? groupChain(groups, own) : [];
  })();
  const path = [...around].reverse();
  // Deep in, the groups between the first and the one just around the focus fold into "…" (its title names them; a
  // press goes up to the nearest of them), so the path stays one line at any depth.
  const hidden = path.length > 2 ? path.slice(1, -1) : [];
  const shownPath = hidden.length ? [path[0]!, path[path.length - 1]!] : path;
  const label = opened ? (groups[id]?.label ?? id) : (node(id, g)?.label ?? id);
  const parent = opened ? groups[id]?.parent : undefined;
  const beside = opened ? Object.keys(groups).filter((k) => (groups[k]?.parent ?? undefined) === parent && (sizes[k] ?? 0) > 0) : [];
  const go = (to: string) => {
    setOpen(false);
    focusOn(to);
  };
  return (
    <span className="fpath">
      <button className="crumb" id="fbOut" title="The whole graph" onClick={unfocus}>
        ← Whole graph
      </button>
      {shownPath.map((p, i) => (
        <span key={p} className="fcrumb">
          {i === 1 && hidden.length ? (
            <>
              <span className="sep">/</span>
              <button className="crumb" data-crumb-more title={hidden.map((h) => groups[h]?.label ?? h).join(" / ")} onClick={() => go(hidden[hidden.length - 1]!)}>
                …
              </button>
            </>
          ) : null}
          <span className="sep">/</span>
          <button className="crumb" data-crumb={p} title={groups[p]?.label ?? p} onClick={() => go(p)}>
            {groups[p]?.label ?? p}
          </button>
        </span>
      ))}
      <span className="sep">/</span>
      {opened ? (
        <span className="fpick">
          <button className="cur" id="fbPick" aria-haspopup="menu" aria-expanded={open} title="Hop to another group" onClick={() => setOpen(!open)}>
            <b>{label}</b>
            <span className="gcnt">{sizes[id] ?? 0}</span>▾
          </button>
          {open ? (
            <span className="menu fmenu" role="menu">
              {beside.map((k) => (
                <button key={k} role="menuitem" data-hop={k} aria-current={k === id} onClick={() => go(k)}>
                  {groups[k]?.label ?? k}
                  <span className="gcnt">{sizes[k] ?? 0}</span>
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : (
        <b className="cur">{label}</b>
      )}
    </span>
  );
}

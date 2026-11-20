/**
 * The Architecture page: the canvas on top and the test chat under it (`SandboxChat.web.tsx`), whose running turn
 * lights the canvas step by step. While the dock plays a run, a pill on the canvas says what plays, and while it plays
 * the steps behind one of Tex's texts, every other step fades (Lab live sandbox mockup, Dev2 2026-11-16). A real
 * text's run draws the graph Tex had then, read only, and says so when that graph couldn't be read. A picked step's
 * panel is the mockup's card floating on the canvas's top right (`#props`), never a column of its own.
 */
import { Canvas } from "../Canvas.web";
import { playOnly, shownRun } from "../../engine/sandboxPlay";
import { SandboxChat, useSandboxLit } from "./SandboxChat.web";
import { DimOthers } from "./SandboxTimeline.web";
import { RunPill } from "./RunPill.web";
import { Props } from "../Props.web";
import { useLab } from "../../store";

export function ArchCanvas() {
  const s = useLab();
  const lit = useSandboxLit();
  // The step panel: the mockup's card floating on the canvas, at its top right, closed with its ×.
  const card = s.sel !== null;
  const wide = card && !!s.cfocus && s.sel?.t === "node" && s.sel.id === s.cfocus;
  const only = playOnly();
  const run = shownRun();
  return (
    <div className="archsplit">
      <div className={"archcv" + (only ? " only" : "") + (run?.graph ? " then" : "") + (card ? " withcard" : "")}>
        <Canvas
          testLit={lit}
          graph={run?.graph ?? null}
          lead={
            <>
              <RunPill />
              {run?.graphNote ? (
                <div className="float runnote" id="runNote" role="note">
                  {run.graphNote}
                </div>
              ) : null}
            </>
          }
        />
        <DimOthers only={only} />
        <aside className={"float ins" + (wide ? " wide" : "")} id="props" aria-label="Properties" hidden={!card}>
          {card ? (
            <div className="insbd">
              <Props />
            </div>
          ) : null}
        </aside>
      </div>
      <SandboxChat />
    </div>
  );
}

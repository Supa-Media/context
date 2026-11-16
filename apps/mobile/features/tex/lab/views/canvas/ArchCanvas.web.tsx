/**
 * The Architecture page: the canvas on top and the test chat under it (`SandboxChat.web.tsx`), whose running turn
 * lights the canvas step by step. While the dock plays a run, a pill on the canvas says what plays, and while it plays
 * the steps behind one of Tex's texts, every other step fades (Lab live sandbox mockup, Dev2 2026-11-16). A real
 * text's run draws the graph Tex had then, read only, and says so when that graph couldn't be read.
 */
import { Canvas } from "../Canvas.web";
import { playOnly, shownRun } from "../../engine/sandboxPlay";
import { SandboxChat, useSandboxLit } from "./SandboxChat.web";
import { DimOthers } from "./SandboxTimeline.web";
import { RunPill } from "./RunPill.web";

export function ArchCanvas() {
  const lit = useSandboxLit();
  const only = playOnly();
  const run = shownRun();
  return (
    <div className="archsplit">
      <div className={"archcv" + (only ? " only" : "") + (run?.graph ? " then" : "")}>
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
      </div>
      <SandboxChat />
    </div>
  );
}

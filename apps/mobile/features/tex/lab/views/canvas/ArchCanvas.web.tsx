/**
 * The Architecture page: the canvas on top and the test chat under it (`SandboxChat.web.tsx`), whose running turn
 * lights the canvas step by step. While the dock plays a run, a pill on the canvas says what plays, and while it plays
 * the steps behind one of Tex's texts, every other step fades (Lab live sandbox mockup, Dev2 2026-11-16).
 */
import { Canvas } from "../Canvas.web";
import { playOnly } from "../../engine/sandboxPlay";
import { SandboxChat, useSandboxLit } from "./SandboxChat.web";
import { DimOthers, RunPill } from "./SandboxTimeline.web";

export function ArchCanvas() {
  const lit = useSandboxLit();
  const only = playOnly();
  return (
    <div className="archsplit">
      <div className={"archcv" + (only ? " only" : "")}>
        <Canvas testLit={lit} />
        <RunPill />
        <DimOthers only={only} />
      </div>
      <SandboxChat />
    </div>
  );
}

/**
 * The Architecture page: the canvas on top and the test chat under it (`SandboxChat.web.tsx`), whose running turn
 * lights the canvas step by step.
 */
import { Canvas } from "../Canvas.web";
import { SandboxChat, useSandboxLit } from "./SandboxChat.web";

export function ArchCanvas() {
  const lit = useSandboxLit();
  return (
    <div className="archsplit">
      <div className="archcv">
        <Canvas testLit={lit} />
      </div>
      <SandboxChat />
    </div>
  );
}

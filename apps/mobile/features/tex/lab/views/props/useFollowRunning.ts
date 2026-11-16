/**
 * The step panel follows whichever step is running in the playing or live test text (Lab live sandbox mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5), until a node is clicked (`lab.pin`); "Follow running" in the
 * panel lets go of the pin. The selection is the one any click makes, so a playback that sets it drives the panel the
 * same way.
 */
import { useEffect } from "react";
import { usePlay } from "../../engine/sandboxPlay";
import { useSandbox } from "../../engine/sandbox";
import { runningNode } from "../../engine/stepRunNow";
import { G, lab, set } from "../../engine/state";
import { useLab } from "../../store";
import { isLineStep } from "../../engine/lineSteps";

export function useFollowRunning() {
  useLab();
  useSandbox();
  const { play } = usePlay();
  const id = lab.pin || lab.mode !== "lab" ? null : runningNode(play);
  useEffect(() => {
    if (!id || lab.pin || (lab.sel?.t === "node" && lab.sel.id === id)) return;
    // The test chat's line is followed too: its card shows what the line did (`LinePanel.web.tsx`).
    if (G().nodes.some((n) => n.id === id) || isLineStep(id)) set({ sel: { t: "node", id } });
  }, [id]);
}

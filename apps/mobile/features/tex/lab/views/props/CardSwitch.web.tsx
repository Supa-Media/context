/**
 * The step panel's top row (Lab live sandbox mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): the switch between
 * the "Run details" and "Settings" cards, a small yellow dot on Settings when the step changed in this draft, and the
 * chip that says the panel follows the running step ("● Following") or, once a node is clicked, brings it back
 * ("Follow running").
 */
import { runningNode } from "../../engine/stepRunNow";
import { usePlay } from "../../engine/sandboxPlay";
import { G, lab, set } from "../../engine/state";

export function CardSwitch({ card, changed }: { card: "run" | "set"; changed: boolean }) {
  const { play } = usePlay();
  const pinned = lab.pin;
  const target = runningNode(play);
  return (
    <div className="cardrow">
      <div className="cardsw" role="group" aria-label="Card">
        <button id="cardRun" data-card="run" aria-pressed={card === "run"} onClick={() => set({ card: "run" })}>
          Run details
        </button>
        <button id="cardSet" data-card="set" aria-pressed={card === "set"} onClick={() => set({ card: "set" })}>
          Settings
          {changed ? <span className="cd" id="cardDot" title="Changed in this draft" /> : null}
        </button>
      </div>
      <button
        id="insFollow"
        className={"ghost follow" + (pinned ? "" : " on")}
        title={pinned ? "Go back to following the step that is running" : "Shows whichever step is running; click a node to pin it"}
        onClick={() => {
          if (!pinned) return set({ pin: true });
          set(target && G().nodes.some((n) => n.id === target) ? { pin: false, sel: { t: "node", id: target } } : { pin: false });
        }}
      >
        {pinned ? "Follow running" : "● Following"}
      </button>
    </div>
  );
}

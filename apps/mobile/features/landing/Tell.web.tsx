import { useEffect, useState, type CSSProperties } from "react";
import { useReducedMotion } from "../design/useReducedMotion";
import { TELL_NAMES, tellPair, tellSentence, tellSteps, type TellSlot } from "./tell";

/**
 * The landing pages' one sentence, "Tell Claude. ChatGPT already knows.",
 * with each name set in its AI's own colour beside the robot the map draws
 * it as, and retyped in turn by a caret of that colour (`tell.ts`).
 *
 * The heading a screen reader hears is the first sentence, still; the
 * retyping is drawn beside it and hidden from assistive tech, so nothing
 * announces a name every few seconds. With reduced motion the first sentence
 * simply stays.
 */
export function Tell({ className }: { className?: string }) {
  const slots = useTellSlots();
  return (
    <h1 className={`lp-tell ${className ?? ""}`}>
      <span className="lp-sr">{tellSentence(0)}</span>
      <span className="lp-tell-v" aria-hidden>
        <span className="lp-tell-l">
          Tell <Name slot={slots[0]} ink />.
        </span>{" "}
        <span className="lp-tell-l">
          <Name slot={slots[1]} /> <span className="lp-tell-ak">already knows<span className="lp-sq" /></span>
        </span>
      </span>
    </h1>
  );
}

/** A name: the robot tile, the letters typed so far, and the caret while it is being typed. */
function Name({ slot, ink = false }: { slot: TellSlot; ink?: boolean }) {
  const name = TELL_NAMES[slot.ai];
  const style = { "--c": `var(--ai-${slot.ai})` } as CSSProperties;
  return (
    <span className="lp-nm" style={style}>
      <Robot key={slot.ai} />
      <span className="lp-nm-t">
        {name.slice(0, slot.typed)}
        {slot.caret ? <span className="lp-caret" /> : null}
        {ink && slot.typed === name.length && !slot.caret ? <Ink key={slot.ai} /> : null}
      </span>
    </span>
  );
}

/** The map's robot (`console/map/live/engine/draw/primitives.ts`) on a tile of the AI's colour. */
export function Robot({ className = "lp-bot" }: { className?: string }) {
  return (
    <span className={className}>
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--glyph)" strokeWidth={2.2} strokeLinecap="round">
        <rect x={4.5} y={8} width={15} height={12} rx={3.3} />
        <path d="M12 4.6V8M2.4 12.3V16M21.6 12.3V16" />
        <circle cx={12} cy={3.4} r={1.4} fill="var(--glyph)" stroke="none" />
        <circle cx={9.2} cy={13.9} r={1.7} fill="var(--glyph)" stroke="none" />
        <circle cx={14.8} cy={13.9} r={1.7} fill="var(--glyph)" stroke="none" />
      </svg>
    </span>
  );
}

/** A pen stroke under the name, drawn once each time a name is finished. */
function Ink() {
  return (
    <svg className="lp-ink" viewBox="0 0 100 10" preserveAspectRatio="none">
      <path d="M2 6.5C22 2.8 48 2.6 70 4.6S94 7.4 98 3.6" pathLength={1} />
    </svg>
  );
}

/** Walks `tellSteps` with timers, pair after pair, pausing while the tab is hidden. */
function useTellSlots(): readonly [TellSlot, TellSlot] {
  const reduced = useReducedMotion();
  const [slots, setSlots] = useState<readonly [TellSlot, TellSlot]>(() => {
    const [a, b] = tellPair(0);
    return [
      { ai: a, typed: TELL_NAMES[a].length, caret: false },
      { ai: b, typed: TELL_NAMES[b].length, caret: false },
    ];
  });
  useEffect(() => {
    if (reduced) return;
    let pair = 0;
    let steps = tellSteps(pair);
    let at = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, 500);
        return;
      }
      const step = steps[at];
      setSlots(step.slots);
      at += 1;
      if (at >= steps.length) {
        pair += 1;
        steps = tellSteps(pair);
        at = 0;
      }
      timer = setTimeout(tick, step.ms);
    };
    tick();
    return () => clearTimeout(timer);
  }, [reduced]);
  return slots;
}


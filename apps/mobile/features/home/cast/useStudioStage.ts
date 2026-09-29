import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { createCastClock, type CastClock } from "./castClock";
import { asStudioCommand, isStudioStage, stageEvent, type StageEvent } from "./studioLink";

/** How often a playing stage tells the studio the show's time. */
const TIME_EVERY_MS = 200;

export interface StudioStage {
  /**
   * Set once the studio says start: the step to play live from, and the
   * show's clock, made then so its time is the show's from its first moment.
   */
  start: { from: number; clock: CastClock } | null;
  /** `CastHost.step` and `ended`, told to the studio. */
  step: (index: number) => void;
  ended: () => void;
}

/**
 * This homepage as the cast studio's stage, or `null` for every other visit.
 *
 * A stage says it is ready, then waits: the show starts when the studio says
 * so, which is how Record gets its quiet count before anything moves. From
 * then it reports each step and, while playing, the show's time. See
 * `studioLink.ts` for why only our own studio can make a page a stage.
 */
export function useStudioStage(): StudioStage | null {
  const [isStage] = useState(() => Platform.OS === "web" && typeof window !== "undefined" && isStudioStage(window));
  const [start, setStart] = useState<{ from: number; clock: CastClock } | null>(null);
  // The clock the message handler pauses, which is the one `start` holds.
  const clock = useRef<CastClock | null>(null);

  useEffect(() => {
    if (!isStage) return;
    const origin = window.location.origin;
    const tell = (event: StageEvent) => window.parent.postMessage(event, origin);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      const command = asStudioCommand(event.data);
      if (command === null) return;
      if (command.kind === "start") {
        // Once a page: starting again is a fresh page, which the studio makes.
        if (clock.current !== null) return;
        clock.current = createCastClock();
        setStart({ from: command.from, clock: clock.current });
      } else if (command.kind === "pause") clock.current?.pause();
      else clock.current?.resume();
    };
    window.addEventListener("message", onMessage);
    tell(stageEvent({ kind: "ready" }));
    return () => {
      window.removeEventListener("message", onMessage);
      clock.current?.stop();
    };
  }, [isStage]);

  useEffect(() => {
    if (!isStage || start === null) return;
    const origin = window.location.origin;
    const timer = setInterval(() => {
      if (!start.clock.paused) window.parent.postMessage(stageEvent({ kind: "time", ms: start.clock.now() }), origin);
    }, TIME_EVERY_MS);
    return () => clearInterval(timer);
  }, [isStage, start]);

  return useMemo(() => {
    if (!isStage) return null;
    const origin = window.location.origin;
    return {
      start,
      step: (index: number) => window.parent.postMessage(stageEvent({ kind: "step", index }), origin),
      ended: () => window.parent.postMessage(stageEvent({ kind: "ended" }), origin),
    };
  }, [isStage, start]);
}

import { useEffect, useState } from "react";
import { View } from "react-native";
import { Tex } from "../../chaos/Tex";
import { useReducedMotion } from "../../design/useReducedMotion";

/** One sine period of the working mark, in seconds. */
const PERIOD_S = 1.6;
/** How often the mark is redrawn while busy. */
const FRAME_MS = 60;
/** The swing of the mark while busy: calm at 0, out to this chaos score at the peak. */
const PEAK = 70;

/**
 * Tex the mascot, shown while Tex is working on a long background job.
 *
 * The app has no earlier animation of Tex to reuse (every other surface draws
 * it at chaos 0), so the swing is here: chaos rises from 0 to `PEAK` and back
 * on a sine, every `FRAME_MS` while `busy`, and rests at 0 when idle. Under
 * reduced motion it never moves. Decorative, so the screen reader skips it.
 */
export function TexWorkingMark({ busy, size = 26 }: { busy: boolean; size?: number }) {
  const reduced = useReducedMotion();
  const [chaos, setChaos] = useState(0);

  useEffect(() => {
    if (!busy || reduced) {
      setChaos(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      const phase = ((Date.now() - start) / 1000 / PERIOD_S) * 2 * Math.PI;
      setChaos(Math.round((PEAK / 2) * (1 - Math.cos(phase)) * 10) / 10);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [busy, reduced]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      style={{ width: size, height: size }}
    >
      <Tex chaos={chaos} size={size} />
    </View>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two presses for something that cannot be taken back — and the second press
 * expires.
 *
 * ## Why a hook rather than a third copy
 *
 * The pattern was written twice, in `ConnectionsPane`'s delete-account card and
 * `MembersSection`'s remove-member row, and both were `useState<"idle" |
 * "armed" | "working">` with no way back to `idle`. Arm it, get distracted, and
 * the next press lands minutes later — by you, or by whoever picks the phone
 * up. A destructive control with an unbounded arming window is a destructive
 * control with one press, taken at a moment nobody chose.
 *
 * `ContextRowMenu` got this right and only by accident: its menu unmounts on
 * Escape or an outside press, so the window closes with the sheet. That is the
 * behaviour, not the mechanism, and it should not depend on where the control
 * happens to live.
 *
 * ## Why a timer and not focus
 *
 * "Disarm when the control loses focus" is the desktop answer and does not
 * survive the crossing: a phone has no hover, `onBlur` on a `Pressable` fires
 * for reasons that have nothing to do with attention, and a soft keyboard
 * opening moves focus on its own. A clock is the same on both platforms and is
 * the thing actually being modelled — *this offer is a few seconds old, and an
 * older one should not still be live.*
 *
 * Unmounting disarms too, through the effect's cleanup, so navigating away
 * cannot leave an armed control behind to be found later.
 */

/**
 * How long the second press stays available.
 *
 * Long enough to read the changed label and act on it, short enough that it
 * cannot survive putting the phone down. Exported so the test asserts the same
 * number the hook uses rather than a copy of it.
 */
export const ARMED_MS = 5_000;

export type ArmingStage = "idle" | "armed" | "working";

export interface Arming {
  stage: ArmingStage;
  /** Arms on the first press, runs on the second. */
  press: () => void;
  /** Put the offer away — a Cancel, or a dismissed sheet. */
  disarm: () => void;
}

export function useArming(run: () => void | Promise<void>): Arming {
  const [stage, setStage] = useState<ArmingStage>("idle");
  /*
    The same value as `stage`, readable *now*.

    A double tap — or one press on a device slow enough to render between the
    two — must not see `idle` twice and arm twice instead of arming and then
    firing. State cannot answer that: the second handler runs before React has
    re-rendered. A ref can, and unlike deciding inside the `setStage` updater it
    leaves `run()` on the synchronous path, which is where a caller's own
    "Deleting…" state and every test expect it.
  */
  const stageRef = useRef<ArmingStage>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const move = useCallback((next: ArmingStage) => {
    stageRef.current = next;
    setStage(next);
  }, []);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Also covers navigating away mid-arm: the cleanup runs on unmount.
  useEffect(() => clear, [clear]);

  const disarm = useCallback(() => {
    clear();
    if (stageRef.current === "armed") move("idle");
  }, [clear, move]);

  const press = useCallback(() => {
    if (stageRef.current === "working") return;

    if (stageRef.current === "idle") {
      clear();
      move("armed");
      timer.current = setTimeout(() => {
        timer.current = null;
        if (stageRef.current === "armed") move("idle");
      }, ARMED_MS);
      return;
    }

    clear();
    move("working");
    void run();
  }, [clear, move, run]);

  return { stage, press, disarm };
}

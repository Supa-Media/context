import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StudioPlayer } from "../useStudioPlayer";
import { soundItems, soundPlan, type SoundPlan } from "./castSounds";
import { createSoundPlayer, type SoundPlayer } from "./soundPlayer";

/** Writes the scene note's `sounds:` list (`null` removes it); why not, or `null`. */
export type SaveSounds = (items: string[] | null) => string | null;

export interface StudioSounds {
  plan: SoundPlan;
  /** Choose, and save to the note when it can be. */
  change: (next: SoundPlan) => void;
  /** Play one sound now, for the Hear buttons. */
  hear: (id: string, volume: number) => void;
  /** Whether a change is kept in the note, or only until the studio closes. */
  saves: boolean;
  /** Why the last change could not be saved. */
  problem: string | null;
}

/**
 * The scene's sounds: read from the note, played at the stage's cues, and
 * written back when they are changed.
 *
 * The note is the truth. A change shows at once and goes into the note
 * through the editor (so it saves and merges like a keystroke); when the
 * note's `sounds:` changes from anywhere else, the studio follows it.
 */
export function useStudioSounds(draft: string, player: StudioPlayer, save: SaveSounds | undefined): StudioSounds {
  const saved = useMemo(() => soundPlan(draft), [draft]);
  const savedKey = JSON.stringify(soundItems(saved));
  const [plan, setPlan] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const sound = useRef<SoundPlayer | null>(null);
  const speaker = useCallback(() => (sound.current ??= createSoundPlayer()), []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the note's list, not every keystroke
  useEffect(() => setPlan(saved), [savedKey]);

  useEffect(() => {
    const cues = player.onCue;
    cues.current = (moment) => {
      const current = planRef.current;
      const choice = current.moments[moment];
      if (!current.on || choice.sound === "off") return;
      speaker().play(choice.sound, choice.volume, { typing: moment === "typing" });
    };
    return () => {
      cues.current = null;
    };
  }, [player.onCue, speaker]);

  useEffect(
    () => () => {
      sound.current?.close();
      sound.current = null;
    },
    [],
  );

  return {
    plan,
    change: (next) => {
      setPlan(next);
      setProblem(save?.(soundItems(next)) ?? null);
    },
    hear: (id, volume) => speaker().play(id, volume),
    saves: save !== undefined,
    problem,
  };
}

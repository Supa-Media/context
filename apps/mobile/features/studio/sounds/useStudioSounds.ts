import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_SCENE_SOUND_BYTES } from "@context/shared/src/sceneSounds";
import type { CastMoment } from "../../home/cast/castRun";
import type { StudioPlayer } from "../useStudioPlayer";
import { isUploadedSound, soundItems, soundPlan, type SoundPlan } from "./castSounds";
import { createSoundPlayer, type SoundPlayer } from "./soundPlayer";

/** Writes the scene note's `sounds:` list (`null` removes it); why not, or `null`. */
export type SaveSounds = (items: string[] | null) => string | null;

/**
 * The workspace's own asset store, as the note's images use it: keep a file
 * (answering with its stored name), and read one back for the open note.
 */
export interface SoundStorage {
  store?: (file: { bytes: ArrayBuffer; contentType: string }) => Promise<{ target: string } | { error: string }>;
  /** The stored file as a `data:` address, or `null` when it cannot be read. */
  load: (leaf: string) => Promise<string | null>;
}

export interface StudioSounds {
  plan: SoundPlan;
  /** Choose, and save to the note when it can be. */
  change: (next: SoundPlan) => void;
  /** Play one sound now, for the Hear buttons. */
  hear: (id: string, volume: number) => void;
  /** Keep a sound file for `moment` and choose it; absent where nothing can be kept. */
  upload?: (moment: CastMoment, file: File) => Promise<void>;
  /** A moment whose upload is on its way. */
  uploading: CastMoment | null;
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
 * note's `sounds:` changes from anywhere else, the studio follows it. An
 * uploaded sound is fetched once, for the note that names it, and played from
 * memory after that.
 */
export function useStudioSounds(
  draft: string,
  player: StudioPlayer,
  save: SaveSounds | undefined,
  storage?: SoundStorage,
): StudioSounds {
  const saved = useMemo(() => soundPlan(draft), [draft]);
  const savedKey = JSON.stringify(soundItems(saved));
  const [plan, setPlan] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState<CastMoment | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const sound = useRef<SoundPlayer | null>(null);
  const speaker = useCallback(() => (sound.current ??= createSoundPlayer()), []);
  // Uploaded sounds, decoded; `null` once one could not be read.
  const buffers = useRef(new Map<string, AudioBuffer | null>());

  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the note's list, not every keystroke
  useEffect(() => setPlan(saved), [savedKey]);

  const choose = useCallback((next: SoundPlan) => {
    setPlan(next);
    setProblem(save?.(soundItems(next)) ?? null);
  }, [save]);

  // Fetch each uploaded sound the scene names, once.
  const load = storage?.load;
  useEffect(() => {
    if (load === undefined) return;
    for (const choice of Object.values(plan.moments)) {
      const leaf = choice.sound;
      if (!isUploadedSound(leaf) || buffers.current.has(leaf)) continue;
      buffers.current.set(leaf, null);
      void (async () => {
        const address = await load(leaf);
        if (address === null) return;
        const bytes = await (await fetch(address)).arrayBuffer();
        buffers.current.set(leaf, await speaker().decode(bytes));
      })().catch(() => {});
    }
  }, [plan, load, speaker]);

  const sounding = useCallback(
    (id: string, volume: number, typing = false) => {
      if (isUploadedSound(id)) {
        const buffer = buffers.current.get(id);
        if (buffer) speaker().playBuffer(buffer, volume, { typing });
        return;
      }
      speaker().play(id, volume, { typing });
    },
    [speaker],
  );

  useEffect(() => {
    const cues = player.onCue;
    cues.current = (moment) => {
      const current = planRef.current;
      const choice = current.moments[moment];
      if (!current.on || choice.sound === "off") return;
      sounding(choice.sound, choice.volume, moment === "typing");
    };
    return () => {
      cues.current = null;
    };
  }, [player.onCue, sounding]);

  useEffect(
    () => () => {
      sound.current?.close();
      sound.current = null;
    },
    [],
  );

  const store = storage?.store;
  const upload =
    store === undefined || save === undefined
      ? undefined
      : async (moment: CastMoment, file: File) => {
          if (file.size > MAX_SCENE_SOUND_BYTES) {
            setProblem(`That file is too big. A sound can be at most ${MAX_SCENE_SOUND_BYTES / 1_000_000} MB.`);
            return;
          }
          setUploading(moment);
          try {
            const bytes = await file.arrayBuffer();
            // Every sound is stored as a sound: the server reads the bytes to say which kind.
            const stored = await store({ bytes, contentType: file.type.startsWith("audio/") ? file.type : "audio/*" });
            if ("error" in stored) {
              setProblem(stored.error);
              return;
            }
            const decoded = await speaker().decode(bytes);
            buffers.current.set(stored.target, decoded);
            const current = planRef.current;
            choose({ ...current, moments: { ...current.moments, [moment]: { ...current.moments[moment], sound: stored.target } } });
            if (decoded !== null) speaker().playBuffer(decoded, current.moments[moment].volume);
            else setProblem("That sound was kept, but this browser can’t play it.");
          } finally {
            setUploading(null);
          }
        };

  return {
    plan,
    change: choose,
    hear: (id, volume) => sounding(id, volume),
    upload,
    uploading,
    saves: save !== undefined,
    problem,
  };
}

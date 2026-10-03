import { SCENE_SOUND_LEAF } from "@context/shared/src/sceneSounds";
import { noteProperties } from "../../../../mcp/src/lists.js";
import { CAST_MOMENTS, type CastMoment } from "../../home/cast/castRun";
import { BUILT_IN_SOUNDS, type BuiltInSound } from "./synth";

/**
 * Which sound each moment of a scene makes, kept in the scene note itself.
 *
 * Dev2's picks (2026-09-29): a built-in set to choose from for every moment,
 * with Off and a volume, one sound per kind of moment for the whole scene, kept
 * in the note's front matter so it travels with the scene. A sound somebody
 * uploaded is named by its stored leaf (`sound-<hash>.wav`), which is also what
 * lets the note vouch for reading it back.
 *
 * The front matter is one line, a list the Properties panel and a folder list
 * already read and write (`setNoteProperty`), and it names only what differs
 * from the defaults, so a scene nobody has tuned has no `sounds:` at all:
 *
 *     sounds: [comment bell 70%, typing off, all off]
 *
 * Anything that does not read as a moment and a sound we know is ignored
 * rather than refused: the note is somebody's text, and a typo in it must not
 * silence the scene or stop the studio opening.
 */

export const SOUNDS_PROPERTY = "sounds";

/** A moment's volume, in percent, when the note does not say. */
export const DEFAULT_VOLUME = 80;

export interface SoundChoice {
  /** A built-in sound's id, an uploaded sound's leaf, or `"off"`. */
  sound: string;
  /** 0 to 100. */
  volume: number;
}

export interface SoundPlan {
  /** False when the scene is muted as a whole ("all off"). */
  on: boolean;
  moments: Record<CastMoment, SoundChoice>;
}

export const MOMENT_LABELS: Record<CastMoment, string> = {
  join: "Someone joins",
  agent: "Agent pops in",
  typing: "Typing",
  writes: "Agent writes",
  click: "Clicking a face",
  comment: "Comment sent",
  resolve: "Comment resolved",
  note: "New note appears",
  error: "Assistant gives up",
};

/** The built-in sounds offered for each moment, the default first. */
export const MOMENT_SOUNDS: Record<CastMoment, readonly string[]> = {
  join: ["knock", "doorbell", "whoosh", "pluck", "hello"],
  agent: ["pop", "sparkle", "blip", "bubble", "rise"],
  typing: ["keys", "soft-keys", "typewriter", "clicks", "pencil"],
  writes: ["shimmer", "swoosh", "rise", "sparkle", "ding"],
  click: ["tap", "click", "tick", "thud", "snap"],
  comment: ["chime", "pop", "bell", "soft-tick", "ding"],
  resolve: ["tick", "check", "two-note", "bell", "pluck"],
  note: ["paper", "swish", "flip", "drop", "pop"],
  error: ["buzz", "uh-oh", "bonk", "denied", "thud"],
};

export function defaultPlan(): SoundPlan {
  return {
    on: true,
    moments: Object.fromEntries(
      CAST_MOMENTS.map((moment) => [moment, { sound: MOMENT_SOUNDS[moment][0]!, volume: DEFAULT_VOLUME }]),
    ) as Record<CastMoment, SoundChoice>,
  };
}

/** Whether a choice is a sound somebody uploaded (its stored leaf). */
export function isUploadedSound(id: string): boolean {
  return SCENE_SOUND_LEAF.test(id);
}

export function soundLabel(id: string): string {
  if (id === "off") return "Off";
  if (isUploadedSound(id)) return "Your sound";
  return (BUILT_IN_SOUNDS as Record<string, BuiltInSound | undefined>)[id]?.label ?? id;
}

const ITEM = /^([a-z]+)\s+([a-z][a-z0-9.-]*)(?:\s+(\d{1,3})%)?$/;

/** The scene's sounds, from the whole note (front matter and all). */
export function soundPlan(note: string): SoundPlan {
  const plan = defaultPlan();
  const value = (noteProperties(note) as Record<string, string | string[] | undefined>)[SOUNDS_PROPERTY];
  const items = value === undefined ? [] : Array.isArray(value) ? value : [value];
  for (const raw of items) {
    const match = ITEM.exec(raw.trim().toLowerCase());
    if (match === null) continue;
    const [, name, sound, volume] = match;
    if (name === "all") {
      if (sound === "off") plan.on = false;
      continue;
    }
    if (!(CAST_MOMENTS as readonly string[]).includes(name!)) continue;
    const moment = name as CastMoment;
    if (sound !== "off" && !(sound! in BUILT_IN_SOUNDS) && !isUploadedSound(sound!)) continue;
    plan.moments[moment] = {
      sound: sound!,
      volume: volume === undefined ? DEFAULT_VOLUME : Math.min(100, Number(volume)),
    };
  }
  return plan;
}

/** The `sounds:` list for a plan: only what differs from the defaults, or `null` for none. */
export function soundItems(plan: SoundPlan): string[] | null {
  const defaults = defaultPlan();
  const items: string[] = [];
  for (const moment of CAST_MOMENTS) {
    const choice = plan.moments[moment];
    const plain = defaults.moments[moment];
    if (choice.sound === plain.sound && choice.volume === plain.volume) continue;
    items.push(
      choice.sound === "off" || choice.volume === DEFAULT_VOLUME
        ? `${moment} ${choice.sound}`
        : `${moment} ${choice.sound} ${Math.round(choice.volume)}%`,
    );
  }
  if (!plan.on) items.push("all off");
  return items.length === 0 ? null : items;
}

/** How often a moment happens, in words: "1 time", "3 times", "not in this scene". */
export function momentCount(count: number): string {
  if (count === 0) return "not in this scene";
  return count === 1 ? "1 time" : `${count} times`;
}

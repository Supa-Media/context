/**
 * The studio's built-in sounds, made in code.
 *
 * Dev2 asked for a built-in set that ships with the app (2026-09-29). Each
 * sound here is a recipe of a few voices, a tone or a burst of filtered
 * noise, played with Web Audio at the moment it is needed. Nothing is
 * downloaded and nothing is licensed from anyone: the whole set is this file.
 *
 * A recipe is data so a test can hold every sound to being short and quiet
 * enough to sit under a scene, and `soundPlayer.ts` is what turns it into
 * sound.
 */

export type Wave = "sine" | "triangle" | "square" | "sawtooth";

export type Voice =
  /** A pitch, sliding from `hz` to `to` when given. */
  | { kind: "tone"; wave: Wave; hz: number; to?: number; at: number; dur: number; gain: number }
  /** Noise through a band-pass filter centred at `hz`, sliding to `to`. */
  | { kind: "noise"; hz: number; to?: number; q: number; at: number; dur: number; gain: number };

export interface BuiltInSound {
  label: string;
  voices: readonly Voice[];
}

const tone = (wave: Wave, hz: number, at: number, dur: number, gain: number, to?: number): Voice => ({
  kind: "tone",
  wave,
  hz,
  to,
  at,
  dur,
  gain,
});
const noise = (hz: number, q: number, at: number, dur: number, gain: number, to?: number): Voice => ({
  kind: "noise",
  hz,
  to,
  q,
  at,
  dur,
  gain,
});

export const BUILT_IN_SOUNDS = {
  // Someone joins
  knock: { label: "Knock", voices: [noise(180, 1, 0, 0.07, 0.9), tone("sine", 110, 0, 0.08, 0.5), noise(180, 1, 0.15, 0.07, 0.8), tone("sine", 105, 0.15, 0.08, 0.45)] },
  doorbell: { label: "Doorbell", voices: [tone("triangle", 659, 0, 0.35, 0.35), tone("triangle", 523, 0.28, 0.5, 0.35)] },
  whoosh: { label: "Whoosh", voices: [noise(500, 0.8, 0, 0.4, 0.6, 2400)] },
  pluck: { label: "Pluck", voices: [tone("triangle", 440, 0, 0.28, 0.45), tone("sine", 880, 0, 0.12, 0.15)] },
  hello: { label: "Hello", voices: [tone("sine", 523, 0, 0.14, 0.35, 659), tone("sine", 784, 0.12, 0.3, 0.3)] },
  // Agent pops in
  pop: { label: "Pop", voices: [tone("sine", 380, 0, 0.09, 0.55, 920)] },
  sparkle: { label: "Sparkle", voices: [tone("triangle", 1568, 0, 0.18, 0.18), tone("triangle", 2093, 0.05, 0.18, 0.16), tone("triangle", 2637, 0.1, 0.22, 0.14)] },
  blip: { label: "Blip", voices: [tone("square", 880, 0, 0.06, 0.12)] },
  bubble: { label: "Bubble", voices: [tone("sine", 300, 0, 0.13, 0.45, 1200)] },
  rise: { label: "Rise", voices: [tone("sine", 330, 0, 0.35, 0.3, 990)] },
  // Typing
  keys: { label: "Keys", voices: [noise(3000, 2, 0, 0.025, 0.5)] },
  "soft-keys": { label: "Soft keys", voices: [noise(1800, 1, 0, 0.03, 0.3)] },
  typewriter: { label: "Typewriter", voices: [noise(2500, 1.5, 0, 0.02, 0.6), tone("square", 1800, 0, 0.01, 0.06)] },
  clicks: { label: "Clicks", voices: [tone("square", 2400, 0, 0.008, 0.1)] },
  pencil: { label: "Pencil", voices: [noise(5000, 0.7, 0, 0.05, 0.25)] },
  // Agent writes
  shimmer: { label: "Shimmer", voices: [tone("sine", 1047, 0, 0.5, 0.15), tone("sine", 1319, 0.06, 0.5, 0.13), tone("sine", 1568, 0.12, 0.55, 0.12)] },
  swoosh: { label: "Swoosh", voices: [noise(400, 0.9, 0, 0.35, 0.55, 3000)] },
  ding: { label: "Ding", voices: [tone("sine", 1319, 0, 0.7, 0.3), tone("sine", 2637, 0, 0.25, 0.06)] },
  // Clicking a face
  tap: { label: "Tap", voices: [noise(1200, 1.5, 0, 0.02, 0.5), tone("sine", 600, 0, 0.03, 0.2)] },
  click: { label: "Click", voices: [tone("square", 1500, 0, 0.012, 0.15)] },
  tick: { label: "Tick", voices: [tone("sine", 2000, 0, 0.035, 0.35)] },
  thud: { label: "Thud", voices: [tone("sine", 120, 0, 0.16, 0.7, 60)] },
  snap: { label: "Snap", voices: [noise(3500, 4, 0, 0.03, 0.7)] },
  // Comment sent
  chime: { label: "Chime", voices: [tone("sine", 880, 0, 0.5, 0.3), tone("sine", 1319, 0.09, 0.6, 0.25)] },
  bell: { label: "Bell", voices: [tone("sine", 988, 0, 0.9, 0.3), tone("sine", 2466, 0, 0.4, 0.08)] },
  "soft-tick": { label: "Soft tick", voices: [tone("sine", 1500, 0, 0.04, 0.2)] },
  // Comment resolved
  check: { label: "Check", voices: [tone("sine", 660, 0, 0.1, 0.3), tone("sine", 990, 0.08, 0.2, 0.3)] },
  "two-note": { label: "Two notes", voices: [tone("triangle", 523, 0, 0.16, 0.35), tone("triangle", 784, 0.12, 0.3, 0.35)] },
  // New note appears
  paper: { label: "Paper", voices: [noise(3000, 0.8, 0, 0.18, 0.4), noise(1500, 0.8, 0.08, 0.12, 0.3)] },
  swish: { label: "Swish", voices: [noise(1500, 1, 0, 0.22, 0.45, 5000)] },
  flip: { label: "Flip", voices: [noise(2500, 1.2, 0, 0.04, 0.5), noise(2000, 1.2, 0.07, 0.04, 0.45)] },
  drop: { label: "Drop", voices: [tone("sine", 900, 0, 0.16, 0.4, 300)] },
  // Assistant gives up
  buzz: { label: "Buzz", voices: [tone("sawtooth", 185, 0, 0.16, 0.22), tone("square", 196, 0, 0.16, 0.08), tone("sawtooth", 185, 0.22, 0.26, 0.22), tone("square", 196, 0.22, 0.26, 0.08)] },
  "uh-oh": { label: "Uh-oh", voices: [tone("triangle", 587, 0, 0.16, 0.38), tone("triangle", 440, 0.18, 0.34, 0.38, 415)] },
  bonk: { label: "Bonk", voices: [tone("sine", 320, 0, 0.22, 0.55, 110), noise(900, 2, 0, 0.05, 0.35)] },
  denied: { label: "Denied", voices: [tone("square", 311, 0, 0.32, 0.1), tone("square", 330, 0, 0.32, 0.1), tone("sine", 155, 0, 0.32, 0.35)] },
} satisfies Record<string, BuiltInSound>;

export type BuiltInSoundId = keyof typeof BUILT_IN_SOUNDS;

/** How long a sound rings, in seconds: when its last voice has faded. */
export function soundLength(sound: BuiltInSound): number {
  return Math.max(...sound.voices.map((voice) => voice.at + voice.dur));
}

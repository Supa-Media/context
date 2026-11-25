import { Platform } from "react-native";
import { preferences } from "./preferences";

/**
 * Start time, load time and clean sessions, measured by the app itself.
 *
 * Each launch is one session with a random id that names nobody. The app notes
 * at most one of each kind per session — that the session happened, how long
 * it took to show something (`start` on a phone, `load` in a browser or the
 * desktop shell), and whether it hit an error — and `useAppVitals` hands them
 * to the control plane (`functions/appVitals.ts`) once someone is signed in.
 * The control plane keeps them for 30 days with no account on them; the
 * Product area's Start time, Load time and Clean sessions metrics read them
 * from `data/usage/app.csv`.
 *
 * Governed by the crash reports switch: a vital is a fact about how the app
 * ran, the same kind of thing as a crash report, and off means none are kept.
 */
export type VitalKind = "start" | "load" | "session" | "error";
export type VitalPlatform = "web" | "desktop" | "ios" | "android";

export interface Vital {
  kind: VitalKind;
  ms?: number;
}

/** The longest launch worth recording; anything longer was a suspended tab. */
const MAX_MS = 600_000;

function randomSession(): string {
  let out = "";
  for (let i = 0; i < 16; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

let session = randomSession();
const noted = new Set<VitalKind>();
const queue: Vital[] = [];
const listeners = new Set<() => void>();

export function vitalSession(): string {
  return session;
}

export function vitalPlatform(): VitalPlatform {
  if (Platform.OS === "ios" || Platform.OS === "android") return Platform.OS;
  return typeof window !== "undefined" && (window as { desktop?: unknown }).desktop !== undefined
    ? "desktop"
    : "web";
}

/** Notes one vital, once per kind per session, while crash reports are on. */
export function noteVital(kind: VitalKind, ms?: number): void {
  if (noted.has(kind) || !preferences().crashReports) return;
  if (ms !== undefined && (!(kind === "start" || kind === "load") || !Number.isFinite(ms) || ms < 0)) return;
  noted.add(kind);
  queue.push(ms === undefined ? { kind } : { kind, ms: Math.min(Math.round(ms), MAX_MS) });
  for (const listener of listeners) listener();
}

/** When this module was first evaluated: as near the app's code starting as a phone lets us see. */
const CODE_STARTED = Date.now();

/**
 * How long the app has been starting. In a browser (and the desktop shell,
 * which is one) that is since the page was asked for, which is what a person
 * waited through. On a phone it is since the app's code began running: the
 * native launch before it is not visible from here, so the phone number reads
 * a little short, the same way every time.
 */
export function launchMs(): number {
  if (Platform.OS === "web" && typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now() - CODE_STARTED;
}

/** The launch: the session itself, and how long the app took to show. */
export function noteLaunch(sinceStartMs: number): void {
  noteVital("session");
  noteVital(vitalPlatform() === "ios" || vitalPlatform() === "android" ? "start" : "load", sinceStartMs);
}

/** Everything waiting, removed from the queue. */
export function takeVitals(): Vital[] {
  return queue.splice(0);
}

/** Put back what did not send, ahead of anything newer. */
export function returnVitals(items: Vital[]): void {
  queue.unshift(...items);
}

export function onVitals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function resetVitalsForTests(): void {
  session = randomSession();
  noted.clear();
  queue.length = 0;
  listeners.clear();
}

/**
 * The words the cast studio and its stage say to each other.
 *
 * The studio (`features/studio/`) draws the stage as the homepage itself, in
 * an iframe at the frame's size, playing the draft from its address the way
 * "Preview demo" always has: one player, one shell. The studio drives it with
 * these messages, over `postMessage`, between two documents of one origin.
 *
 * **A stage is only ever a page inside our own studio.** The homepage checks
 * that the window around it is the studio (`isStudioStage`), which a page on
 * any other origin cannot pass: reading a property of a cross-origin parent
 * throws. Only then does it leave out the "Preview of an unpublished draft"
 * line and wait to be told to start, because a recording is of the app and
 * nothing else. Opened on its own, or framed by anyone else, the address is a
 * preview like any other, and says so.
 */

import { CAST_MOMENTS, type CastMoment } from "./castRun";

/** Set on the studio's window, so the page inside can tell it is a stage. */
export const STUDIO_FLAG = "__contextCastStudio";

const TAG = "context-cast-studio";

/** Studio → stage. */
export type StudioCommand =
  /** Play from the top, or rushed to step `from` and live from there. */
  | { tag: typeof TAG; kind: "start"; from: number }
  | { tag: typeof TAG; kind: "pause" }
  | { tag: typeof TAG; kind: "resume" };

/** Stage → studio. */
export type StageEvent =
  /** The page is drawn and waiting to be started. */
  | { tag: typeof TAG; kind: "ready" }
  | { tag: typeof TAG; kind: "step"; index: number }
  /** The show's own time, in ms, every so often while it plays. */
  | { tag: typeof TAG; kind: "time"; ms: number }
  /** A moment the studio plays a sound for; never sent for a step rushed past. */
  | { tag: typeof TAG; kind: "cue"; moment: CastMoment }
  | { tag: typeof TAG; kind: "ended" };

type Body<T> = T extends unknown ? Omit<T, "tag"> : never;

export function studioCommand(body: Body<StudioCommand>): StudioCommand {
  return { tag: TAG, ...body } as StudioCommand;
}

export function stageEvent(body: Body<StageEvent>): StageEvent {
  return { tag: TAG, ...body } as StageEvent;
}

function tagged(data: unknown): data is { tag: string; kind: unknown } {
  return typeof data === "object" && data !== null && (data as { tag?: unknown }).tag === TAG;
}

const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function asStudioCommand(data: unknown): StudioCommand | null {
  if (!tagged(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.kind === "start") return whole(message.from) ? studioCommand({ kind: "start", from: message.from }) : null;
  if (message.kind === "pause" || message.kind === "resume") return studioCommand({ kind: message.kind });
  return null;
}

export function asStageEvent(data: unknown): StageEvent | null {
  if (!tagged(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.kind === "ready" || message.kind === "ended") return stageEvent({ kind: message.kind });
  if (message.kind === "step") return whole(message.index) ? stageEvent({ kind: "step", index: message.index }) : null;
  if (message.kind === "cue") {
    return (CAST_MOMENTS as readonly unknown[]).includes(message.moment)
      ? stageEvent({ kind: "cue", moment: message.moment as CastMoment })
      : null;
  }
  if (message.kind === "time") {
    return typeof message.ms === "number" && Number.isFinite(message.ms) && message.ms >= 0
      ? stageEvent({ kind: "time", ms: message.ms })
      : null;
  }
  return null;
}

/** Whether this window is a stage inside our own studio. See the file's note. */
export function isStudioStage(win: Window | undefined): boolean {
  if (win === undefined) return false;
  try {
    if (win.parent === win) return false;
    return (win.parent as unknown as Record<string, unknown>)[STUDIO_FLAG] === true;
  } catch {
    // A parent on another origin: its properties cannot be read.
    return false;
  }
}

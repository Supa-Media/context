/**
 * Let the app answer a tap in the middle of a long run of file work.
 *
 * `expo-file-system`'s `File.write`, `exists` and `delete` are synchronous
 * calls on the JS thread, and a chain of `await`s over them never leaves it:
 * a promise that is already settled resumes as a microtask, before any touch,
 * timer or frame. A sync committing 250 notes, or dropping an Archive's
 * bodies, was one unbroken stretch of the JS thread, and the phone ignored
 * every tap, Back included, until it finished (Dev2, 2026-10-16).
 *
 * `breathe()` costs nothing until `SLICE_MS` of work has gone by since the
 * last time it let go; then it waits one macrotask, which is where React
 * Native delivers touches. `setTimeout`, not `setImmediate`: React Native runs
 * immediates at the end of the same batch, before any touch is read.
 */

/** Work allowed between two chances for the app to answer a tap. */
export const SLICE_MS = 12;

let sliceStartedAt = -Infinity;

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

export async function breathe(): Promise<void> {
  const at = now();
  if (at - sliceStartedAt < SLICE_MS) return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  sliceStartedAt = now();
}

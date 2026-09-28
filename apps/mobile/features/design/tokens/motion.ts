/**
 * How the console moves when its layout changes.
 *
 * One duration and one curve for everything that makes room for itself — a
 * presence row arriving over a note, a notice above the editor, a panel at the
 * sidebar's foot. They used to appear in a single frame, so the note underneath
 * jumped by the height of whatever arrived; a jump reads as the page breaking,
 * where a short ease reads as the page making space.
 *
 * The same numbers everywhere is the point: two things that ease at different
 * speeds on one screen look like two bugs rather than one design.
 *
 * **layoutMs** is short enough that nobody waits on it and long enough to be
 * followed by eye. **ease** is a standard decelerate-in, accelerate-out curve:
 * it starts quickly (the change answers at once) and settles softly.
 */
export const motion = {
  layoutMs: 200,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
} as const;

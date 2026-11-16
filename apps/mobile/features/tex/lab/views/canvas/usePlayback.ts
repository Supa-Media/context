/**
 * What the canvas lights while a turn plays: each step's id and how far through it is (0 to 1, drawn as a ring
 * filling around the step, `render.ts`). Replay's timeline (`replay/ReplayTimeline.tsx`) and the test chat's ▶
 * (`engine/sandboxPlay.ts`) both hand the canvas one of these.
 */
export type Lit = ReadonlyMap<string, number>;

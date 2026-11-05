/**
 * The 64 emoji (one copy, in `packages/shared/src/textDecide.cjs`, beside the questions that offer them): decide may react with (Dev2, 2026-10-27: the model picks the
 * reaction, from a curated set rather than the full list, since one typed
 * question offers at most 64 options). Keyed by a short name the decision
 * model can choose; each value is the emoji and when it fits.
 *
 * The texting Worker keeps the same 64 emoji as an allowlist
 * (`apps/agent/src/reactEmoji.ts`): a test in each app pins the list, so the
 * two never drift. Never ✅ (it says done before anything is) and never a
 * gendered person (Tex doesn't know who is reading), as `ackEmoji.ts`.
 */
export { REACT_EMOJI } from "@context/shared/src/textDecide.cjs";

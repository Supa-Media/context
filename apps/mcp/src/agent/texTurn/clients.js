/**
 * What a turn that may not run says. Nothing in the app can change this any
 * more (people's own model keys were deleted, the owner, 2026-10-10): the
 * built-in model answers texts and routines where the control plane allows
 * it, and every
 * other `no_provider` — another client, another plan, the assistant switched
 * off, a deployment with no built-in model, a request naming a provider — is
 * the same sentence, so none of them is told apart from the outside.
 */
export const NO_MODEL_HERE = "The assistant isn't available here yet.";

/** The texting assistant's first-party client (`apps/convex/functions/textLinks.ts`). */
export const TEXTS_CLIENT_ID = "context_texts";
/** The app's own client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
export const CONSOLE_CLIENT_ID = "context_console";

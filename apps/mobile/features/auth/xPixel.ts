/**
 * The browser half of X's "Waitlist Sign Up" event (Dev2, 2026-10-05).
 *
 * The pixel exists only on context.lc's landing page (`public/index.html`),
 * so everywhere else `twq` is absent and this does nothing. The server
 * reports the same sign-up with the same `conversion_id`
 * (`apps/convex/functions/xConversions.ts`), so X counts it once; this half
 * adds X's own cookie match. No address is passed here: the server sends a
 * hash of it.
 */

/** Must equal `X_EVENT_IDS.waitlist` in `apps/convex/functions/lib/xConversion.ts`. */
export const X_WAITLIST_EVENT_ID = "tw-rgib5-rgic8";

type Twq = (command: "event", eventId: string, params: { conversion_id: string }) => void;

export function reportWaitlistSignUp(conversionId: string | undefined): void {
  if (conversionId === undefined || typeof window === "undefined") return;
  const twq = (window as unknown as { twq?: Twq }).twq;
  if (typeof twq !== "function") return;
  try {
    twq("event", X_WAITLIST_EVENT_ID, { conversion_id: conversionId });
  } catch {
    // An ad script failing never gets in the way of joining.
  }
}

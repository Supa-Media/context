/**
 * The browser half of Meta's `Lead` for a waitlist sign-up (Dev2, 2026-10-05).
 *
 * Meta's pixel exists only on context.lc's landing page (`public/index.html`),
 * so everywhere else `fbq` is absent and this does nothing. The server reports
 * the same sign-up with the same id as `event_id`
 * (`apps/convex/functions/metaConversions.ts`), and Meta counts a pair with
 * matching ids once. No address is passed here: the server sends a hash.
 */

type Fbq = (command: "track", event: "Lead", params: Record<string, never>, options: { eventID: string }) => void;

export function reportMetaLead(conversionId: string | undefined): void {
  if (conversionId === undefined || typeof window === "undefined") return;
  const fbq = (window as unknown as { fbq?: Fbq }).fbq;
  if (typeof fbq !== "function") return;
  try {
    fbq("track", "Lead", {}, { eventID: conversionId });
  } catch {
    // An ad script failing never gets in the way of joining.
  }
}

import { adCampaignFromSearch, adCampaignOf, type AdCampaign } from "@context/shared";

/**
 * The ad a visit came from, as its UTM parameters say, kept for the sign-up
 * so the waitlist row records it beside the landing page (Dev, 2026-10-11:
 * "make sure I can track where the sign ups are coming from").
 *
 * Read once, when this module loads — before the homepage's first link push
 * replaces the query string — and kept in session storage so a reload between
 * landing and joining keeps it. The first ad of a session is the one kept,
 * the same rule as the landing page (`landingPage.ts`). Sent only to
 * `waitlist.enter` and `phoneSignIn.start`, and the server cleans it again.
 */

const KEY = "context.campaign";

let remembered: AdCampaign | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The campaign this session arrived with, or `undefined`. */
export function adCampaign(): AdCampaign | undefined {
  if (remembered !== null) return remembered;
  try {
    const stored = storage()?.getItem(KEY) ?? null;
    return stored === null ? undefined : adCampaignOf(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

/** Remember the campaign in `search` (a URL's query string), unless this session already has one. */
export function captureAdCampaign(search: string): void {
  const campaign = adCampaignFromSearch(search);
  if (campaign === undefined || adCampaign() !== undefined) return;
  remembered = campaign;
  try {
    storage()?.setItem(KEY, JSON.stringify(campaign));
  } catch {
    // Private mode or blocked storage: this visit's memory still has it.
  }
}

if (typeof window !== "undefined" && typeof window.location?.search === "string") {
  captureAdCampaign(window.location.search);
}

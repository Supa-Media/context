/**
 * WHAT A GOOGLE CONNECTION MAY CHANGE, AND ASKING GOOGLE WHEN IN DOUBT.
 *
 * On 2026-10-23 Tex told @blessing, a customer, twice that her Google
 * connection "can only read your calendar" while Settings showed both her
 * accounts "Connected" with every service lit (the owner: "why wouldnt you
 * actually check to see if you have write access before sending this").
 * Two answers to that:
 *
 *  - Settings says which services can only be read (`readOnlyServices`), so
 *    "Connected" never stands for a connection Tex can't act through.
 *  - Before a calendar change is refused as read-only, the control plane asks
 *    Google what the grant really holds (`grantedScopes`, Google's
 *    tokeninfo endpoint), and a stored scope list that is behind is
 *    corrected and the change goes (`functions/googleScopeCheck.ts`).
 */

import { CHAT_SEND_SCOPE, canSendEmail, canWriteCalendar, type GoogleProduct } from "./googleOAuth";

/** Whether a grant lets Context act through a service, not only read it. Gmail sends on compose or send. */
function canAct(service: GoogleProduct, scopes: readonly string[]): boolean {
  if (service === "gmail") return canSendEmail(scopes);
  return service === "calendar" ? canWriteCalendar(scopes) : scopes.includes(CHAT_SEND_SCOPE);
}

/** The services a connection carries that its grant lets Context read but not act through, in a fixed order. */
export function readOnlyServices(services: Record<GoogleProduct, boolean>, scopes: readonly string[]): GoogleProduct[] {
  return (["gmail", "calendar", "chat"] as const).filter((service) => services[service] && !canAct(service, scopes));
}

const TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The scopes Google says an access token holds, or null when Google could not
 * say. The token goes in a POST body, never a URL.
 */
export async function grantedScopes(accessToken: string, fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init)): Promise<string[] | null> {
  try {
    const response = await fetchImpl(TOKENINFO_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { scope?: unknown } | null;
    if (typeof body?.scope !== "string") return null;
    return body.scope.split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

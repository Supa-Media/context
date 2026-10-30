/**
 * What a connect asked of the standard client before the minimum consent
 * (2026-10-23 to 2026-10-30): every product's read scopes, plus the write
 * scopes asked of everyone, with Chat's read and send riding on Gmail. Rows
 * made then still hold these grants, so tests seed them to prove an existing
 * connection keeps its route. Never what a new request asks for
 * (`standardScopesFor` / `agentScopesFor` in `lib/googleConnect/aiScopes.ts`).
 */

import {
  CALENDAR_SCOPES,
  CALENDAR_WRITE_SCOPE,
  CHAT_READ_SCOPE,
  CHAT_SCOPES,
  CHAT_SEND_SCOPES,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
  type GoogleProduct,
} from "../../functions/lib/googleOAuth";

export const LEGACY_WRITE_SCOPES: Record<GoogleProduct, readonly string[]> = {
  gmail: [GMAIL_COMPOSE_SCOPE, ...CHAT_SEND_SCOPES, CHAT_READ_SCOPE],
  calendar: [CALENDAR_WRITE_SCOPE],
  chat: [...CHAT_SEND_SCOPES],
};

const LEGACY_READ_SCOPES: Record<GoogleProduct, readonly string[]> = { gmail: GMAIL_SCOPES, calendar: CALENDAR_SCOPES, chat: CHAT_SCOPES };

/** The standard grant a pre-2026-10-30 connect of these products holds. */
export function legacyGrantScopes(products: readonly GoogleProduct[]): string[] {
  const scopes = new Set<string>(IDENTITY_SCOPES);
  for (const product of products) for (const scope of [...LEGACY_READ_SCOPES[product], ...LEGACY_WRITE_SCOPES[product]]) scopes.add(scope);
  return [...scopes];
}

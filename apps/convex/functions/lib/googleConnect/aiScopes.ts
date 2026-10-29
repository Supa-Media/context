/**
 * The scopes each Google client is asked for, and the scopes AI may act on
 * (`functions/googleClients.ts`; matrix in
 * docs/decisions/communications/google-clients.md).
 *
 * AI's capability (can it send mail, write the calendar, read or send Chat)
 * is read from the grant AI actually mints from: the agent grant once AI is
 * on the agent client for that account, the standard grant before. Reading
 * the standard grant's scopes after the switch would report an ability the
 * agent grant may not hold.
 */

import {
  CALENDAR_OWNED_READ_SCOPE,
  CALENDAR_SCOPES,
  canReadCalendar,
  canWriteCalendar,
  grantedScopesFor,
  IDENTITY_SCOPES,
  narrowCalendarScopes,
  scopesForConnect,
  type GoogleProduct,
} from "../googleOAuth";
import { agentClientActive, googleEnvFor, grantFor } from "./clients";

type Env = Record<string, string | undefined>;

/**
 * The agent client's consent: every read and write scope AI uses for the
 * products, without Calendar's read scope, which its write scope already
 * covers (either pair; `narrowCalendarScopes`).
 */
export function agentScopesFor(products: readonly GoogleProduct[], env: Env = process.env): string[] {
  const scopes = scopesForConnect(products, env);
  const reads: readonly string[] = [...CALENDAR_SCOPES, CALENDAR_OWNED_READ_SCOPE];
  return canWriteCalendar(scopes) ? scopes.filter((scope) => !reads.includes(scope)) : scopes;
}

/** The read scopes an agent grant must hold for Gmail and Chat to count as allowed. */
const AGENT_READ: Record<Exclude<GoogleProduct, "calendar">, readonly string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  chat: ["https://www.googleapis.com/auth/chat.messages.readonly", "https://www.googleapis.com/auth/chat.spaces.readonly"],
};

/**
 * Whether an agent grant covers every product the connection has: a partial
 * consent does not. Calendar's agent consent is its write scope alone, of
 * either pair.
 */
export function agentGrantCovers(products: readonly GoogleProduct[], scopes: readonly string[]): boolean {
  return products.every((product) =>
    product === "calendar" ? canWriteCalendar(scopes) : AGENT_READ[product].every((scope) => scopes.includes(scope)),
  );
}

interface ScopedConnection {
  /** Required, so a row passed without it cannot quietly read the global settings in place of its workspace's (the canary). */
  workspaceId: string;
  scopes: string[];
  agentGrant?: { scopes: string[] };
}

/** The scopes AI may act on for this connection: those of the grant AI mints from. */
export function aiScopesOf(row: ScopedConnection, env: Env = googleEnvFor(row.workspaceId)): string[] {
  return grantFor("agent", row.agentGrant !== undefined, env) === "agent" ? (row.agentGrant?.scopes ?? []) : row.scopes;
}

/**
 * The standard client's consent. Until the switch, today's list: AI still
 * reads every account that has not allowed AI access through it. Once
 * switched, the person's own use is the Meetings view's calendar read and
 * nothing else, so identity, plus `calendar.events.readonly` when Calendar
 * is connected: no Gmail, no Chat, no write.
 */
export function standardScopesFor(products: readonly GoogleProduct[], env: Env = process.env): string[] {
  if (!agentClientActive(env)) return scopesForConnect(products, env);
  return products.includes("calendar") ? narrowCalendarScopes([...IDENTITY_SCOPES, ...CALENDAR_SCOPES], env) : [...IDENTITY_SCOPES];
}

/**
 * Whether a standard grant holds what its own role needs of a product, the
 * rule a connect binds a product by. Until the switch, the product's read
 * scopes, as today. Once switched, only Calendar needs anything of it (the
 * Meetings view); Gmail and Chat are the person's choice on the row, and
 * what AI may do with them comes from the agent grant (`agentGrantCovers`).
 */
export function standardGrantCovers(product: GoogleProduct, scopes: readonly string[], env: Env = process.env): boolean {
  if (agentClientActive(env) && product !== "calendar") return true;
  // A Calendar write scope of either pair reads too, so a consent that kept only it still binds.
  if (product === "calendar") return canReadCalendar(scopes);
  return grantedScopesFor(product, scopes).length > 0;
}

/** Whether a grant lets AI read a product: Calendar reads under any of its four event scopes. */
export function canReadProduct(product: GoogleProduct, scopes: readonly string[]): boolean {
  if (product === "calendar") return canReadCalendar(scopes);
  return AGENT_READ[product].every((scope) => scopes.includes(scope));
}

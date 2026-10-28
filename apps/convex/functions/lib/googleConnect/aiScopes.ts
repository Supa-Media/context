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
  CALENDAR_SCOPES,
  CALENDAR_WRITE_SCOPE,
  grantedScopesFor,
  IDENTITY_SCOPES,
  scopesForConnect,
  type GoogleProduct,
} from "../googleOAuth";
import { agentClientActive, grantFor } from "./clients";

type Env = Record<string, string | undefined>;

/**
 * The agent client's consent: every read and write scope AI uses for the
 * products, without `calendar.events.readonly`, which `calendar.events`
 * already covers.
 */
export function agentScopesFor(products: readonly GoogleProduct[]): string[] {
  const scopes = scopesForConnect(products);
  return scopes.includes(CALENDAR_WRITE_SCOPE) ? scopes.filter((scope) => !(CALENDAR_SCOPES as readonly string[]).includes(scope)) : scopes;
}

/** The read scopes an agent grant must hold for a product to count as allowed. */
const AGENT_READ: Record<GoogleProduct, readonly string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  calendar: [CALENDAR_WRITE_SCOPE],
  chat: ["https://www.googleapis.com/auth/chat.messages.readonly", "https://www.googleapis.com/auth/chat.spaces.readonly"],
};

/** Whether an agent grant covers reading every product the connection has: a partial consent does not. */
export function agentGrantCovers(products: readonly GoogleProduct[], scopes: readonly string[]): boolean {
  return products.every((product) => AGENT_READ[product].every((scope) => scopes.includes(scope)));
}

interface ScopedConnection {
  scopes: string[];
  agentGrant?: { scopes: string[] };
}

/** The scopes AI may act on for this connection: those of the grant AI mints from. */
export function aiScopesOf(row: ScopedConnection, env: Env = process.env): string[] {
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
  if (!agentClientActive(env)) return scopesForConnect(products);
  return products.includes("calendar") ? [...IDENTITY_SCOPES, ...CALENDAR_SCOPES] : [...IDENTITY_SCOPES];
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
  return grantedScopesFor(product, scopes).length > 0;
}

/** Whether a grant lets AI read a product: Calendar reads under either calendar scope. */
export function canReadProduct(product: GoogleProduct, scopes: readonly string[]): boolean {
  if (product === "calendar") return scopes.includes(CALENDAR_SCOPES[0]) || scopes.includes(CALENDAR_WRITE_SCOPE);
  return AGENT_READ[product].every((scope) => scopes.includes(scope));
}

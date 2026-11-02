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
  CALENDAR_OWNED_SCOPE,
  canReadCalendar,
  canWriteCalendar,
  CHAT_READ_SCOPE,
  CHAT_SEND_SCOPE,
  CHAT_SPACES_CREATE_SCOPE,
  CHAT_SPACES_READ_SCOPE,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SCOPES,
  grantedScopesFor,
  IDENTITY_SCOPES,
  type GoogleProduct,
} from "../googleOAuth";
import { agentClientActive, googleEnvFor, googleEnvForRow, grantFor } from "./clients";

/** Re-exported so a connect flow imports its scopes and their environment from one place. */
export { googleEnvFor, googleEnvForRow };

type Env = Record<string, string | undefined>;

/**
 * What the agent client is asked for, feature by feature (2026-10-30, after
 * Google asked for exact scope matching and least privilege per feature):
 * Gmail's read and drafts, the owned calendar's events (its write scope
 * reads too, so no read scope beside it), and Chat's read and send.
 * `chat.spaces.create` is in Chat's because sending to somebody the person
 * has never messaged starts the direct message (`spaces.setup`, which Google
 * accepts under that scope or `chat.spaces` alone). A product the person did
 * not connect contributes nothing: Gmail no longer carries Chat's scopes.
 */
export const AGENT_PRODUCT_SCOPES: Readonly<Record<GoogleProduct, readonly string[]>> = {
  gmail: [GMAIL_SCOPES[0], GMAIL_COMPOSE_SCOPE],
  calendar: [CALENDAR_OWNED_SCOPE],
  chat: [CHAT_READ_SCOPE, CHAT_SPACES_READ_SCOPE, CHAT_SEND_SCOPE, CHAT_SPACES_CREATE_SCOPE],
};

/** The agent client's consent for these products: identity and each product's own scopes, nothing else. */
export function agentScopesFor(products: readonly GoogleProduct[]): string[] {
  const scopes = new Set<string>(IDENTITY_SCOPES);
  for (const product of products) for (const scope of AGENT_PRODUCT_SCOPES[product]) scopes.add(scope);
  return [...scopes];
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
  /** `split` for a row made under the minimum consent: AI reads through the agent grant only (`googleEnvForRow`). */
  consentPlan?: "split";
  scopes: string[];
  agentGrant?: { scopes: string[] };
}

/**
 * Whether what AI lacks on this connection is its owner's Allow AI access:
 * AI mints from the agent grant here (switched on, the canary, or an owner
 * who already allowed it), and that grant is missing or does not cover every
 * product the connection has. Only the agent consent mends that; a reconnect
 * gives the standard client a new grant AI never reads, so telling the person
 * to reconnect would send them round in a loop.
 */
export function aiAccessNeeded(row: ScopedConnection & { products: readonly GoogleProduct[] }, env: Env = googleEnvForRow(row)): boolean {
  if (grantFor("agent", row.agentGrant !== undefined, env) !== "agent") return false;
  return row.agentGrant === undefined || !agentGrantCovers(row.products, row.agentGrant.scopes);
}

/** The scopes AI may act on for this connection: those of the grant AI mints from. */
export function aiScopesOf(row: ScopedConnection, env: Env = googleEnvForRow(row)): string[] {
  return grantFor("agent", row.agentGrant !== undefined, env) === "agent" ? (row.agentGrant?.scopes ?? []) : row.scopes;
}

/**
 * The standard client's consent, for every new request (2026-10-30): the
 * person's own use is the Meetings view's calendar read and nothing else, so
 * identity, plus `calendar.events.owned.readonly` when Calendar is
 * connected: no Gmail, no Chat, no write, and never the broad calendar pair.
 * A grant made before keeps every scope it holds (`include_granted_scopes`),
 * and its row keeps reading through it (`consentPlan.ts`).
 */
export function standardScopesFor(products: readonly GoogleProduct[]): string[] {
  return products.includes("calendar") ? [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE] : [...IDENTITY_SCOPES];
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

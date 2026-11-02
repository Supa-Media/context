import type { DotTone } from "../../design/components/Dot";
import type { GoogleConnection } from "./GoogleConnectionsCard";

/** One of the three things a Google account carries into a context. */
export type GoogleService = "gmail" | "calendar" | "chat";

/** In the order Google's own consent screen lists them. */
export const SERVICES: readonly GoogleService[] = ["gmail", "calendar", "chat"];

/** The reader's word for each service, which is not always Google's. */
export const SERVICE_TITLES: Record<GoogleService, string> = {
  gmail: "Email",
  calendar: "Calendar",
  chat: "Chat",
};

/** "Calendar", "Calendar and Chat", "Email, Calendar and Chat". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The services this account actually carries, in a fixed order. */
export function enabledServices(connection: GoogleConnection): GoogleService[] {
  return SERVICES.filter((service) => connection.syncServices[service]);
}

/**
 * Whether this account needs the person to sign in to Google again.
 *
 * Only Google refusing the grant counts: it is the one thing a reader of
 * Google can still find wrong, now that nothing is copied (owner, 2026-10-21).
 */
export function needsReconnect(connection: GoogleConnection): boolean {
  return connection.syncStatus === "reconnect_required";
}

/**
 * Whether the owner disconnected this account. Its row stays, so the notes
 * copied from it before can still be found and deleted, but Google ended
 * Context's access: nothing on the row may say Connected (a disconnected
 * testuser row stayed green on 2026-10-30 while Tex said no Gmail was there).
 */
export function isDisconnected(connection: GoogleConnection): boolean {
  return connection.syncStatus === "disconnected";
}

/**
 * The account's one sentence.
 *
 * Mail, calendar and chat are read from Google when asked and never copied
 * into notes (owner, 2026-10-21), so there is no copy to be behind: the row
 * says "Connected" where it said "Up to date · 3:57 PM", and only a grant
 * Google refuses is news (a Reconnect sits beside it).
 */
export function accountStatus(connection: GoogleConnection): { tone: "ok" | "warn" | "crit" | "off"; text: string } {
  if (isDisconnected(connection)) return { tone: "off", text: "Disconnected. Context and your AI no longer read this account." };
  if (needsReconnect(connection)) return { tone: "crit", text: "Google wants you to sign in again." };
  const readOnly = readOnlyOf(connection);
  if (readOnly.length > 0) {
    return { tone: "warn", text: `${listWords(readOnly.map((service) => SERVICE_TITLES[service]))} read only. Reconnect and tick Select all.` };
  }
  return { tone: "ok", text: "Connected" };
}

/**
 * The services this account carries that Context can read but not act
 * through: its grant predates the write scopes, or a box was left unticked
 * on Google's consent screen. "Connected" over these was why Settings and
 * Tex disagreed for @blessing (2026-10-23).
 */
export function readOnlyOf(connection: GoogleConnection): GoogleService[] {
  return SERVICES.filter((service) => connection.syncServices[service] && (connection.readOnly ?? []).includes(service));
}

/** A service's own health, for its dot: only a grant Google refuses is news; a disconnected account's are off. */
export function serviceTone(connection: GoogleConnection, service: GoogleService): DotTone {
  if (isDisconnected(connection)) return "neutral";
  if (needsReconnect(connection)) return "crit";
  return readOnlyOf(connection).includes(service) ? "warn" : "ok";
}

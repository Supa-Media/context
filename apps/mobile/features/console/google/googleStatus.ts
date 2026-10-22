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
 * The account's one sentence.
 *
 * Mail, calendar and chat are read from Google when asked and never copied
 * into notes (owner, 2026-10-21), so there is no copy to be behind: the row
 * says "Connected" where it said "Up to date · 3:57 PM", and only a grant
 * Google refuses is news (a Reconnect sits beside it).
 */
export function accountStatus(connection: GoogleConnection): { tone: "ok" | "crit"; text: string } {
  if (needsReconnect(connection)) return { tone: "crit", text: "Google wants you to sign in again." };
  return { tone: "ok", text: "Connected" };
}

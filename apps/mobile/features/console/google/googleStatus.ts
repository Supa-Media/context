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

/** The services whose own last turn failed while the account itself is fine. */
export function failingServices(connection: GoogleConnection): GoogleService[] {
  return enabledServices(connection).filter(
    (service) => connection[service]?.lastFailure !== undefined,
  );
}

/** The most recent time any service on this account delivered something. */
export function lastDelivered(connection: GoogleConnection): number | undefined {
  const times = enabledServices(connection)
    .map((service) => connection[service]?.lastSyncedAt)
    .filter((at): at is number => at !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
}

/** A service with no successful pass for this long is shown as stale (`lib/mailHealth/model.ts`, the same six hours). */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** The pass's own code for a mailbox that reached its storage ceiling. */
export const STORE_FULL_CODE = "MAIL_QUOTA_EXCEEDED";

/**
 * Whether this account needs the person to sign in to Google again.
 *
 * Only Google refusing the grant counts. A service that Google rate-limited,
 * or a pass that failed for a while, retries on its own, and sending somebody
 * through a consent screen for it would fix nothing.
 */
export function needsReconnect(connection: GoogleConnection): boolean {
  return connection.syncStatus === "reconnect_required";
}

/** Whether Email stopped because it reached its storage ceiling, which only the person can change. */
export function storeFull(connection: GoogleConnection): boolean {
  return connection.errorCode === STORE_FULL_CODE || connection.syncRun?.errorCode === STORE_FULL_CODE;
}

/**
 * The services that have not had a successful pass for `STALE_AFTER_MS`, and
 * the oldest of their last ones. A service that never synced is waiting, not
 * stale: the account says so on its own.
 */
export function staleServices(
  connection: GoogleConnection,
  now: number = Date.now(),
): { services: GoogleService[]; since: number } | null {
  const stale = enabledServices(connection).filter((service) => {
    const at = connection[service]?.lastSyncedAt;
    return at !== undefined && now - at > STALE_AFTER_MS;
  });
  if (stale.length === 0) return null;
  return { services: stale, since: Math.min(...stale.map((service) => connection[service]!.lastSyncedAt!)) };
}

/**
 * The account's one sentence, worst news first.
 *
 * `crit` is only what the person has to fix: Google wants them to sign in
 * again (and a Reconnect sits beside it), or Email is full. `warn` is a
 * service that has not synced for hours ("Not synced since 9 hours ago"), a
 * failure that is retrying on its own, or an account that has not had its
 * first pass yet. Anything else is up to date. The row used to say "Up to
 * date" over a mailbox that had not delivered for a day, because no failure
 * code was set; and it offered Reconnect for failures a reconnect does not fix.
 */
export function accountStatus(
  connection: GoogleConnection,
  now: number = Date.now(),
): {
  tone: "ok" | "warn" | "crit";
  text: string;
} {
  // A stale grant gets the short sentence: the Reconnect beside it is the "what to do".
  if (needsReconnect(connection)) return { tone: "crit", text: "Google wants you to sign in again." };
  if (storeFull(connection)) return { tone: "crit", text: "Email storage is full, so new mail isn't being saved." };
  const stale = staleServices(connection, now);
  if (stale !== null) {
    const ago = formatAgo(stale.since, now);
    // The whole account, or only the services that stopped, by name.
    if (stale.services.length === enabledServices(connection).length) return { tone: "warn", text: `Not synced since ${ago}.` };
    const which = listWords(stale.services.map((service) => SERVICE_TITLES[service]));
    return { tone: "warn", text: `${which} not synced since ${ago}.` };
  }
  const failed =
    connection.errorCode ??
    connection.syncRun?.errorCode ??
    (connection.syncStatus === "error" ? connection.syncStatus : undefined);
  if (failed !== undefined) {
    // The server's own sentence where there is one: it names the reason. It retries without them.
    const said = connection.lastError ?? connection.syncRun?.lastError ?? connection.sync.lastFailure;
    return { tone: "warn", text: said === undefined ? "Not syncing right now; retrying on its own." : `${said} Retrying on its own.` };
  }
  const failing = failingServices(connection);
  if (failing.length > 0) {
    // Only the failing ones: each service's own dot already says the rest are fine.
    const failWords = listWords(failing.map((service) => SERVICE_TITLES[service]));
    return { tone: "warn", text: `${failWords} paused, retrying on its own.` };
  }
  // Connected and not yet proven, which is where every account lives between
  // the consent screen and its first pass. A real state, and not an error.
  if (!connection.sync.everSynced) {
    return { tone: "warn", text: "Connected; waiting for the first pass." };
  }
  if (connection.sync.catchingUp) return { tone: "ok", text: "Catching up on older mail." };
  return { tone: "ok", text: "Up to date." };
}

/** "45 minutes ago", "9 hours ago", "3 days ago". */
export function formatAgo(at: number, now: number = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * "11:26 AM" today, "Oct 15, 4:21 PM" otherwise.
 *
 * The full `toLocaleString()` this replaced put the seconds and the year on
 * every line, six times a screen.
 */
export function formatWhen(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (when.toDateString() === new Date(now).toDateString()) return time;
  const day = when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

/** "Oct 15" for the day an account stopped. */
export function formatDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

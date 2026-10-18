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

/**
 * Whether this account needs the person to sign in to Google again.
 *
 * Only the account's own failure counts. A service that Google rate-limited
 * retries on its own, and sending somebody through a consent screen for it
 * would fix nothing.
 */
export function needsReconnect(connection: GoogleConnection): boolean {
  return accountStatus(connection).tone === "crit";
}

/**
 * The account's one sentence, worst news first.
 *
 * `crit` is the account's own failure, which a reconnect fixes. `warn` is a
 * service that failed its last turn, or an account that has not had its first
 * pass yet. Anything else is up to date. The row used to say "Syncing." in
 * green over an Email line that had not delivered for weeks; a failing service
 * now reaches the row by name.
 */
export function accountStatus(connection: GoogleConnection): {
  tone: "ok" | "warn" | "crit";
  text: string;
} {
  const failed =
    connection.errorCode ??
    connection.syncRun?.errorCode ??
    (connection.syncStatus === "reconnect_required" || connection.syncStatus === "error"
      ? connection.syncStatus
      : undefined);
  if (failed !== undefined) {
    return {
      tone: "crit",
      /*
        The server's own sentence wherever there is one: it names the account
        and what to do. The fallback is written as a sentence here rather than
        dropped on the row as the fragment the status code is.
      */
      text:
        // A stale grant gets the short sentence: the Reconnect beside it is
        // the "what to do", and the server's longer one ran to four lines at
        // 390pt next to that button.
        (connection.syncStatus === "reconnect_required"
          ? "Google wants you to sign in again."
          : undefined) ??
        connection.lastError ??
        connection.syncRun?.lastError ??
        connection.sync.lastFailure ??
        (failed === "reconnect_required"
          ? "Google wants you to sign in again. Reconnect this account to keep syncing."
          : "This account is not syncing. Reconnect it to try again."),
    };
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

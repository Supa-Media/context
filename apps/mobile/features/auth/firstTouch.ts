import { Platform } from "react-native";
import { firstTouchFromLocation, firstTouchOf, type FirstTouch } from "@context/shared";

/**
 * The first touch this browser saw before anybody signed in (Dev2,
 * 2026-11-28): the referrer's origin, `utm_source`, `utm_medium`, `ref` and
 * the landing path's first segment, nothing else (`FirstTouch` in
 * `@context/shared`). Read once, when this module loads (the root layout
 * imports it, before the first link push replaces the URL), and kept in local
 * storage so a later visit, or the day the person finally signs up, still has
 * the first one.
 *
 * Sent only with a sign-up: on joining the waitlist (`waitlist.enter`,
 * `phoneSignIn.start`) and once after signing in (`signupChannels.fromApp`,
 * which counts it only for an account made in the last hour). The server
 * cleans it again and keeps only the channel it names.
 */

const KEY = "context.firstTouch";
const SENT_KEY = "context.firstTouch.sent";

/** Our own hosts: arriving from one of them is moving between our pages, not a referrer. */
const OWN_HOSTS = ["context.lc", "www.context.lc", "tex.lc", "www.tex.lc", "staging.context.lc", "tex-staging.context.lc"];

let remembered: FirstTouch | undefined;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The touch this browser first arrived with; on the iOS and Android apps, none (they have no referrer), so `{}`. */
export function firstTouch(): FirstTouch | undefined {
  if (Platform.OS !== "web") return {};
  if (remembered !== undefined) return remembered;
  try {
    const stored = storage()?.getItem(KEY) ?? null;
    return stored === null ? undefined : firstTouchOf(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

/** Keep the touch `href` and `referrer` make, unless this browser already kept one. */
export function captureFirstTouch(href: string, referrer: string): void {
  if (firstTouch() !== undefined) return;
  remembered = firstTouchFromLocation(href, referrer, OWN_HOSTS);
  try {
    storage()?.setItem(KEY, JSON.stringify(remembered));
  } catch {
    // Private mode or blocked storage: this visit's memory still has it.
  }
}

/** Whether this device already told the server, so a long-signed-in browser doesn't ask on every open. */
export function firstTouchSent(): boolean {
  try {
    return storage()?.getItem(SENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function markFirstTouchSent(): void {
  try {
    storage()?.setItem(SENT_KEY, "1");
  } catch {
    // Asked again next open; the server writes a channel once, so a repeat is harmless.
  }
}

if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.location?.href === "string" && typeof document !== "undefined") {
  captureFirstTouch(window.location.href, typeof document.referrer === "string" ? document.referrer : "");
}

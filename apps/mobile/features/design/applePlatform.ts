/**
 * Is this an Apple keyboard? — native.
 *
 * One answer, in one place. This existed three times before: the keymap binder
 * checked `userAgentData` with an allowlist, the palette ran a regex over
 * `navigator.platform || navigator.userAgent`, and `menu.ts` simply defaulted
 * to `true`. On Windows they disagreed on the same machine — the binder
 * correctly listened for `Ctrl`, and the menu printed `⌘`.
 *
 * That is worse than either answer alone: a shortcut printed beside a menu row
 * is a promise, and one that names a key which does nothing is a lie the user
 * has no way to diagnose.
 *
 * On native the question is settled at build time, so there is nothing to
 * detect.
 */
import { Platform } from "react-native";

export function isApplePlatform(): boolean {
  return Platform.OS === "ios" || Platform.OS === "macos";
}

import { Platform } from "react-native";

/**
 * Start the app over from scratch.
 *
 * The last resort behind the error boundary. A React error boundary can only
 * re-render its children; it cannot re-run the module graph, re-open the Convex
 * socket, or clear whatever half-state produced the throw. When re-rendering is
 * not enough, this is.
 *
 * **Web only, and deliberately so.** `window.location.reload()` is the real
 * thing on the surface that matters here — the console, the OAuth consent
 * screen and sign-in are all browser flows. On native there is no honest
 * equivalent: `expo-updates`' `reloadAsync` throws in Expo Go and in any build
 * without the updates module, so offering a "Reload" that may itself throw
 * inside an error screen would be worse than not offering one. Native gets
 * "Try again" — the boundary reset — and nothing that lies.
 */
export const canReload: boolean =
  Platform.OS === "web" &&
  typeof window !== "undefined" &&
  typeof window.location?.reload === "function";

export function reloadApp(): void {
  if (!canReload) return;
  window.location.reload();
}

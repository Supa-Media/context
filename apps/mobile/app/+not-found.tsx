import { Redirect, useGlobalSearchParams } from "expo-router";
import { DeadLinkScreen } from "../features/app/DeadLinkScreen";
import { NOTE_LINK_SEGMENT, canonicalHrefFor, noteAddressFromSegments } from "../features/console/noteLink";
import { unmatchedSegments } from "../features/app/unmatched";

/**
 * Every URL that matched nothing.
 *
 * Declaring this route is what stops Expo Router from serving its built-in
 * Unmatched Route screen — a development aid, printing the path and offering
 * "Go back", which is what somebody following a `context://note/…` link from
 * ChatGPT got on iOS on 2026-09-03. `getNavigationConfig` installs the built-in
 * only when the app has not declared one.
 *
 * ## It recovers a note link before giving up
 *
 * `app/note/[...address].tsx` is the route for the link grammar and handles
 * every well-formed one. This is the second chance, and it exists because the
 * transformation from a link somebody was sent to a path this router matches
 * runs through code we do not own — `extractExactPathFromURL` builds a `URL`
 * and concatenates host and pathname — and because links are pasted, truncated
 * and re-encoded by whatever carried them. A `/note/…` that arrived in a shape
 * the real route did not match is still a note somebody was sent, and answering
 * it with a dead end would be the same failure in a nicer font.
 *
 * The parse is the same function the real route uses and refuses the same
 * things — no `@`, no path, a traversal segment — so this recovers addresses
 * and never invents one.
 *
 * `useGlobalSearchParams` rather than `useLocalSearchParams`: the local hook
 * answers for the focused route only, and this screen is reached through a
 * navigation state whose focus is not something this file gets to assume.
 */
export default function NotFoundRoute() {
  const segments = unmatchedSegments(useGlobalSearchParams());

  if (segments[0] === NOTE_LINK_SEGMENT) {
    const address = noteAddressFromSegments(segments.slice(1));
    if (address !== null) return <Redirect href={canonicalHrefFor(address)} />;
  }

  return <DeadLinkScreen />;
}

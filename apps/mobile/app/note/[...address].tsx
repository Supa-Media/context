import { Redirect, useLocalSearchParams } from "expo-router";
import { DeadLinkScreen } from "../../features/app/DeadLinkScreen";
import {
  canonicalHrefFor,
  noteAddressFromSegments,
  noteLinkPath,
} from "../../features/console/noteLink";

/**
 * `/note/@slug/<path>` — the link format anything outside the app can produce.
 *
 * This is the route that was missing. `context://note/@supa/1-projects/…/overview.md`
 * — a link ChatGPT generated on 2026-09-03 — opened the app and rendered Expo
 * Router's Unmatched Route screen, because nothing matched `note/…`. The
 * grammar, and why its first segment is a fixed keyword rather than the
 * context's name, is in `features/console/noteLink.ts`.
 *
 * ## It redirects rather than rendering the note
 *
 * `/console/@slug?note=…` stays the canonical address. Two things follow from
 * keeping exactly one of them real:
 *
 *  - Everything the console already does for that URL happens for free —
 *    signing in and coming back (`attemptedHrefFrom` reads it off
 *    `window.location`), a context you are invited to but have not accepted
 *    (`resolveContextRoute` sends you to the invitation), a context that is not
 *    yours (the landing). None of that is re-implemented here, so none of it
 *    can drift.
 *  - The address bar ends up holding the URL a person can copy, bookmark and
 *    reload — which is the whole feature. A `/note/…` URL that stayed in the
 *    bar would be a second address for one note, and only one of the two is
 *    kept in step with what is open.
 *
 * ## It is outside `(app)`, deliberately
 *
 * So a signed-out visitor is redirected to the console URL *first* and is then
 * sent to sign in carrying it, rather than being sent to sign in carrying
 * `/note/…` and bounced through this again afterwards. One hop, one `next`, and
 * the parameter that survives is the canonical one.
 *
 * `Redirect` rather than an effect: it acts during render, so there is no frame
 * in which this route is mounted and painting.
 */
export default function NoteLinkRoute() {
  const params = useLocalSearchParams<{ address?: string | string[] }>();
  const address = noteAddressFromSegments(segmentsOf(params.address));

  if (address === null) {
    return (
      <DeadLinkScreen
        title="That note link is not one we can read"
        /*
          The example is built by the grammar rather than spelled out, so the
          shape somebody is shown cannot drift from the one that just rejected
          them.
        */
        detail={`A link to a note looks like ${noteLinkPath("name", "folder/note.md")}. This one is missing the context it belongs to, or names a path we will not open.`}
      />
    );
  }
  return <Redirect href={canonicalHrefFor(address)} />;
}

/**
 * Expo Router gives a catch-all its segments as an array, and a single-segment
 * match as a bare string. Both shapes are real: `/note/@supa` is the second,
 * and it is a link somebody truncated — `noteAddressFromSegments` refuses it
 * for having no path, which is the whole reason this must not silently drop it.
 */
function segmentsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

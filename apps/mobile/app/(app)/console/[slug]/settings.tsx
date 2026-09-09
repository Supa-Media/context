import { Redirect, useLocalSearchParams } from "expo-router";
import { browseHref, settingsHref, slugFromSegment } from "../../../../features/console/nav";

/**
 * `/console/@:slug/settings` — kept, and now a redirect.
 *
 * Settings stopped being a route and became an overlay drawn over Browse by
 * `console/_layout.tsx`, addressed as `?settings=<section>`. The old path stays
 * because it is in the wild: the Dropbox failure notice links to it, the search
 * nudge rows link to it, and somebody has it in a chat. Every one of those must
 * keep landing on settings rather than on a dead page.
 *
 * **It reads the segment and nothing else.** An earlier version resolved the
 * slug through `useConsoleData`, which made a pure URL rewrite depend on a
 * live subscription — and made it unmountable by `safeArea.test.ts`'s census,
 * which is the guard that has to be able to prove this file draws nothing.
 * Whether the slug names a context this account can reach is the destination's
 * question, and `resolveContextRoute` already answers it there.
 *
 * `Redirect` rather than an effect: there is nothing of its own to draw, so
 * rendering and then navigating would paint an empty pane for a frame.
 */
export default function ContextSettingsRoute() {
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const raw = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const slug = typeof raw === "string" ? slugFromSegment(raw) : "";
  return <Redirect href={slug === "" ? browseHref("you") : settingsHref(slug)} />;
}

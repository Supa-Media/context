import { Redirect } from "expo-router";
import { useConsoleData } from "../../../../features/console/ConsoleDataContext";
import { browseHref, settingsHref } from "../../../../features/console/nav";
import { useContextSlug } from "../../../../features/console/useContextSlug";

/**
 * `/console/@:slug/settings` — kept, and now a redirect.
 *
 * Settings stopped being a route and became an overlay drawn over Browse by
 * `console/_layout.tsx`, addressed as `?settings=<section>`. The old path stays
 * because it is in the wild: the Dropbox failure notice links to it, the search
 * nudge rows link to it, and somebody has it in a chat. Every one of those must
 * keep landing on settings rather than on a dead page.
 *
 * `Redirect` rather than an effect: this route has nothing of its own to draw,
 * so rendering it and then navigating away would paint an empty pane for a
 * frame. The parameter form is produced by `settingsHref`, so there is one
 * place that knows the shape of the URL.
 */
export default function ContextSettingsRoute() {
  const data = useConsoleData();
  const slug = useContextSlug(data);
  return <Redirect href={slug === null ? browseHref("you") : settingsHref(slug)} />;
}

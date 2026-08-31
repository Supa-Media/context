import { Redirect } from "expo-router";
import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { landingHref } from "../../../features/console/nav";
import { MapPane } from "../../../features/console/panes/MapPane";

/**
 * `/console` — where signing in puts you, which is your notes.
 *
 * It used to render the Map: a constellation diagram of every context you can
 * reach. That is a good picture of what this product *is* and a bad answer to
 * what somebody opened the app to do. Nobody launches a notes app to look at a
 * diagram of their notes, and it was not a thing you visited — it was the thing
 * you got past, every time, before you could read anything.
 *
 * So this resolves to the first context in the rail's own order and redirects
 * to its Browse. The Map keeps a URL of its own (`/console/map`) and its place
 * at the top of the rail, one press away.
 *
 * ## Two states that are not the same, and only one of them redirects
 *
 * `landingHref` answers `null` both while the contexts are loading and for an
 * account that can reach none. Redirecting on the first would be a race with
 * the subscription; redirecting on the second would be a redirect to nowhere.
 * Drawing the Map covers both honestly: somebody with no contexts sees the one
 * pane that is about *not having* any, and somebody whose list is still in
 * flight sees it for the moment before it arrives rather than a blank screen.
 *
 * `Redirect` rather than `router.replace` in an effect: it acts during render,
 * so there is no frame in which this pane is mounted and painting. The rail's
 * half of the same problem is solved in `nav.ts` — `/console` is its own
 * `landing` route rather than an alias for the Map, so nothing in the rail
 * lights up on the way through.
 */
export default function ConsoleLanding() {
  const data = useConsoleData();
  const href = landingHref(data.contexts);
  if (href !== null) return <Redirect href={href} />;
  return <MapPane data={data} />;
}

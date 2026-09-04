import { Redirect } from "expo-router";
import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { landingStep } from "../../../features/console/lastPlace";
import { useLastPlace } from "../../../features/console/useLastPlace";
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
 * So this resolves to a context and redirects to its Browse. The Map keeps a
 * URL of its own (`/console/map`) and its place at the top of the rail, one
 * press away.
 *
 * ## Which context, and which note
 *
 * `landingDestination` decides, and the interesting half is that it can answer
 * with a **note**. This is the one URL in the app that is allowed to restore
 * something rather than describe it: `/console/@seyi?note=…` means that note
 * and nothing else, but bare `/console` means "wherever I was", and on a phone
 * relaunched from the home screen it is the only URL there is. Without it a
 * cold start dropped everybody at the top of their first context however long
 * they had spent in a note.
 *
 * The record is a destination and never an authorization — see `lastPlace.ts`.
 * It is read on the web too, where it answers the same question for a bookmark
 * of `/console` or the first screen after signing in.
 *
 * ## Three answers, and two of them are not a redirect
 *
 * `wait` paints nothing, for the one tick a local store read takes. `map`
 * covers the two states that have always shared an instruction — an account
 * that can reach no context, and a list still in flight — because somebody with
 * no contexts should see the pane that is *about* not having any, and somebody
 * waiting on a network round trip should see something rather than a blank
 * screen. Telling `wait` apart from `map` is not pedantry: collapsing them
 * paints the constellation and then redirects out of it, which is exactly the
 * flash this route was made to remove.
 *
 * `Redirect` rather than `router.replace` in an effect: it acts during render,
 * so there is no frame in which this pane is mounted and painting. The rail's
 * half of the same problem is solved in `nav.ts` — `/console` is its own
 * `landing` route rather than an alias for the Map, so nothing in the rail
 * lights up on the way through.
 */
export default function ConsoleLanding() {
  const data = useConsoleData();
  /*
    `!data.loading` is "the workspace list has arrived". An empty `contexts` is
    otherwise indistinguishable from a list still in flight, and the Map drawn
    for the second of those is a picture of an account with nothing in it.
  */
  const step = landingStep(data.contexts, useLastPlace(), !data.loading);
  if (step.action === "wait") return null;
  if (step.action === "redirect") return <Redirect href={step.href} />;
  return <MapPane data={data} />;
}

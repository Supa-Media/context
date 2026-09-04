import { useEffect, useRef, useState } from "react";
import { openStore } from "../offline/store";
import { RECALL_DEADLINE_MS, recallPlace, rememberPlace, type LastPlace } from "./lastPlace";

/**
 * The React half of "come back to the file you were on". The rules, and what
 * this is allowed to hold, are in `lastPlace.ts`.
 */

/**
 * What this device remembers, read once.
 *
 * Three values, and the caller must tell them apart: `undefined` is *still
 * asking* — the store is async on every platform — `null` is "this device does
 * not know", and a record is a destination. Collapsing the first two is how a
 * landing redirects to its default a frame before the answer arrives and then
 * cannot take it back.
 *
 * Read once per mount and never re-read. The only writer is this app, in this
 * process, and it writes what the console is already showing; re-reading would
 * be asking the device to tell us something we just told it.
 *
 * ## It is bounded, and that is not belt-and-braces
 *
 * `undefined` can hold the landing on a `wait`, so an unbounded read is a
 * screen this app cannot leave. `forget.ts` already states the rule this file
 * ignored: **`AsyncStorage` is a bridge call, and a wedged bridge never
 * settles**, so a `catch` is only half a failure stance and the other half is a
 * deadline. A store that has not answered by then is a device that does not
 * know, which is a state the landing already handles — it goes to the context
 * you own.
 *
 * What that costs when it fires is one launch's restore, and it is the right
 * thing to lose: the alternative is holding somebody on an empty pane for as
 * long as the bridge feels like taking.
 */
export function useLastPlace(): LastPlace | null | undefined {
  const [place, setPlace] = useState<LastPlace | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const settle = (answer: LastPlace | null) => {
      // A store that answers after the console has been left would otherwise
      // set state on an unmounted tree, and — worse — resolve a redirect for a
      // screen nobody is on.
      if (live) setPlace(answer);
      live = false;
    };
    const timer = setTimeout(() => settle(null), RECALL_DEADLINE_MS);
    void (async () => {
      const answer = await recallPlace(openStore());
      clearTimeout(timer);
      settle(answer);
    })();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  return place;
}

/**
 * Write where somebody is, whenever it changes.
 *
 * ## It writes on web too, and that is deliberate
 *
 * `lastPlace.ts` explains that the web's persistence is the URL. That is true
 * of a *reload*, and not of `/console` — the bare URL somebody bookmarks, or
 * lands on straight after signing in. Answering that with "the first context
 * you own" when this browser knows perfectly well where you were is the same
 * shrug the phone used to give, so the record is kept on both and `/console`
 * reads it on both. Every other web URL still means exactly what it says.
 *
 * ## `null` means do not write, and `placeFor` decides that
 *
 * A mid-navigation render, or a URL naming a context this account cannot reach,
 * is not a place. Writing either would put a record on the device for a screen
 * nobody was ever on — and in the second case would overwrite the record of
 * where somebody really was with the dead link they just followed.
 */
export function useRememberPlace(place: LastPlace | null): void {
  /*
    The last thing written, so an unchanged address does not re-enter the store
    on every render the console does — and it does a lot of them, one per
    keystroke while somebody is typing into a note.
  */
  const written = useRef<string | null>(null);
  const slug = place?.slug ?? null;
  const note = place?.note ?? null;

  useEffect(() => {
    if (slug === null) return;
    const key = `${slug}\n${note ?? ""}`;
    if (written.current === key) return;
    written.current = key;
    void rememberPlace(openStore(), { slug, note });
  }, [note, slug]);
}

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { currentEpoch } from "../offline/epoch";
import { openStore } from "../offline/store";
import {
  RECALL_DEADLINE_MS,
  contextHrefFor,
  recallPlace,
  recallPlaces,
  rememberPlace,
  type LastPlace,
} from "./lastPlace";

/**
 * The React half of "come back to the file you were on". The rules, and what
 * this is allowed to hold, are in `lastPlace.ts`.
 */

/* -------------------------------------------------------------------------- */
/*                        the log, live for this session                      */
/* -------------------------------------------------------------------------- */

/**
 * The log as the strip needs it: **live within a session**, not read once.
 *
 * `useLastPlace` below reads the device once per mount and never again, and
 * says why — the only writer is this app and re-reading is asking the device to
 * repeat what we just told it. That is right for a *landing redirect*, which
 * happens before anybody has navigated. It is wrong for the context strip,
 * which is ordered by this list and is on the screen while somebody moves
 * between contexts: read once, the strip would keep the order it had at launch
 * and put the context you are in third.
 *
 * So the device is read once and the answer is then kept here, and
 * `useRememberPlace`'s write updates it in the same move it writes. One writer
 * still, and the screen and the device cannot disagree.
 *
 * ## Why it is keyed by the session epoch
 *
 * Module state outlives a sign-out; `offline/epoch.ts` exists because that is
 * how a private note body ended up back in `localStorage` after one. What is
 * held here is milder — slugs and paths, not bodies — and it is still one
 * person's note names sitting in memory while the next person signs in on the
 * same process. `forgetLocalCopies` bumps the epoch before it removes anything,
 * so a snapshot stamped with a session that has ended is treated as absent and
 * re-read from a device that has just been cleared. It re-arms by itself, for
 * the reason that file gives: a barrier lowered by hand is one that stays
 * raised the day somebody forgets.
 */
let snapshot: { epoch: number; places: readonly LastPlace[] } | null = null;
const listeners = new Set<() => void>();

/** Frozen, so a subscriber comparing by identity does not re-render forever. */
const NO_PLACES: readonly LastPlace[] = Object.freeze([]);

function currentPlaces(): readonly LastPlace[] {
  return snapshot !== null && snapshot.epoch === currentEpoch() ? snapshot.places : NO_PLACES;
}

function publishPlaces(places: readonly LastPlace[]): void {
  snapshot = { epoch: currentEpoch(), places };
  for (const listener of listeners) listener();
}

function subscribePlaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop what this session was holding.
 *
 * Exported for the tests, which share one module instance across a file and
 * would otherwise carry one case's log into the next. Production does not call
 * it: sign-out bumps the epoch, which is the barrier, and a barrier that also
 * has a manual lever is a barrier with two ways to be wrong.
 */
export function resetPlaceCacheForTests(): void {
  snapshot = null;
  listeners.clear();
}

/**
 * Every context this device remembers, most recently visited first.
 *
 * Empty until the device answers, which is a tick. The strip's ordering treats
 * an unknown context as least-recent, so a first paint puts the contexts in the
 * order the control plane sent — the same list, unordered by recency, rather
 * than a strip that is empty for a frame.
 *
 * ## The read carries the epoch it was issued under
 *
 * `epoch.ts`'s pattern, verbatim: *"`useOfflineNotes` captures the number once
 * at mount. Everything that mount ever writes carries that capture."* This
 * effect writes to module memory when the device answers, and nothing cancels a
 * store read — so the number has to be captured when the read starts rather
 * than consulted when it lands.
 *
 * **It used to be consulted when it landed, and that left the barrier open in
 * one direction.** The condition asked whether the *snapshot* belonged to the
 * current session, and on a cold console there is no snapshot at all: read the
 * device, sign out before it answers, and `snapshot === null` was enough to
 * publish one person's context slugs and note names into the memory the next
 * person's strip reads. The clear had already run and had nothing to clear.
 * `a device answer that resolves after a sign-out is dropped, not published`
 * in `lastPlaceConsole.test.ts` holds it, by holding the read open across a
 * real `forgetLocalCopies`.
 */
export function useContextPlaces(): readonly LastPlace[] {
  const places = useSyncExternalStore(subscribePlaces, currentPlaces, currentPlaces);

  useEffect(() => {
    // Once per session, not once per mount: a second console mount inside one
    // session already has the answer, and re-reading would overwrite the
    // navigations this session has since recorded with the device's older copy.
    if (snapshot !== null && snapshot.epoch === currentEpoch()) return;
    const epoch = currentEpoch();
    let live = true;
    void (async () => {
      const answer = await recallPlaces(openStore());
      if (!live) return;
      // The session this read belongs to has ended. See the header: nothing
      // cancels the read, and what it is carrying is the previous person's.
      if (epoch !== currentEpoch()) return;
      // ...and this session has already recorded something since.
      if (snapshot !== null && snapshot.epoch === epoch) return;
      publishPlaces(answer);
    })();
    return () => {
      live = false;
    };
  }, []);

  return places;
}

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
 *
 * ## The screen is updated first, and the device catches up
 *
 * The strip is ordered by this log, so a write that only reached the device
 * would reorder the strip on the *next* launch rather than now. The in-memory
 * snapshot is therefore moved in the same tick, by the same rule
 * `rememberPlace` applies — the slug to the front, wherever it was — and the
 * store write follows. Both apply one rule to one list; the device is the copy
 * that survives, and the snapshot is the copy that is on screen.
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
    publishPlaces([
      { slug, note },
      ...currentPlaces().filter((entry) => entry.slug !== slug),
    ]);
    void rememberPlace(openStore(), { slug, note });
  }, [note, slug]);
}

/**
 * Where pressing a context in the strip should send somebody, resolved now.
 *
 * `contextHrefFor`'s rules, bound to what this device remembers and to the list
 * the console holds. **Resolved at press time, never cached**: the log moves
 * under it on every navigation, so an href worked out when the strip rendered
 * is the answer to where somebody was two contexts ago.
 */
export function useContextHref(
  contexts: ReadonlyArray<{ slug: string }>,
): (slug: string, options?: { resolves?: (path: string) => boolean }) => string {
  const places = useContextPlaces();
  return useCallback(
    (slug, options) => contextHrefFor(places, contexts, slug, options),
    [places, contexts],
  );
}

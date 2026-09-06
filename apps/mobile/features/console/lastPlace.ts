import type { KeyValueStore } from "../offline/memory";
import { browseHref, landingHref, noteHref, safeNotePath } from "./nav";

/**
 * The file page a phone comes back to.
 *
 * ## Why the web half of this is not here
 *
 * On the web there is nothing to store. `?note=` *is* the persistence — a URL
 * survives a refresh, a hard reload, a crashed tab and a bookmark, and it is
 * the same string somebody can paste to a colleague. `noteAddress.ts` keeps it
 * in step with the open note and that is the whole feature.
 *
 * A phone has no address bar. Backgrounding is survivable without help — the
 * process is still there and so is the router's state — but a **cold relaunch**
 * starts at `/`, which resolves to `/console`, which resolves to the first
 * context this account owns. Somebody who was reading a note, took a call, and
 * came back an hour later got the top of their brain and no way back to where
 * they were except finding it again.
 *
 * So this is one record, written as the address changes and read once by
 * `/console` before it decides where to send somebody.
 *
 * ## It is a *log*, and that is what makes it one store rather than two
 *
 * A phone's context strip has to answer two questions that look unrelated and
 * are the same fact: **what order do the contexts go in** (current first, then
 * most recently visited) and **where does pressing one land you** (the path you
 * had open there, not that context's root). Both are "when was I last in this
 * context, and where".
 *
 * So the record is a list of places rather than one, kept most-recent-first,
 * and the previous single record is its head. `recallPlace` still answers
 * exactly what it did — `/console`'s redirect is unchanged — and
 * `lastPathFor` and `contextHrefFor` read the rest of it.
 *
 * Two stores would have been the obvious shape and would drift on the first
 * navigation that wrote one and not the other: a strip ordered by a list that
 * has not heard about the place `/console` is about to restore. There is one
 * writer (`rememberPlace`), and it moves a slug to the front.
 *
 * **It is per device, not per account.** Somebody's phone and their laptop are
 * in different contexts for different reasons, and an order synced between them
 * would be one machine reordering the other's navigation. The control plane is
 * never told any of this.
 *
 * ## What it holds, and what it must never hold
 *
 * A context **slug** and a bucket **path**. Identifiers, not content: no note
 * text, no etag, no draft, and above all no credential (non-negotiable #1 —
 * credentials never live on a device). A path is not nothing — it is the name
 * of one of somebody's notes — which is why this is cleared on sign-out along
 * with the offline copies, by `forgetLocalCopies`.
 *
 * **It is not an authorization.** Restoring it navigates to a console URL, and
 * that URL is gated exactly as it would be if somebody typed it: the `(app)`
 * layout demands a session, and `resolveContextRoute` redirects to the landing
 * for a context this account cannot reach. A record naming a context somebody
 * was removed from therefore lands them where a dead link lands them, which is
 * the same answer and not a special case. `__tests__/lastPlace.test.ts` pins
 * that a record is a *destination* and never a claim.
 *
 * ## The version segment
 *
 * `v2`, for the reason `offline/keys.ts` argues at length: a shape change makes
 * old records unreachable rather than feeding them to a parser that no longer
 * understands them. This one is cheap to orphan — losing it costs one
 * navigation, not somebody's typing — so a bump here needs no ceremony beyond
 * changing the string. `v1` held the single record this log's head replaces;
 * `placeKeys` still matches it, so sign-out takes it and nothing reads it.
 *
 * The namespace is deliberately **not** `context.lc.offline`. That namespace's
 * `sweep()` deletes every key under it whose version segment is not current,
 * and this record's shape has nothing to do with the cache's.
 */

const NAMESPACE = "context.lc.place";
const VERSION = "v2";
const KEY = `${NAMESPACE}.${VERSION}.visits`;

/**
 * How many contexts the log remembers.
 *
 * Nobody is a member of thirty-two contexts, which is the point: this is not a
 * budget, it is the answer to a device that has been signed into for two years.
 * The entries past the end are the ones nothing would order the strip by
 * anyway, and dropping the oldest is the only eviction rule that cannot lose
 * the one somebody is in.
 *
 * It bounds a list of *identifiers* rather than content — see above — so the
 * cost of the cap being generous is bytes, and the cost of it being tight is a
 * context that resets to its root because a device forgot it.
 */
export const MAX_REMEMBERED_CONTEXTS = 32;

/**
 * How long the device gets to answer before the landing stops waiting.
 *
 * Not a latency budget — a healthy `AsyncStorage` or `localStorage` read is
 * single-digit milliseconds — but the answer to a bridge that has stopped
 * answering, which is `forget.ts`'s stance applied to the one read that can
 * hold a screen. Short enough that nobody experiences it as a launch that hung,
 * and long enough that a cold bridge waking up still wins.
 */
export const RECALL_DEADLINE_MS = 600;

/** Where somebody was: which context, and which note or folder in it. */
export interface LastPlace {
  slug: string;
  /** `null` for a context with nothing open — still worth restoring. */
  note: string | null;
}

/**
 * Every key this module owns, current version or not.
 *
 * A function rather than the constant, because sign-out has to take the stale
 * ones too: a record written by a previous shape is still the name of one of
 * somebody's notes sitting on a device that has been signed out of.
 */
export function placeKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith(`${NAMESPACE}.`));
}

/**
 * Remember where somebody is, at the head of the log.
 *
 * Read-modify-write, and the *modify* is the whole of the ordering rule: the
 * entry for this slug is removed wherever it was and put back at the front, so
 * the list is "most recently visited" by construction rather than by a
 * timestamp somebody has to sort by. A timestamp would also be a second thing
 * to get right — two devices, a clock that moved, a record restored from a
 * backup — for an order that only has to be *this device's*.
 *
 * Fire-and-forget, and failures are swallowed: not being able to write this is
 * one missed restore, and there is no screen it would be honest to interrupt to
 * say so. That is the opposite of `offline/store.ts`'s rule for a *draft*,
 * where a silent failure loses somebody's typing — the asymmetry is deliberate
 * and is why this does not simply reuse that module's writer.
 *
 * The read-then-write is not atomic and does not need to be. There is one
 * writer, it runs on the app's own thread, and the worst outcome of a lost race
 * is a context ordered one place lower than it should be.
 */
export async function rememberPlace(
  store: KeyValueStore,
  place: LastPlace,
): Promise<void> {
  try {
    const kept = (await recallPlaces(store)).filter((entry) => entry.slug !== place.slug);
    const next = [{ slug: place.slug, note: place.note }, ...kept].slice(
      0,
      MAX_REMEMBERED_CONTEXTS,
    );
    await store.set(KEY, JSON.stringify(next));
  } catch {
    // See above.
  }
}

/**
 * Every context this device remembers, most recently visited first.
 *
 * Everything is re-validated on the way out. It is a file this process wrote,
 * but it is a file on a device — a rooted browser, a restored backup, another
 * app with the same store — and a path read back off one goes into a request to
 * somebody's bucket. `safeNotePath` is the same rule the URL and the link
 * grammar go through, for the same reason.
 *
 * **A bad entry is dropped; it does not condemn the list.** The single-record
 * version answered `null` to any malformed record, which was the whole answer
 * because the record was the whole store. Here one unparseable entry out of
 * eight would cost somebody the order of the other seven, so entries are
 * filtered rather than the file refused — and a *file* that is not a list still
 * answers empty, because at that point nothing in it is trustworthy.
 *
 * Duplicate slugs are collapsed to the first, which is the most recent: a log
 * that named a context twice would order the strip by an entry the writer had
 * already superseded.
 */
export async function recallPlaces(store: KeyValueStore): Promise<LastPlace[]> {
  let raw: string | null;
  try {
    raw = await store.get(KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const places: LastPlace[] = [];
  for (const entry of parsed) {
    const place = placeFromRecord(entry);
    if (place === null || seen.has(place.slug)) continue;
    seen.add(place.slug);
    places.push(place);
    if (places.length === MAX_REMEMBERED_CONTEXTS) break;
  }
  return places;
}

/**
 * Where somebody was, or `null` if this device does not know.
 *
 * The head of the log. `/console`'s redirect is unchanged by the log's arrival:
 * the most recently visited context, at the path that was open in it, is
 * exactly the single record this used to read.
 */
export async function recallPlace(store: KeyValueStore): Promise<LastPlace | null> {
  return (await recallPlaces(store))[0] ?? null;
}

/** One entry, validated, or `null`. See `recallPlaces`. */
function placeFromRecord(parsed: unknown): LastPlace | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const { slug, note } = parsed as { slug?: unknown; note?: unknown };
  if (typeof slug !== "string") return null;
  /*
    A slug is a path segment in the URL this becomes. `@` is added back by
    `contextSegment`, so a stored value carrying one of its own — or a slash, a
    dot, or a query — is a record that would build a different URL than the one
    it names, and is refused rather than repaired.

    This is a *shape* check for URL safety and not the naming rule: the
    authority on what a name may be is `validateName` in the control plane
    (`[a-z0-9-]`, no leading or trailing hyphen, a reserved list), and the
    authority on whether a name is *yours* is the context list `landingStep`
    checks against. Duplicating either here would be a second rule to keep in
    step; being narrower than both costs at most one restore.
  */
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;

  if (note === null || note === undefined) return { slug, note: null };
  if (typeof note !== "string") return null;
  const path = safeNotePath(note);
  return path === null ? null : { slug, note: path };
}

/** Forget it. Called from sign-out, beside the offline copies. */
export async function forgetPlace(store: KeyValueStore): Promise<void> {
  for (const key of placeKeys(await store.keys())) {
    await store.remove(key);
  }
}

/**
 * The place to remember for a console URL, or `null` for "do not write".
 *
 * The guard is that the slug names a context this account can actually reach.
 * Without it, following one dead link — a `@name` somebody was removed from, or
 * mistyped — overwrites the record of where they really were, and the next cold
 * start puts them at the top of their first context instead of back in the note
 * they had open before the detour. The console redirects away from that URL a
 * moment later anyway, so what would be stored is a screen nobody was on.
 */
export function placeFor(
  contexts: ReadonlyArray<{ slug: string }>,
  slug: string | null,
  note: string | null,
): LastPlace | null {
  if (slug === null) return null;
  if (!contexts.some((context) => context.slug === slug)) return null;
  return { slug, note };
}

/** The console URL a remembered place names. */
export function placeHref(place: LastPlace): string {
  return place.note === null ? browseHref(place.slug) : noteHref(place.slug, place.note);
}

/**
 * The path this device last had open in one context, or `null`.
 *
 * Pure, and separate from `contextHrefFor` because it is the piece a caller
 * wants when it is deciding something other than a URL — whether a pill has a
 * note behind it, say. `null` means "the root", which is also what a context
 * nobody has visited answers.
 */
export function lastPathFor(places: readonly LastPlace[], slug: string): string | null {
  return places.find((place) => place.slug === slug)?.note ?? null;
}

/**
 * Where pressing a context should land somebody.
 *
 * **The default is the path they had open there, not that context's root.**
 * Switching context is not "start again over here", it is "go back to what I
 * was doing over here", and a console that resets to the root on every switch
 * makes moving between two contexts cost a walk down the tree each time. That
 * is the whole reason the log is a log.
 *
 * Three ways it falls back to the root, and they fail separately:
 *
 *  - **The device remembers nothing about this context.** First visit, or the
 *    entry aged past `MAX_REMEMBERED_CONTEXTS`.
 *  - **The person cannot reach the context.** `contexts` is the list the console
 *    holds, and a slug missing from it is one they were removed from or one this
 *    device made up. It answers `browseHref` rather than the note, and that is
 *    belt and braces rather than the security boundary: `resolveContextRoute`
 *    redirects a dead context and the gateway refuses the read either way. What
 *    it buys is not putting somebody's note name into the address bar on the way
 *    through a redirect they are about to be bounced out of — the same reason
 *    `landingStep` ignores rather than follows such a record.
 *  - **The path no longer resolves**, as far as the caller can tell. `resolves`
 *    is optional and is the caller's own knowledge of its tree; where it is
 *    absent this trusts the stored path.
 *
 * **What it cannot check, stated rather than implied:** whether the note is
 * still in the bucket. That is a round trip, the tree is loaded folder by folder
 * so the console genuinely does not know about the parts nobody has expanded,
 * and requiring existence would send every switch to the root. A note deleted
 * from another device therefore lands on the editor's own "that file does not
 * exist" — which is exactly where a stale `?note=` link already lands, and is
 * the answer Obsidian gives.
 */
export function contextHrefFor(
  places: readonly LastPlace[],
  contexts: ReadonlyArray<{ slug: string }>,
  slug: string,
  options: {
    /**
     * Whether the caller can still see that path. Optional: a caller with no
     * opinion is not the same as a caller saying no, and defaulting to "gone"
     * would send every switch to the root — the behaviour this exists to end.
     */
    resolves?: (path: string) => boolean;
  } = {},
): string {
  if (!contexts.some((context) => context.slug === slug)) return browseHref(slug);
  const path = lastPathFor(places, slug);
  if (path === null) return browseHref(slug);
  if (options.resolves && !options.resolves(path)) return browseHref(slug);
  return noteHref(slug, path);
}

/**
 * What `/console` does, now that this device may remember.
 *
 * The default half is still `landingHref` and is not re-decided here — that
 * function's comment is emphatic about why "which context does `/console` open
 * on" is answered in exactly one place, and a remembered place is a *previous*
 * answer to it, not a second rule.
 *
 * ## Three answers, because `wait` and `map` are not the same frame
 *
 * This started as two — a href or `null`, with the caller drawing the Map for
 * `null` — and that quietly reintroduced the flash `/console` exists to remove.
 * The store is asked asynchronously on every platform, so for the first commit
 * after mount there is no answer yet; collapsing that into `null` painted the
 * constellation and then redirected out of it, on the transition somebody sees
 * most often. `consoleLanding.test.ts` has asserted "the Map is never mounted
 * on the way through" since before this feature existed, and it caught it.
 *
 * So the unanswered device is `wait` — paint nothing, for the tick a local
 * store read takes — and `map` stays what it always meant: this account can
 * reach no context, or its list has not landed. The second of those is a
 * network round trip and genuinely wants a pane rather than a blank screen,
 * which is the difference between the two.
 *
 * A record naming a context that is **not in the list** is ignored rather than
 * followed. Following it would work — `resolveContextRoute` redirects a dead
 * context to the landing — but it would work by putting the name of a context
 * somebody has lost into the address bar on the way through.
 */
export type LandingStep =
  /** This device has not answered yet, and there is a redirect to protect. */
  | { action: "wait" }
  /** No context to go to: the list is empty, or has not arrived. */
  | { action: "map" }
  | { action: "redirect"; href: string };

export function landingStep(
  contexts: ReadonlyArray<{ slug: string; role: string }>,
  /** `undefined` while the device is still being asked. */
  place: LastPlace | null | undefined,
  /**
   * Whether the workspace list has actually arrived.
   *
   * An empty `contexts` is two different facts and this is the one that tells
   * them apart. Without it a cold launch cannot distinguish an account with no
   * contexts from an account whose contexts are one round trip away.
   */
  listed: boolean,
): LandingStep {
  /*
    **The list has not arrived, so there is nothing true to draw.**

    This used to answer `map` here, on the reasoning that "the Map is what this
    route draws anyway until the list arrives". Filmed on a cold launch of the
    native app, that reasoning was wrong twice over. The Map is *not* what this
    route draws for somebody who has contexts — it is a screen they are about
    to be redirected out of — so it appeared for a single frame between two
    blanks, which is a flicker by construction. And the Map it drew was a
    picture of an account with nothing in it: "0 reachable", "0 connected", a
    lone "You" node, "0 in your context". Every number in it was a count of a
    list that had not been fetched.

    So the Map is for the account that really has no contexts, which is a fact
    this route only knows once `listed`. Until then the console draws its own
    chrome around a quiet pane — which is the state it is in a moment later
    anyway, while the note it is heading for is read, so waiting here adds no
    transition rather than adding a wrong one.
  */
  if (!listed) return { action: "wait" };
  if (place === undefined) {
    /*
      The device is being asked and the list is in hand. `map` here would be
      the constellation flashing on the way to a redirect — the flash this
      route exists to remove — so nothing is painted for the tick an
      `AsyncStorage` read takes. It is bounded: see `RECALL_DEADLINE_MS`.

      With the list in hand and genuinely empty there is nothing to flash past,
      and the Map is the honest answer rather than a placeholder.
    */
    return contexts.length === 0 ? { action: "map" } : { action: "wait" };
  }
  if (place !== null && contexts.some((context) => context.slug === place.slug)) {
    return { action: "redirect", href: placeHref(place) };
  }
  const href = landingHref(contexts);
  return href === null ? { action: "map" } : { action: "redirect", href };
}

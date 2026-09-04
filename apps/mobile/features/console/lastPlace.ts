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
 * `v1`, for the reason `offline/keys.ts` argues at length: a shape change makes
 * old records unreachable rather than feeding them to a parser that no longer
 * understands them. This one is cheap to orphan — losing it costs one
 * navigation, not somebody's typing — so a bump here needs no ceremony beyond
 * changing the string.
 *
 * The namespace is deliberately **not** `context.lc.offline`. That namespace's
 * `sweep()` deletes every key under it whose version segment is not current,
 * and this record's shape has nothing to do with the cache's.
 */

const NAMESPACE = "context.lc.place";
const VERSION = "v1";
const KEY = `${NAMESPACE}.${VERSION}.last`;

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
 * Remember where somebody is.
 *
 * Fire-and-forget, and failures are swallowed: not being able to write this is
 * one missed restore, and there is no screen it would be honest to interrupt to
 * say so. That is the opposite of `offline/store.ts`'s rule for a *draft*,
 * where a silent failure loses somebody's typing — the asymmetry is deliberate
 * and is why this does not simply reuse that module's writer.
 */
export async function rememberPlace(
  store: KeyValueStore,
  place: LastPlace,
): Promise<void> {
  try {
    await store.set(KEY, JSON.stringify({ slug: place.slug, note: place.note }));
  } catch {
    // See above.
  }
}

/**
 * Where somebody was, or `null` if this device does not know.
 *
 * Everything about the record is re-validated on the way out. It is a file this
 * process wrote, but it is a file on a device — a rooted browser, a restored
 * backup, another app with the same store — and a path read back off one goes
 * into a request to somebody's bucket. `safeNotePath` is the same rule the URL
 * and the link grammar go through, for the same reason.
 */
export async function recallPlace(store: KeyValueStore): Promise<LastPlace | null> {
  let raw: string | null;
  try {
    raw = await store.get(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
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
  /** This device has not answered yet. One tick, and nothing painted. */
  | { action: "wait" }
  /** No context to go to: the list is empty, or has not arrived. */
  | { action: "map" }
  | { action: "redirect"; href: string };

export function landingStep(
  contexts: ReadonlyArray<{ slug: string; role: string }>,
  /** `undefined` while the device is still being asked. */
  place: LastPlace | null | undefined,
): LandingStep {
  if (place === undefined) return { action: "wait" };
  if (place !== null && contexts.some((context) => context.slug === place.slug)) {
    return { action: "redirect", href: placeHref(place) };
  }
  const href = landingHref(contexts);
  return href === null ? { action: "map" } : { action: "redirect", href };
}

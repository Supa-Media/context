import type { DotTone } from "../design/components/Dot";
import type { ConsoleContext } from "./types";

/**
 * What goes on a phone's context strip, and in what order.
 *
 * The rules are here rather than in `ContextStrip.tsx` for the reason
 * `frame.ts` gives about `regionsFor`: an ordering is the part of a navigation
 * surface that goes wrong quietly, and a rule decided from data is a rule with
 * tests in a suite that runs in plain node with no renderer. It is named the
 * way `rail.ts` is named beside `ConsoleRail.tsx`, and that is not only
 * convention: this file was briefly `contextStrip.ts`, and on a case-insensitive
 * filesystem `require("./ContextStrip")` resolved **here** rather than to the
 * component, because `.ts` is tried before `.tsx`. The component came back
 * `undefined` with no error from the resolver — and on a case-sensitive CI box
 * it would have resolved the other way, which is the shape of bug that is a
 * green suite on one machine and a blank screen on another.
 *
 * ## The strip replaces two headed groups with one row, and pays for it twice
 *
 * The rail splits the contexts into **Brains** and **Workspaces**, and
 * `rail.ts` argues for that split at length: the two kinds are the product's
 * two nouns, and the rail is the one surface where a person meets both. A strip
 * cannot have headings — it is one row, 34pt tall, on a 390pt phone — so the
 * split has to go somewhere else or go away.
 *
 * It goes onto the dot. `toneForKind` below is what carries the fact the
 * headings carried, and the entries are one undivided list.
 *
 * **That reuses a glyph that means something else in the rail, and the reason
 * it is not a collision is that the two are never on the screen together.** The
 * rail's `Dot` is the context's *storage status* — `ok`, `warn`, `crit` from
 * `ConsoleContext.status` — and it exists at medium and wide. The strip exists
 * at compact and nowhere else (`frame.ts`). One device, one width, one meaning.
 * The day something puts a rail and a strip on one screen, this is the decision
 * that has to be revisited rather than the component.
 *
 * The second cost is real and is not hidden: **the strip does not show storage
 * status at all.** A phone learns that a bucket is unreachable from the context
 * banner and the settings pane, which say it in words, rather than from a 7px
 * pip in a row somebody is scrolling. A pip that meant "unreachable" on one
 * surface and "workspace" on another would be worse than either.
 */

/**
 * Brain or workspace, as a colour.
 *
 * Two tones, and `warn` and `crit` are deliberately not among them: those are
 * the alarm colours the rail's status pip uses, and a *kind* drawn in one of
 * them is a permanent alert about nothing. A brain takes `ok` — the accent-side
 * colour, for the thing that is yours — and a workspace takes `neutral`.
 *
 * Read off `kind` and not off `role`. A workspace you own is still a workspace;
 * ownership is not what this says, and `rail.ts` records why marking it is a
 * mark on one row rather than a division of the list.
 */
export function toneForKind(context: ConsoleContext): DotTone {
  return context.kind === "personal" ? "ok" : "neutral";
}

/**
 * The contexts, in the order the strip draws them.
 *
 * **The context you are in is not among them.** It is the button at the head of
 * the breadcrumb — see `NavBand` — so this row is the contexts you can switch
 * *to*, and nothing on it is lit. That is the whole shape the owner asked for:
 * "when I'm on a workspace, the button for that workspace should move to the
 * breadcrumb… so I'm still able to get to the root". Two rows that each named
 * the current context was the defect; drawing it in neither would have been
 * worse, and was shipped once.
 *
 * **Most recently visited first, and never alphabetical.** The order is the
 * order somebody is actually moving in, so the context they are about to want
 * is the next one along rather than wherever its name falls in the alphabet. An
 * alphabetical strip is stable and useless: it puts `@acme` in front of the two
 * contexts somebody has been alternating between all morning, forever.
 *
 * (This used to read "current first, then most recently visited", on the
 * argument that the first pill answers "where am I" for free. That question is
 * answered better by the breadcrumb button, which also answers "how do I get
 * back to the root of it" — which the lit pill never did.)
 *
 * A context this device has never recorded a visit to sorts **after** every one
 * it has, keeping the order the control plane sent among themselves — the same
 * rule `rail.ts` states as "the pin is a pin, not a sort". A first paint, before
 * the device has answered, is therefore the control plane's own order with the
 * current context pinned in front, which is a sensible strip rather than an
 * empty one.
 *
 * `recent` is the log from `lastPlace.ts`, most recently visited first. It is
 * taken as bare slugs rather than as the log's own type so that this file
 * imports no store — the strip is ordered by a list, and where the list comes
 * from is the caller's business.
 */
export function stripOrder(
  contexts: readonly ConsoleContext[],
  currentSlug: string | null,
  recent: ReadonlyArray<{ slug: string }>,
): ConsoleContext[] {
  const rank = new Map<string, number>();
  recent.forEach((entry, index) => {
    if (!rank.has(entry.slug)) rank.set(entry.slug, index);
  });

  // The current context is drawn in the breadcrumb, not here. See the header.
  const rest = contexts.filter((context) => context.slug !== currentSlug);
  /*
    Two passes rather than one comparator with a sentinel rank. A sentinel —
    `rank.get(slug) ?? Infinity` — sorts the unvisited contexts against each
    other by whatever the engine's sort does with equal keys, and V8's is only
    stable because the spec now requires it; the intent here is that they are
    not sorted at all, and expressing that as "not passed to sort" says it
    better than a comment claiming a tie is safe.
  */
  const visited = rest
    .filter((context) => rank.has(context.slug))
    .sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!);
  const unvisited = rest.filter((context) => !rank.has(context.slug));

  return [...visited, ...unvisited];
}

/** The two verbs that live at the end of the strip. See `stripEntries`. */
export interface StripEnds {
  /** "Claim your @name" — see `rail.ts`. Accented, and gone once used. */
  claim: boolean;
  /** "New workspace". Permanent, so drawn quietly. */
  create: boolean;
}

/**
 * Whether the strip is drawn at all.
 *
 * **An empty row is a band of chrome that does nothing**, so it is not drawn.
 * Now that the current context has moved to the breadcrumb, somebody with one
 * brain and no workspaces has *nothing* to switch to — and their name is on the
 * screen anyway, at the head of the path. The 34pt band goes back to the note.
 *
 * The count is of *things on the strip*, not of contexts, and that distinction
 * is load-bearing rather than pedantic. "New workspace" and "Claim your @name"
 * are destinations — `rail.ts` says of the first that it is "the *whole* group
 * for somebody who is in no workspaces yet, which is how a person who has only
 * ever had a brain finds out that workspaces exist". Counting contexts only
 * would take that away from exactly the person it was written for: one brain,
 * no workspaces, a phone, and no other surface offering it. So somebody with
 * one context and something to reach still gets a strip, and somebody with one
 * context and nothing to reach — the landing page's picture of the console,
 * where every callback is absent — gets none.
 *
 * **The threshold moved from `> 1` to `> 0` with the current context.** It was
 * one because the row always held the pill for where you are, which is a label
 * rather than a control; there is no such pill any more, so every entry left is
 * somewhere you can actually go.
 */
export function stripEntries(
  contexts: readonly ConsoleContext[],
  currentSlug: string | null,
  recent: ReadonlyArray<{ slug: string }>,
  ends: StripEnds,
): ConsoleContext[] | null {
  const ordered = stripOrder(contexts, currentSlug, recent);
  const total = ordered.length + (ends.claim ? 1 : 0) + (ends.create ? 1 : 0);
  return total > 0 ? ordered : null;
}

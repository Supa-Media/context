import { capabilitiesForRole } from "../console/capabilities";
import { parentPath } from "../console/files/paths";
import { ownPersonalContext } from "../console/identity";
import { DEFAULT_TARGET_FOLDER } from "../console/ingestion/settings";
import { safeNotePath } from "../console/nav";
import type { KeyValueStore } from "../offline/memory";
import { destinationKey } from "./keys";

/**
 * Where a meeting is going to land, decided **before** the microphone opens.
 *
 * ## Why this is a question at all
 *
 * A meeting is a capture, and until now the answer was implicit: the gateway
 * derived `0-inbox/meetings/YYYY/MM/…` from the session and nothing on the
 * device ever said a word about it (`packages/meetings/src/paths.js`). That is
 * a fine default and a bad *only* answer, because the person recording is
 * usually looking at something — a project folder, a note — and the meeting
 * belongs beside it. The moment a second answer exists it has to be asked for,
 * and the asking is what this module is the model for.
 *
 * ## The default is the person's own brain, whatever context they are in
 *
 * This is the whole point of the module and it is a privacy rule rather than a
 * convenience. Somebody reading a note in a shared workspace who presses record
 * is, on any "current context" default, dropping a transcript of a conversation
 * they have not read yet into a folder their colleagues are watching. So the
 * first offer is always `@their-handle / 0-inbox`, it is always the fallback,
 * and the current page is the *second* offer with the audience named on it.
 *
 * ## It is a pure module, and that is `console/capabilities.ts`'s reason
 *
 * Every guard in the console that was expressed inside a hook or a component
 * survived a full sabotage sweep untouched; every guard expressed as a pure
 * module was held. A rule about where somebody's meeting lands is exactly the
 * kind that must be reachable from a test without a renderer, so nothing here
 * imports React and the sheet holds no rule of its own.
 *
 * ## Nothing here touches storage
 *
 * Asking the question creates no folder. `0-inbox` that does not exist yet is
 * made by the write that puts the note in it — a folder created by a question
 * somebody cancelled is litter in a bucket the customer owns, and this product
 * does not leave any. There is nothing to undo because there was never anything
 * to do: a destination is two strings until a note is written.
 */

/**
 * The inbox, taken from where this product already files an unfiled capture.
 *
 * `DEFAULT_TARGET_FOLDER` is where forwarded mail lands, and a meeting is the
 * same kind of thing — captured, unfiled, moved later by a person. Deriving it
 * rather than typing `"0-inbox"` a second time is the difference between one
 * decision and two spellings that drift; the trailing slash is that constant's
 * (it names a *prefix* for the ingestion settings) and a folder here has none,
 * because it is joined to a path rather than prepended to a key.
 */
export const INBOX_FOLDER = DEFAULT_TARGET_FOLDER.replace(/\/+$/, "");

/** What a person can see, and what they can see it in. `Only you` / warn. */
export const ONLY_YOU = "Only you";
export const VISIBLE_TO_TEAM = "Visible to the team";

/** Said on the row rather than instead of it. See `resolveDestinations`. */
export const READ_ONLY_REFUSAL =
  "You can read this context but not write to it, so a meeting cannot land here.";

/** How the root of a context is named, matching the console's move picker. */
export const CONTEXT_ROOT_LABEL = "the root of your context";

export type MeetingDestination =
  | { kind: "personalInbox"; contextSlug: string; folder: string }
  | { kind: "currentPage"; contextSlug: string; folder: string; label: string };

/**
 * One context the viewer can reach, as this module needs it.
 *
 * Structurally typed rather than importing `ConsoleContext`, for the reason
 * `identity.ts` types its own `IdentityContext` that way: the caller is a
 * console screen today and a bottom-row key tomorrow, and neither should have
 * to build a console row to ask this question.
 */
export interface DestinationContext {
  slug: string;
  /** `personal` | `shared`. A value this build does not know is not personal. */
  kind: string;
  /** `owner` | `editor` | `member`. Anything else may not write. */
  role: string;
}

/** Where the viewer is standing, or `null` when that is nowhere in particular. */
export interface CurrentPage {
  contextSlug: string;
  /** The bucket path on screen. `""` is the context's root. */
  path: string;
  /** True when `path` names a note rather than a folder. */
  isNote: boolean;
}

export interface DestinationOffer {
  destination: MeetingDestination;
  /** Who will see a meeting written here, in words. */
  audience: string;
  /** `warn` is the design's warning tone for an audience that is not just you. */
  tone: "quiet" | "warn";
  /**
   * Why this offer cannot be taken, or `null`.
   *
   * A refused offer is **still an offer**: it is drawn dimmed with this
   * sentence beside it, never removed. CLAUDE.md's rule is that an absent
   * capability is reported rather than faked, and the console draws every
   * disabled control the same way — removing the row leaves somebody hunting
   * for a choice the product told them they had.
   */
  refusal: string | null;
}

export type DestinationChoice =
  | { kind: "choose"; offers: DestinationOffer[]; selectedIndex: number }
  /**
   * The viewer owns no brain, so there is no inbox to default to and nothing
   * to record into yet. The sheet offers to claim their @name instead.
   */
  | { kind: "claimName" };

/**
 * What to offer, and which row is selected.
 *
 * The order is the design's and is not a preference: the personal inbox is
 * first because it is the default, and `selectedIndex` falls back to it for
 * every case a remembered choice cannot be honoured.
 */
export function resolveDestinations(input: {
  contexts: readonly DestinationContext[];
  page: CurrentPage | null;
  /** What this device chose last time, from `recallDestination`. */
  remembered?: MeetingDestination | null;
}): DestinationChoice {
  const own = ownPersonalContext(input.contexts);
  if (own === null) return { kind: "claimName" };

  const offers: DestinationOffer[] = [
    {
      destination: { kind: "personalInbox", contextSlug: own.slug, folder: INBOX_FOLDER },
      /*
        NOTE: this is a statement about membership, not about `privacy.md`. A
        brain has exactly one member unless its owner has granted somebody
        access, and the context list this module is handed cannot see a grant.
        Naming that case would need the member list, which is a round trip this
        sheet must not wait on.
      */
      audience: ONLY_YOU,
      tone: "quiet",
      refusal: null,
    },
  ];

  const page = pageOffer(input.page, input.contexts, own);
  if (page !== null && !sameDestination(page.destination, offers[0]!.destination)) {
    offers.push(page);
  }

  return { kind: "choose", offers, selectedIndex: preselect(offers, input.remembered ?? null) };
}

/**
 * The current page as a destination, or `null` when it is not one.
 *
 * Three ways it is not: there is no page, the page names a context this person
 * is not a member of — a stale URL, not a destination — or its path is not
 * something that could be a key in somebody's bucket. The last is
 * `safeNotePath`, which is the same gate the `?note=` query and the last-place
 * record go through, for the same reason: this string ends up in a write.
 */
function pageOffer(
  page: CurrentPage | null,
  contexts: readonly DestinationContext[],
  own: DestinationContext,
): DestinationOffer | null {
  if (page === null) return null;

  const context = contexts.find((candidate) => candidate.slug === page.contextSlug);
  if (context === undefined) return null;

  if (page.path !== "" && safeNotePath(page.path) === null) return null;
  const folder = page.isNote ? parentPath(page.path) : page.path;

  const yours = context.slug === own.slug;
  return {
    destination: {
      kind: "currentPage",
      contextSlug: context.slug,
      folder,
      label: folder === "" ? CONTEXT_ROOT_LABEL : folder,
    },
    /*
      Anything that is not the viewer's own brain has an audience the design
      requires the row to name — a shared workspace's members, or the owner of
      a personal context somebody granted them access to. Both are "not only
      you", which is the fact that has to be in front of somebody before they
      record a conversation into it.
    */
    audience: yours ? ONLY_YOU : VISIBLE_TO_TEAM,
    tone: yours ? "quiet" : "warn",
    refusal: capabilitiesForRole(context.role).canEdit ? null : READ_ONLY_REFUSAL,
  };
}

/**
 * Which row starts selected.
 *
 * A remembered choice wins **only** when it is still on offer and still
 * takeable. A row that has gone read-only since it was last used falls back to
 * the inbox rather than starting on a control whose only outcome is a refusal.
 */
function preselect(
  offers: readonly DestinationOffer[],
  remembered: MeetingDestination | null,
): number {
  if (remembered === null) return 0;
  const index = offers.findIndex(
    (offer) => offer.refusal === null && sameDestination(offer.destination, remembered),
  );
  return index === -1 ? 0 : index;
}

/**
 * Two destinations name the same folder in the same context.
 *
 * **`kind` is deliberately not compared, and neither is `label`.** Both are
 * facts about how somebody arrived at a folder, and the note cannot tell the
 * difference: standing in your own `0-inbox` and pressing record offers the
 * page and the inbox as one row, not the same row twice, and a choice
 * remembered as one reads as the other next time. Comparing the discriminator
 * would make the sheet draw a duplicate and make a remembered choice miss its
 * own row.
 */
export function sameDestination(a: MeetingDestination, b: MeetingDestination): boolean {
  return a.contextSlug === b.contextSlug && a.folder === b.folder;
}

/**
 * `@testagent1 / 0-inbox`, and just `@field-notes` for a context's root.
 *
 * The root has no folder to print, and `"@field-notes / "` reads as a value
 * somebody failed to fill in rather than as the top of a context.
 */
export function describeDestination(destination: MeetingDestination): string {
  const at = destination.contextSlug.startsWith("@")
    ? destination.contextSlug
    : `@${destination.contextSlug}`;
  return destination.folder === "" ? at : `${at} / ${destination.folder}`;
}

/* ----------------------------- on this device ---------------------------- */

/**
 * Remember the choice, for the next time the sheet opens.
 *
 * Fire-and-forget, and failures are swallowed: not being able to write this
 * costs one preselection, and there is no screen it would be honest to
 * interrupt to say so. `lastPlace.ts` draws the same line, and for the same
 * reason it is not `offline/store.ts`'s writer — that one exists because a
 * silent failure there loses somebody's typing.
 *
 * **It is not a permission and it does not skip the question.** The sheet opens
 * whether or not this answers; see `useMeetingFlow`.
 */
export async function rememberDestination(
  store: KeyValueStore,
  destination: MeetingDestination,
): Promise<void> {
  try {
    await store.set(destinationKey(), JSON.stringify(destination));
  } catch {
    // See above.
  }
}

/**
 * A destination read back off a device, or `null` for anything that is not one.
 *
 * **Every destination that has been to storage comes back through here** — the
 * remembered choice below, and the one on a restored `MeetingRecord`. That is
 * `recallPlace`'s rule verbatim, and for its reason: this process wrote it, but
 * it is a file on a *device* — a restored backup, a rooted browser, another app
 * sharing the store — and both fields end up in a request against the
 * customer's own bucket.
 *
 * The slug shape is the narrow one `recallPlace` accepts, and the folder goes
 * through `safeNotePath`, the gate every externally-supplied path in this app
 * already passes. Being narrower than the control plane's naming rule costs at
 * most one preselection, which is the cheapest thing in this feature to lose —
 * and on a record it costs a meeting its folder, never the meeting.
 */
export function parseDestination(value: unknown): MeetingDestination | null {
  if (typeof value !== "object" || value === null) return null;

  const { kind, contextSlug, folder, label } = value as Record<string, unknown>;
  if (kind !== "personalInbox" && kind !== "currentPage") return null;
  if (typeof contextSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(contextSlug)) return null;
  if (typeof folder !== "string") return null;
  if (folder !== "" && safeNotePath(folder) !== folder) return null;

  if (kind === "personalInbox") return { kind, contextSlug, folder };
  if (typeof label !== "string") return null;
  return { kind, contextSlug, folder, label };
}

/** What this device chose last, or `null`. Validated by `parseDestination`. */
export async function recallDestination(
  store: KeyValueStore,
): Promise<MeetingDestination | null> {
  let raw: string | null;
  try {
    raw = await store.get(destinationKey());
  } catch {
    return null;
  }
  if (raw === null) return null;

  try {
    return parseDestination(JSON.parse(raw));
  } catch {
    return null;
  }
}

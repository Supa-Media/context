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
 * "Their own" is `ownPersonalContext` — `kind === "personal"` **and**
 * `role === "owner"` — and the second half is load-bearing rather than
 * belt-and-braces. `createWorkspace` accepts `kind: "shared"` and makes its
 * caller `owner`, so "a context you own" alone can be a shared one, and an
 * offer built from that rule would read *Only you* over a bucket several people
 * watch. That is verbatim the failure this module exists to prevent, arriving
 * through its own front door.
 *
 * ## `contextSlug` is an address, not a label
 *
 * It routes. Every gateway call about a meeting is addressed to the
 * destination's context (`gateway.ts`), so the row's audience line and the
 * bucket the note lands in are answers to the same question. For a while they
 * were not: the slug was rendered, persisted and re-validated, and the write
 * went wherever the credential pointed — a row that said `@acme / finance`
 * over a note headed somewhere nobody had named.
 *
 * ## What it offers, the gateway has to be able to take
 *
 * **An offer with no `refusal` on it is a promise, and the only thing that can
 * keep it is `normalizeMeetingFolder` in `packages/meetings`.** Every folder
 * that function refuses is refused here too, with the sentence beside it, or
 * the sheet is a control that appears to work and does nothing — which is the
 * defect this whole seam exists to close, arriving one layer up.
 *
 * The case that mattered is the **root of a context**, because it is the state
 * a phone *arrives* in: nothing is selected, so the console passes `path: ""`.
 * `CONTEXT_ROOT_REFUSAL` argues it. The rest are `fileableFolder`, and they are
 * not covered by `safeNotePath` — that gate refuses a leading slash, a
 * backslash, a `.` or `..` *segment* and a control character, and lets through
 * `a..b`, `.git`, `overview.md` and a path longer than the gateway's bound.
 *
 * **This is a second statement of a rule this app does not own, and it is
 * allowed to be one only because a test holds the two together.**
 * `meetingsDestination.test.ts` imports the real `normalizeMeetingFolder` and
 * asserts, over every shape either side cares about, that a folder this module
 * offers without a refusal is a folder that function accepts. The phone cannot
 * *bundle* that package — Metro is configured with `@context/shared` as its
 * only shared package (`metro.config.js`) — but the suite can import it, so
 * the drift `paths.js` warns about ("two implementations of 'does this string
 * escape its bucket' is how one of them ends up weaker") is caught in CI rather
 * than left to a comment. Being *stricter* here is safe and is not asserted
 * against: it costs a row, where being laxer costs the destination.
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

/**
 * Said on the row when the page somebody is standing on is a context's root.
 *
 * **The root of a context is not a folder a meeting can be filed into, and the
 * gateway is the one that decides that** — `normalizeMeetingFolder` answers
 * `null` for `""` and `packages/meetings/test/paths.test.mjs` pins it by name:
 * "an empty folder is refused rather than filing a meeting at the bucket root".
 * Its reason is the on-bucket layout, which non-negotiable #3 calls a stable
 * format rather than an internal detail: `index.md` and `privacy.md` live at
 * the root, and a `2026/09/` tree of meetings beside them is not a layout
 * anybody's vault expects.
 *
 * Until this refusal existed the sheet offered that root anyway. Standing at a
 * context root is the state a phone *arrives in* — nothing is selected, so the
 * console passes `path: ""` — so the second row was a live, pressable,
 * unrefused offer whose only possible outcome was the gateway filing the
 * meeting somewhere else and saying `folderRejected`. That is the defect this
 * whole branch has been closing, one layer up: a control that appears to work
 * and does nothing.
 *
 * **The row is refused, not removed**, for `DestinationOffer.refusal`'s reason
 * and CLAUDE.md's: an absent capability is reported rather than faked, and a
 * page that vanishes from the sheet leaves somebody hunting for the choice the
 * product told them they had.
 *
 * The alternative was to make the root expressible and have the gateway accept
 * it. That is a reversal of a decision with a stated reason, a test, and a
 * paragraph in [meetings](../../../../docs/decisions/meetings.md) — so it is a
 * `docs/decisions/` change and not a fix, and the two layers agree this way
 * round at no cost to anybody: `0-inbox` is one row above, already selected.
 */
export const CONTEXT_ROOT_REFUSAL =
  "A meeting cannot be filed at the root of a context. Open a folder and record from there, or use your inbox.";

/**
 * Said on the row for every *other* folder the gateway will not file into.
 *
 * Separate from the root's sentence because the root is a place somebody
 * deliberately navigated to and can be told something useful about, while this
 * covers folders whose names happen to collide with the gateway's rules —
 * `a..b`, a dot-prefixed folder, a folder named like a note, one nested past
 * the length bound. There is nothing useful to say about *which* rule, and
 * naming it would be quoting the customer's own folder name back at them for
 * no gain.
 *
 * It does not quote the folder, for `FOLDER_REJECTED_NOTICE`'s reason one layer
 * down: the ack carries no copy of what was sent, and this row is looking at
 * the same fact before the request rather than after it.
 */
export const UNFILEABLE_FOLDER_REFUSAL =
  "Your context will not file a meeting into this folder. Choose another one, or use your inbox.";

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
 *
 * A page that *is* a destination may still be one nobody may take, and those
 * come back as an offer carrying a `refusal` rather than as `null` — see
 * `refusalFor`.
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
    refusal: refusalFor(context, folder),
  };
}

/**
 * Why the page cannot be recorded into, or `null`.
 *
 * Three reasons, widest first. A context somebody may only read refuses *every*
 * folder in it, so that sentence stays true at a folder the other two would
 * also have refused; telling somebody who cannot write to any of it that the
 * problem is the folder's name names the smaller problem.
 *
 * One function rather than a conditional inside the offer because a refusal is
 * the thing this module exists to get right, and a reason added inline is a
 * reason added without a test. Each arm has one.
 */
function refusalFor(context: DestinationContext, folder: string): string | null {
  if (!capabilitiesForRole(context.role).canEdit) return READ_ONLY_REFUSAL;
  if (folder === "") return CONTEXT_ROOT_REFUSAL;
  if (!fileableFolder(folder)) return UNFILEABLE_FOLDER_REFUSAL;
  return null;
}

/**
 * `MAX_FOLDER_LENGTH` in `packages/meetings/src/paths.js`, restated.
 *
 * The bound is the gateway's and the reason for it is the gateway's — the whole
 * key has to stay inside its 512-character path limit once the date folders and
 * the filename are on the end. Restated rather than imported because the phone
 * does not bundle that package; the test that holds the two together is named
 * at the head of this file.
 */
const MAX_FOLDER_LENGTH = 128;

/**
 * Whether `normalizeMeetingFolder` would file a meeting into this folder.
 *
 * Not a re-implementation of it — this is the same question asked as a
 * predicate, on a string that has already been through `safeNotePath`, so the
 * traversal and control-character arms are not repeated here. What is left is
 * exactly the four shapes that gate lets through and the gateway does not:
 *
 *  - **`..` anywhere in a segment**, not only a segment that *is* `..`. The
 *    gateway's `normalizePath` refuses `..` anywhere in a key, and a folder
 *    named `a..b` cost a real meeting: the claim wrote `a..b/YYYY/MM/….md` into
 *    the session record and the note write then answered 400 `meeting_invalid`
 *    — the code no client retries — for the life of that meeting.
 *  - **A dot-prefixed segment.** `isPlumbing` hides those from every tool at
 *    every tier, the owner's included, so the meeting would be invisible to the
 *    person paying for the storage. The console's own tree never lists one, so
 *    this arm is belt and braces about a listing rather than about a person.
 *  - **A segment that is a note, or the legacy manifest.** A key inside a file
 *    is a shape a filesystem-backed store cannot represent.
 *  - **The length bound.** A folder nested deeply enough is a legal path to the
 *    console and not one to the gateway.
 */
function fileableFolder(folder: string): boolean {
  if (folder.length > MAX_FOLDER_LENGTH) return false;
  return folder.split("/").every((segment) => {
    if (segment === "") return true; // `normalizeRoot` collapses repeats.
    if (segment.includes("..")) return false;
    if (segment.startsWith(".")) return false;
    if (segment.toLowerCase().endsWith(".md")) return false;
    return segment.toLowerCase() !== "scopes.yml";
  });
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
 * The row a press on `index` leaves selected.
 *
 * A refused row cannot be chosen: the selection stays where it was. Here rather
 * than inside the sheet for the reason at the top of this file — a rule about
 * what somebody is allowed to pick, expressed inside a component, is the kind
 * this repo has measured as caught by nothing.
 *
 * An index the list does not have answers with the current selection rather
 * than throwing: the only caller is a list this module produced, so a bad index
 * is a bug in the caller and not a reason to take a screen down mid-meeting.
 */
export function chooseOffer(
  offers: readonly DestinationOffer[],
  current: number,
  index: number,
): number {
  const offer = offers[index];
  if (offer === undefined || offer.refusal !== null) return current;
  return index;
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

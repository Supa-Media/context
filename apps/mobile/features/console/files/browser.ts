/**
 * The interface the file editor's UI talks to.
 *
 * One interface, two implementations: `useFileBrowser` (real, backed by the
 * Convex actions in `apps/convex/functions/files.ts`) and
 * `useDemoFileBrowser` (the read-only console on the landing page, backed by
 * a handful of literals). The components take this and nothing else, which is
 * what lets the marketing page run the actual console rather than a
 * screenshot.
 *
 * **A read-only browser still carries every mutating method, and they are
 * inert.** This comment used to say the opposite — that `canEdit: false` meant
 * the methods were absent — and it was never true: they are required members of
 * this interface, `useDemoFileBrowser` sets all of them to no-ops, and
 * `useFileBrowser`'s `run` returns without doing anything when `canEdit` is
 * false. So `files.destroy(path)` on a console that cannot edit does not throw;
 * it silently does nothing at all.
 *
 * Which means **the UI cannot use a crash to catch a control it should not have
 * offered**. A Delete that reached the landing page would look like it worked
 * and quietly do nothing, and nobody would find out. Whether a control exists
 * is decided from `canEdit` — see `itemsFor` in `menu.ts` — and that decision is
 * the only thing standing between a visitor and a button that lies.
 */

import type { Clipboard } from "./clipboard";
import type { EditorState } from "./editor";
import { ConvexError } from "convex/values";
import type { NoteShare } from "./shares";
import type { ToastSpec } from "../../design/components/Toast";
import type { FileError, FolderListing, Visibility } from "./types";
import type { SyncFacts } from "../../offline/copy";

/** What one search found, and whether there was an index to find it in. */
export interface SearchAnswer {
  hits: { path: string; title: string; snippets: string[] }[];
  /**
   * Nothing has indexed this context yet, so this is not "no matches" — see
   * `searchNotes` in the control plane's `lib/fileOps.ts`.
   */
  indexMissing: boolean;
  /**
   * The index is behind the bucket, so an empty answer may simply be a note
   * the backfill has not reached. Distinguishing this is the difference
   * between "you have not written that down" and "we have not read it yet",
   * and the first is a lie the console is not entitled to tell.
   */
  indexIncomplete: boolean;
}

export interface FileBrowser {
  /**
   * Whether this console may change anything.
   *
   * False on the landing page, and false for a workspace `member` — read
   * access and write access are different grants, and a Save button that
   * always fails is worse than no Save button.
   */
  canEdit: boolean;
  /** Why not. Shown once, plainly, rather than on every disabled control. */
  readOnlyReason?: string;

  loading: boolean;
  /** True while an operation is in flight, so the toolbar can settle. */
  busy: boolean;
  /** Listings by folder path; `""` is the root. `undefined` means "not loaded". */
  listings: Readonly<Record<string, FolderListing | undefined>>;
  expanded: ReadonlySet<string>;
  toggleFolder: (path: string) => void;

  selectedPath: string | null;
  /** Refused, with a prompt, when the open note has unsaved changes. */
  /**
   * Open a note or a folder. Answers **false** when the unsaved-changes guard
   * refused, so a caller that also moves other state — the tab strip — can
   * stay in step with the editor instead of moving without it.
   */
  select: (path: string) => boolean;

  /**
   * Search the whole context, not the folders that happen to be loaded.
   *
   * A read method on the browser rather than a hook the console calls
   * directly, for the reason in this file's header: the components take this
   * interface and nothing else, so the landing page's demo console renders the
   * same palette without a Convex client anywhere near it.
   *
   * Rejects rather than returning an empty list when the search cannot be run
   * — "nothing was found" and "nothing was asked" must not arrive as the same
   * value, or a failed round trip reads as an answer about somebody's notes.
   */
  search: (query: string) => Promise<SearchAnswer>;

  editor: EditorState;
  setDraft: (text: string) => void;
  save: () => void;
  /** Take the version that is on the server, discarding this draft. */
  useTheirs: () => void;
  /** Keep this draft and save it over theirs, on the etag that is now current. */
  keepMine: () => void;
  discard: () => void;

  /**
   * The connection, and the writes that have not reached the bucket.
   *
   * Optional because a browser can have no offline layer under it at all: the
   * landing page's demo console is built from literals and has no bucket to be
   * offline from. Absent means "make no claim", and `statusSegments` draws
   * nothing for it — which is the right answer for a picture of the product.
   */
  sync?: SyncFacts;

  /** The last thing that went wrong, or a confirmation of what just happened. */
  notice: string | null;
  dismissNotice: () => void;

  /**
   * Completed operations that have a way back, newest last.
   *
   * Separate from `notice` because they answer different questions. A notice is
   * a *refusal* or a *failure* — "that name is taken", "that did not work" —
   * and it sits in the pane until it is dismissed or replaced, which is right
   * for something the person has to act on. A toast reports something that
   * already succeeded and offers the inverse of it, which is only useful for a
   * few seconds and must not become furniture.
   *
   * At most one at a time in practice: `run` clears the list before every
   * operation, so the offer is always the inverse of the last thing that
   * happened and never of something three moves ago that no longer inverts.
   */
  toasts: readonly ToastSpec[];
  dismissToast: (id: string) => void;

  clipboard: Clipboard | null;
  copy: (path: string) => void;
  cut: (path: string) => void;
  paste: (destinationFolder: string) => void;
  /**
   * Copy a path into a destination folder, without touching the clipboard.
   *
   * For the ⌥-drop on the tree, where the thing being copied is the thing the
   * person is dragging rather than the thing they last pressed ⌘C on. Spelling
   * that as `copy(from)` then `paste(folder)` looks equivalent and is not:
   * `copy` sets state, `paste` reads the clipboard captured in its own render,
   * and the two run in the same tick — so the paste acts on the *previous*
   * clipboard. Empty, it refuses; holding a cut of some other file, it moves
   * that file into the drop folder.
   *
   * Same collision rules and the same server action as a copy-and-paste — a
   * drop and a paste must never disagree about the name something lands under
   * — with the source passed in. `paste` keeps reading the clipboard, because
   * on the toolbar and menu path the clipboard genuinely is the source.
   */
  copyTo: (from: string, destinationFolder: string) => void;

  createNote: (folder: string, name: string) => void;
  createFolder: (folder: string, name: string) => void;
  rename: (path: string, name: string) => void;
  move: (path: string, destinationFolder: string) => void;
  duplicate: (path: string) => void;
  archive: (path: string) => void;
  /** Permanent. The UI must have confirmed it in words before calling this. */
  destroy: (path: string) => void;
  setVisibility: (path: string, kind: "file" | "folder", visibility: Visibility) => void;
  /**
   * Write a working `privacy.md` over one that is missing or unreadable.
   *
   * Present on every browser and inert on most of them, like every other
   * mutating method here — and the UI decides whether to offer it from
   * `canResetPrivacy` rather than from whether calling it would throw.
   */
  resetPrivacy: () => void;
  /**
   * Whether that control should exist at all.
   *
   * Three things have to be true and none of them is `canEdit`: the manifest
   * has to be broken (a reset is refused on one that parses), the caller has to
   * be the owner (rewriting the access map is not an editor's to do), and this
   * has to be a console that can act. An editor sees the banner explaining why
   * nothing can be shared and no button, which is honest — the fix is theirs to
   * ask for, not theirs to make.
   */
  canResetPrivacy: boolean;
  /**
   * Whether the tree's visibility markers are pressable. Owner-only:
   * visibility writes rewrite the access map that decides what a
   * non-owner may see, so for everyone else the marker is a fact, not
   * a control — same rule the server enforces with `minimum: "owner"`.
   */
  canSetVisibility: boolean;

  /**
   * Whether a Share control exists at all.
   *
   * Owner-only, and absent rather than disabled — the same rule as
   * `canSetVisibility`, for the same reason. Handing a note to somebody outside
   * the context is a decision about who reads it, which is the owner's alone;
   * `createShare` refuses anyone else with `minimum: "owner"` regardless of
   * what this menu says.
   */
  canShare: boolean;

  /**
   * Every live share on this context, or `undefined` while the query is in
   * flight — never `[]` for "not loaded yet".
   *
   * The distinction is the whole reason this is not a plain array. A dialog
   * that renders `[]` as "nobody has access" while the answer is still arriving
   * tells the owner their share did not work, and the recoverable mistake they
   * then make is sharing it a second time.
   *
   * Absent entirely (`undefined`) on a browser that cannot share, because
   * `listShares` is owner-only and subscribing anyway would throw in render.
   */
  shares: readonly NoteShare[] | undefined;

  /**
   * Share this note with `recipient` — a `@name` or an email address.
   *
   * Inert on a browser that cannot share, like every other mutating method
   * here. Re-sharing a note with somebody who already has it is not an error:
   * the server supersedes in place and keeps the existing token, so a link
   * already sent keeps working.
   */
  share: (path: string, recipient: string, titleInPreview?: boolean) => void;

  /** Take a share back. Immediate, and final for that link. */
  revokeShare: (shareId: string) => void;

  /**
   * A link to this note for the people who already have access.
   *
   * Resolves to the URL, because the caller's next act is to put it on the
   * clipboard — unlike `share`, which is fire-and-forget because its result is
   * a row in a list the dialog is already watching.
   *
   * Grants nothing: reading is authorised by membership on every request, so
   * removing somebody from the context takes the link with them. The token is
   * there to make the URL unguessable, which is what lets its card carry the
   * note's title.
   *
   * `null` on a browser that cannot share, and on failure — the caller then
   * leaves the button's label alone rather than claiming a copy it did not make.
   */
  teamShareLink: (path: string) => Promise<string | null>;

  /**
   * Turn the link's preview title on or off for one share.
   *
   * Routed through `createShare`, which supersedes an existing share in place
   * and returns the same token — so this changes what a crawler is told without
   * breaking a link the owner has already sent. It needs the recipient because
   * that, with the path, is what identifies the row.
   */
  setSharePreviewTitle: (
    path: string,
    recipient: string,
    titleInPreview: boolean,
  ) => void;
}

/** Every folder currently loaded, for the move dialog's destination list. */
export function loadedFolders(
  listings: Readonly<Record<string, FolderListing | undefined>>,
): string[] {
  const folders = new Set<string>([""]);
  for (const listing of Object.values(listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.kind === "folder") folders.add(entry.path);
    }
  }
  return [...folders].sort();
}

/**
 * What a thrown thing is allowed to say on somebody's screen.
 *
 * The single funnel between anything the file actions throw and the copy the
 * console renders — every notice, save failure and toast in `useFileBrowser`
 * comes through here. It lives in this module rather than in the hook because
 * a decision no test can reach is a decision nothing is holding, and this one
 * had six call sites and no test at all.
 *
 * The rule is the one `../failure.ts` states for the query side: **never a raw
 * runtime string as the headline — that is how a stack trace ends up in a
 * screenshot.** Only a `ConvexError` carrying a shaped payload reaches a
 * person; anything else is replaced wholesale. That is worth more here than in
 * most consoles, because the far side of these actions is a
 * customer-configured storage endpoint reached with a decrypted credential,
 * and an adapter throw can carry a bucket name, a host, a signed URL or a
 * provider's raw XML. The server is careful about what goes into a
 * `FileOpError`; this is the guard for everything that is not one.
 *
 * The `instanceof` check and the shape check are both load-bearing, and they
 * are not the same check. Reading `.data` off anything would surface the
 * message of any object that happens to have one; trusting the wrapper without
 * inspecting the contents would surface a `ConvexError` carrying a bare string.
 *
 * **Deliberately not built on `../failure.ts`'s `convexErrorParts`, and that is
 * a measured decision rather than duplication left in place.** Sharing it was
 * the first attempt here, on the reasoning that one answer to "what may be read
 * off a failure" beats two that can drift. It is a *widening*: that helper
 * accepts `data` as a bare string, so `new ConvexError("<a signed URL>")` would
 * have surfaced verbatim where this refuses it. The two want different
 * policies for good reasons — `describeQueryFailure` renders such a string as
 * secondary `detail` under a fixed headline, while this becomes the notice
 * itself — so they stay separate, and the test below pins the case that
 * separates them.
 */
export function toFileError(error: unknown): FileError {
  const data = serverPayload(error);
  if (data !== null) {
    return {
      code: typeof data.code === "string" ? data.code : "UNKNOWN",
      message: data.message,
      currentEtag: typeof data.currentEtag === "string" ? data.currentEtag : undefined,
    };
  }
  return { code: "UNKNOWN", message: "That did not work. Try again." };
}

/**
 * The one shape check, so the two questions asked of it cannot drift.
 *
 * Both callers below need the same fact — *did the server evaluate this and
 * answer* — and a second copy of the `instanceof` plus the `typeof` would be a
 * second place for one of them to be widened.
 */
function serverPayload(error: unknown): (Partial<FileError> & { message: string }) | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as Partial<FileError> | undefined;
  return typeof data?.message === "string"
    ? (data as Partial<FileError> & { message: string })
    : null;
}

/**
 * Whether the server received this request, evaluated it, and said no.
 *
 * The line the offline read paths fall back on. A **refusal** — a membership
 * removed, a grant revoked, a note whose visibility moved under a `team`
 * viewer, a note deleted — must never be overridden by a copy on the device:
 * rendering the cached body to somebody the control plane has just refused is
 * a disclosure, and doing it under an age stamp makes it read as considered.
 * A **transport** failure is the opposite case, and the whole reason the
 * fallback exists: a captive portal, a dead uplink, a socket that closed. The
 * bucket has not said anything, and a stamped copy beats an empty screen.
 *
 * The two are told apart by exactly what `toFileError` uses to decide whether
 * a message may be shown at all, which is not an accident: a `ConvexError`
 * carrying a shaped `{ code, message }` is the only thing this product's
 * server produces deliberately. Anything else — a `fetch` throw, a timeout, a
 * `ConvexError` wrapping a bare string — is not an answer, and is treated as
 * transport. That direction is deliberate: an unshaped failure is one nothing
 * vouched for, so it may not deny somebody their own cached note.
 *
 * **Two answers are not refusals, and they are enumerated rather than
 * guessed.** `STORAGE_NOT_CONNECTED` and `STORAGE_UNUSABLE` are raised inside
 * `runFileOperation` *before* `executeOperation` is called — before any path,
 * any note and any visibility decision — and that action's own callers have
 * each already established membership and a sufficient role. So by the time
 * either reaches here, authorization has **passed** and no per-note question
 * has been asked. Serving a cached copy under them cannot override a refusal,
 * because nothing was refused: the bucket was unreachable.
 *
 * That case is not a corner. It is a revoked key, a rebind in progress, and
 * Cloudflare's 10042 — a card that failed months after signup, which
 * `CLAUDE.md` records as leaving the customer's data intact and warns reads as
 * us having lost their notes. A person whose bucket is down is exactly who an
 * offline copy is for, and a "fix" that blanks their notes during an outage
 * would be a regression shipped under a security banner.
 *
 * **The list is of codes safe to override, never of codes that are refusals**,
 * and that direction is the whole safety argument. An unknown code — a denial
 * added to the server next month that nobody thinks about here — is not on the
 * list, so it is treated as a refusal and the cache stays shut. The inverted
 * list, "these codes are denials, everything else is transport", fails the
 * other way and would serve note text to somebody the server had just refused.
 *
 * `STORAGE_FAILED` is deliberately **not** on it. It is `toConvexError`'s
 * catch-all for a failure whose text we have not vetted, so it can be thrown
 * from anywhere, including from inside an operation that had already reached a
 * note. A code that means "something unexpected" cannot carry a promise about
 * when it was raised.
 *
 * `__tests__/cachedAfterRefusal.test.ts` pins the behaviour, and the Convex
 * suite pins the premise: the two codes must keep being raised before
 * `executeOperation`, or this allow-list is describing a version of the server
 * that no longer exists.
 */
const OVERRIDABLE_STORAGE_CODES = new Set(["STORAGE_NOT_CONNECTED", "STORAGE_UNUSABLE"]);

export function isServerRefusal(error: unknown): boolean {
  const payload = serverPayload(error);
  if (payload === null) return false;
  return !(typeof payload.code === "string" && OVERRIDABLE_STORAGE_CODES.has(payload.code));
}

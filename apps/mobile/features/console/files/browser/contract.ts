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

import type { Clipboard } from "../clipboard";
import type { EditorState } from "../editor";
import type {
  FormOutcome,
  FormResponsesOutcome,
  FormResponseRetract,
  FormResponseUpdate,
  FormSubmission,
  FormVote,
} from "../formBlock";
import type { NoteShare } from "../shares";
import type { NoteScope } from "../scope";
import type { ToastSpec } from "../../../design/components/Toast";
import type { FolderListing, SettableVisibility } from "../types";
import type { SyncFacts } from "../../../offline/copy";
import type { PendingMarks } from "../pendingMarks";
import type { ConflictReview } from "../useConflictReview";
import type { AppliedPluginNoteWrite } from "../../plugins/runtime";
import type { SearchAnswer, MoveDestination, ContextMoveProgress } from "./supportingTypes";

export type { SearchAnswer, MoveDestination, ContextMoveProgress } from "./supportingTypes";

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

  /**
   * The context every other field here is *about*, or `null` before any.
   *
   * Not the context the console has selected — the one this browser's own
   * state has caught up with. The two differ for exactly one commit, and that
   * commit is where a team link used to be lost: `useFileBrowser` forgets the
   * previous context in an effect, and React runs a *route's* effects before
   * its *layout's*, so anything the route selected on the strength of a URL was
   * cleared immediately afterwards by a reset it could not see coming.
   *
   * So a caller acting on the URL waits for this to name the context it is
   * acting on. See `useLinkedNote`, which is the one caller and the one that
   * was broken; the panes read the state itself and never needed to ask.
   */
  contextId: string | null;

  loading: boolean;
  /** True while an operation is in flight, so the toolbar can settle. */
  busy: boolean;
  /** Listings by folder path; `""` is the root. `undefined` means "not loaded". */
  listings: Readonly<Record<string, FolderListing | undefined>>;
  expanded: ReadonlySet<string>;
  toggleFolder: (path: string) => void;
  /**
   * Fold the whole tree back to its roots.
   *
   * A separate operation rather than "toggle everything that is open", because
   * what it means is *the tree's resting state* — one press from forty rows to
   * five. It leaves the selection alone: collapsing the tree is a statement
   * about the panel, not about which note is open, and closing the folder a
   * note is in must not close the note.
   */
  collapseAll: () => void;

  selectedPath: string | null;

  /**
   * The selected path whose **contents have not arrived yet**, or `null`.
   *
   * `selectedPath` moves the instant somebody picks something; the note's body
   * is a Convex action away and a folder's listing is another. Between the two
   * there is a state with a path selected and nothing to draw, and it is not
   * the same state as "nothing is selected" — a pane that reads it as one
   * tells somebody who is opening a note to choose a note.
   *
   * That is what a refresh of `/console/@name?note=…` looked like: a round
   * trip's worth of "Choose a note to read or edit it" over a URL that had
   * already chosen one. `pendingNote` in `BrowsePane` covered the *first* half
   * of that gap — the URL seen, `select` not yet called — and this covers the
   * second and longer half.
   *
   * It is not an error state and it does not survive one. A read that fails
   * clears it, so the empty state comes back with the failure's notice above
   * it rather than the screen staying blank.
   */
  opening: string | null;

  /** Refused, with a prompt, when the open note has unsaved changes. */
  /**
   * Open a note or a folder. Answers **false** when the unsaved-changes guard
   * refused, so a caller that also moves other state — the tab strip — can
   * stay in step with the editor instead of moving without it.
   */
  select: (path: string) => boolean;

  /**
   * How many times `select` has moved this browser somewhere.
   *
   * **A counter, because the URL has to tell a navigation from a correction**,
   * and by the time it sees one it has only "the selected path changed" to go
   * on. Those are two different facts wearing one shape: somebody opened a
   * note (a place, and the browser's own back button should return from it),
   * or the note that was already open changed path underneath them — a rename
   * — and its address has to catch up without anybody having gone anywhere.
   *
   * Bumped only by a `select` the guard allowed, so a refused navigation is
   * not one. **`deselect` deliberately does not bump it**: standing at the
   * context's root after closing the last tab is where the console put you,
   * not somewhere you asked to go, and a history entry for it is a back button
   * that returns to an empty pane.
   *
   * Read by `noteAddress.ts`, which compares it against the value it last
   * reconciled. See `useNoteUrl` for what the two answers do to the address
   * bar.
   */
  navigations: number;

  /**
   * Close what is open and stand at the context's root.
   *
   * **The inverse of `select`, and it did not exist.** For as long as it did
   * not, "no note is open" was a state this browser could arrive at (a delete,
   * a context switch) and never be *asked* for — so every surface that wanted
   * to express it had to pretend instead. `noteAddress.ts` carried the whole
   * argument as a limitation: a console URL that had lost its `?note=` was
   * re-addressed back to the open note rather than obeyed, "because there is no
   * 'close the note' for it to be expressing". That is what made the phone's
   * lit context pill a dead control — it navigated to the context's root, the
   * mirror put the note straight back, and pressing the one thing on the screen
   * labelled as the way up did nothing anybody could see.
   *
   * Refusable, exactly like `select`: it is a navigation away from a draft, so
   * the unsaved-changes guard gets the same say and the same `false`. And it
   * flushes autosave first, for the same reason — a draft waiting on the idle
   * timer is handed to the bucket on the way out rather than left to a timer
   * that will not fire once the editor is empty.
   *
   * It is **not** a tab operation. Closing the note you are reading and closing
   * the tab holding it are different intentions, and the pointer layout's strip
   * has its own control for the second.
   */
  deselect: () => boolean;

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
  /** Mark an open prose note as owned by the durable collaboration controller. */
  setCollaborationOwned?: (path: string, owned: boolean) => void;
  /** Update the editor from the durable controller without creating a legacy draft. */
  setCollaborationDraft?: (text: string) => void;
  setCollaborationState?: (state: {
    text: string;
    etag: string | null;
    status: "offline" | "storing" | "local" | "syncing" | "saved" | "error" | "unavailable" | "revoked";
    pending: number;
    recovery?: { baseline: string; desired: string; baseEtag?: string | null };
    legacyAdopted?: { path: string; text: string; baseEtag: string };
  }) => void;
  save: () => void;
  /**
   * A tool wrote the open note, and the live room has already merged it.
   *
   * Moves the editor onto the version the write produced, so this client's
   * next conditional save is checked against what is actually in the bucket
   * rather than against the version it opened — which would be a conflict
   * raised about a change already present in the text being saved. Nothing
   * else moves: the draft is the merge, and it is still unsaved.
   */
  onExternalWrite: (written: { path: string; etag: string | null }) => void;
  /**
   * Listen for saves this console makes, and return an unsubscribe.
   *
   * A save goes through the control plane rather than the gateway, so a live
   * room has no other way to learn that the bucket moved. A subscription
   * rather than a callback passed in, because the socket is opened from this
   * browser's own state and handing it back down would be a cycle.
   */
  onSaved: (handler: (written: { path: string; etag: string }) => void) => () => void;
  /**
   * Reflect a plugin write only when the open editor is still the clean,
   * exact version that write replaced; a newer or dirty draft always wins the
   * screen and reaches the ordinary conflict flow on save.
   */
  applyPluginNoteWrite?: (write: AppliedPluginNoteWrite) => void;
  /**
   * Write the draft autosave is holding, now, and say whether there was one.
   *
   * Every exit that is not a save goes through this: opening another note,
   * closing a tab, and — on web — the tab being hidden or closed. `path`
   * restricts it to one note, for a caller acting on a tab rather than on the
   * editor; without one it writes whatever is pending.
   *
   * It is the same conditional write `save` makes. There is no second write
   * path in this console and nothing here can force one.
   */
  flushAutosave: (path?: string) => boolean;
  /**
   * Drop every local copy of `path`'s plaintext: its draft, any write still
   * waiting in the offline queue, and the cached body last read from the
   * bucket. Writes nothing to the bucket.
   *
   * **All three, and the third is the one a name like `discardDraft` would
   * have hidden.** A draft and a queued write are the person's own typing;
   * the *cached body* is a copy of what the bucket answered — and for the
   * caller this exists for, all three hold the same plaintext. Leaving the
   * cache behind and trusting the reopen that follows a lock to overwrite it
   * (`rememberNote`) is a fix that holds only while that reopen lands: a read
   * that loses the connection between the lock and the reopen serves the
   * pre-lock plaintext back out of `localStorage` — into an ordinary editor,
   * because a cached copy taken before the lock says `encrypted: false` and so
   * walks past `openNote`'s own guard — and leaves it there across reloads.
   * Measured, not reasoned about: `encryptionLockDiscardsDraft.test.ts`
   * enumerates the store after a lock whose reopen fails.
   *
   * **The one caller today is the moment a note becomes encrypted** — a
   * first lock, or a re-lock after `removeNoteEncryption` put it back — where
   * a passphrase-protected note's whole promise is that nothing this codebase
   * runs can read it. A plaintext typed before the lock and never saved would
   * otherwise sit in `features/offline`'s durable store, at a path that is
   * now ciphertext, forever: `docs/decisions/encryption.md`'s "Encrypted
   * notes are for humans; no AI client reads one" is a claim about the
   * bucket, and a leftover draft on the device is the same plaintext sitting
   * just outside it.
   *
   * Exposed here rather than folded into `useNoteEncryption.ts`'s own
   * `protect`, on purpose: that module's header states the rule its caller
   * depends on — it never imports `features/offline`, so an unlocked note's
   * plaintext can never reach the durable draft queue *through* it.
   * `__tests__/encryptionDraftQueueGuard.test.ts` holds that boundary on the
   * source. Calling `forgetDraft`/`dropQueued` from inside the encryption
   * module would be a second, narrower door into the same store; this keeps
   * the one door in the file that already owns it (`useFileBrowser.ts`), and
   * the caller that just finished a lock — `BrowsePane`, outside
   * `features/console/encryption/` entirely — reaches through it instead.
   *
   * Takes an explicit path rather than reading `editor.path`: the note this
   * clears is the one the lock just finished with, and a caller must never
   * have to open it first to close the door behind it.
   *
   * What dropping the cached body costs, stated rather than hidden: the note
   * is not readable offline until something reads it again. That is one round
   * trip on a note that has just become unreadable without a passphrase
   * anyway, and the reopen every caller already makes pays it immediately.
   */
  discardLocalCopies: (path: string) => void;
  /**
   * Another live console has just encrypted `path`. Cancels rather than flushes
   * autosave, drops plaintext immediately, then re-reads the ciphertext.
   */
  encryptedElsewhere: (path: string) => void;
  /** Take the server outcome (including deletion), discarding this draft. Writes nothing. */
  useTheirs: () => void;
  /** Keep this draft and save it over theirs, on the etag that is now current. */
  keepMine: () => void;

  /**
   * Both sides of the open note's conflict, and a merge of them where one can
   * honestly be made. `null` when the open note is not in conflict.
   *
   * Reading it writes nothing to the customer's bucket — it reads the other
   * side so a person can see what they are choosing between. Every write is
   * behind `resolveWith` or `useTheirs`.
   */
  conflict: ConflictReview | null;

  /**
   * Answer the conflict with this text: the draft as it stands, or a merge the
   * person has read and approved.
   *
   * Conditional on the version the review actually showed them, or create-only
   * when that reviewed outcome is deletion. A note somebody else has moved or
   * recreated since comes back as a fresh conflict rather than being forced
   * through, and offline it goes back into the queue carrying the same version
   * condition, to be checked at drain time.
   */
  resolveWith: (text: string) => void;
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
  /**
   * Which notes in this context have an edit that has not reached the bucket,
   * for the lists to mark and the phone's sync sheet to name. Read-only — see
   * `pendingMarks.ts`. Optional for the reason `sync` is: the demo console has
   * no queue, and absent marks nothing.
   */
  pending?: PendingMarks;
  /**
   * A person's answer to a parked rename, move, archive, delete or new folder
   * — `OpRow.answers` says which are offered. Optional for the reason `pending`
   * is: the demo console has no queue.
   */
  answerOp?: (id: string, answer: "override" | "retry" | "discard") => void;

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

  /**
   * Say something transient that no row command produced — a refused paste.
   *
   * Separate from `notice`, which is about the console's own state (no storage
   * connected, a stale listing) and stays until it stops being true.
   */
  say(message: string): void;
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
  /**
   * New drawing, by the name a person would say rather than the file it becomes.
   *
   * `<name>.excalidraw.md` is two extensions, so the suffix is supplied here
   * and `createNote` does the rest — one set of name and collision rules for
   * both. Typing `plan.excalidraw` into New note reaches the same file.
   */
  createDrawing: (folder: string, name: string) => void;
  createFolder: (folder: string, name: string) => void;
  /**
   * Make one **now**, called `untitled-<date>`, and open it.
   *
   * The whole of "nothing asks you to name a note before you have written it".
   * Every surface that used to raise `NamePrompt` for a new note or a new
   * drawing calls this instead, and the name catches up on its own: the file is
   * renamed to the document's first heading the first time that heading settles
   * into something other than the placeholder. See `untitled.ts`.
   *
   * A folder is deliberately **not** one of the kinds. The argument for
   * skipping the prompt is that the thing you are making has a title field
   * inside it — the first line of the document — and a folder has no inside to
   * type in. `untitled-2026-09-19/` in somebody's bucket, renameable only from
   * a row menu, is a worse trade than one text field.
   */
  createUntitled: (folder: string, kind: "note" | "drawing") => void;
  rename: (path: string, name: string) => void;
  move: (path: string, destinationFolder: string) => void;
  /**
   * The other contexts this person may move something into.
   *
   * Empty unless they **own** this one, because taking something out of a
   * context removes it from everybody who could read it there — see
   * `functions/contextMoves.ts`. The server refuses it regardless of what this
   * list says; the list is what keeps the dialog from offering a destination
   * that will be refused.
   */
  moveDestinations: readonly MoveDestination[];
  /**
   * The folders of another context, for the destination picker.
   *
   * A promise rather than a field, because it is a bucket walk in a context
   * this console is not standing in: fetching every destination's folders up
   * front would open a credential per context on every render of a menu.
   * Resolves to a floor when the walk hit a ceiling, and says so.
   */
  destinationFolders: (contextId: string) => Promise<{
    folders: readonly string[];
    truncated: boolean;
  }>;
  /**
   * Start a move into another context.
   *
   * Deliberately not a shape of `move`. It reaches a different server action,
   * it cannot rewrite links, it cannot be undone from a toast, and it does not
   * finish inside the press — four differences that a caller has to know about,
   * and an optional `contextId` on `move` would hide every one of them.
   */
  moveToContext: (path: string, contextId: string, destinationFolder: string) => void;
  /** Moves out of this context that are running, or finished recently. */
  contextMoves: readonly ContextMoveProgress[];
  /** Pick a stopped move back up. Everything already carried stays carried. */
  resumeContextMove: (id: string) => void;
  /**
   * Record that a move's outcome has been read, so it stops being listed.
   *
   * Per account rather than per screen: the row stays listable for a day, so
   * a dismissal only the device remembered was the same line again on the
   * next launch — and on the other device, which never asked.
   *
   * Takes any id and is refused for anything but a **completed** move, which
   * is the server's rule to keep (`dismissContextMove`): a failed move's
   * notice holds the only control that can finish it. Callers still hide the
   * line locally; that is what "Not now" means on a failure.
   */
  dismissContextMove: (id: string) => void;
  duplicate: (path: string) => void;
  /**
   * Put this note, or this whole folder, on the person's own disk.
   *
   * Non-negotiable #1's last step, and the one that was missing: the console
   * could read a note and could not hand it to you, so getting your own
   * writing out meant opening the bucket somewhere else. A folder comes as a
   * `.zip` of every note in it **this caller can see** — the same set the
   * listing shows, because the same manifest decides both.
   *
   * **Not gated on `canEdit`.** The exit is never gated and never degraded, so
   * a read-only member and a viewer of the pinned context download exactly what
   * they can read. It is a bulk read, not a write, and it asks the server
   * nothing the row's own Open does not.
   */
  download: (path: string, kind: "file" | "folder") => void;
  archive: (path: string) => void;
  /** Recoverable delete: moves the entry into the archive-backed trash and offers Undo. */
  destroy: (path: string) => void;
  /**
   * The tree's multi-selection, acted on as one operation.
   *
   * Not `move` in a loop, and the difference is visible: every call to a
   * single-path method is its own `run`, and a newer `run` supersedes an older
   * one — it clears the older one's toast, skips its refresh and takes the
   * busy flag from it. Five moves in a row was one toast offering to undo the
   * fifth and a tree that had reloaded one folder of the five.
   *
   * So each of these is one `run` that works through its paths in order and
   * says one sentence about the lot, with one Undo that puts back everything
   * that went. A path that fails stops the batch there, and the sentence says
   * how far it got rather than calling a half-done batch a failure — the ones
   * before it have already happened.
   *
   * Callers pass the paths they mean: `selection.ts`'s `topmost` has already
   * dropped anything inside a folder that is also in the batch.
   */
  moveMany: (paths: readonly string[], destinationFolder: string) => void;
  /** `copyTo` for several paths — the ⌥-drop of a multi-selection. */
  copyManyTo: (paths: readonly string[], destinationFolder: string) => void;
  /** `archive` for several paths, or "Restore" for several archived ones. */
  archiveMany: (paths: readonly string[]) => void;
  restoreMany: (paths: readonly string[]) => void;
  /** `destroy` for several paths: one trip to the trash, one Undo. */
  destroyMany: (paths: readonly string[]) => void;
  setVisibility: (path: string, kind: "file" | "folder", visibility: SettableVisibility) => void;
  /**
   * Point one note **or folder** at a group or a person, by name.
   *
   * Beside `setVisibility` rather than a third value on it: that setter takes
   * the two tiers and stays that way, because widening it would make every
   * caller of it a way to mint a rule.
   *
   * **`kind` is not optional, and that is the whole repair.** This took a path
   * and a name, and sent both to the note action — so sharing a FOLDER with a
   * group answered "Only markdown notes can have their own visibility", from
   * the bottom of the stack, with advice naming a control that cannot express
   * a group. The dialog knew the kind the whole time and the callback threw it
   * away. Required rather than defaulted, so a new call site has to say which
   * it means instead of quietly getting the note path again.
   */
  shareWithGroup: (path: string, kind: "file" | "folder", group: string) => void;
  /**
   * Move an entry between the three positions of the visibility control —
   * private, team, and a link anybody who has it can open.
   *
   * Beside `setVisibility` rather than replacing it, because they answer
   * different questions: that one writes the manifest and is what the tree's
   * markers use, this one composes a manifest write with a share row and is
   * what the single lock control uses. Collapsing them would put the ordering
   * rule `stepsTo` states inside a call site.
   */
  setScope: (path: string, kind: "file" | "folder", from: NoteScope, to: NoteScope) => void;
  /**
   * The notes that currently have a link anybody can open.
   *
   * Read together with an entry's `visibility` to get its position — see
   * `scopeOf`, which is where the rule that a private note is private however
   * many links point at it lives.
   */
  openLinkPaths: ReadonlySet<string>;
  /**
   * Every note path the editor may resolve a `[[link]]` or `[[` completion
   * against — see `docs/decisions/app-and-console.md`, "L1".
   *
   * The union of what the file tree has actually loaded
   * (`knownNotePaths(listings)`, always current) and the search index's own
   * docmap (complete but a disposable derivative that can be behind or
   * entirely absent for a bucket nothing has indexed yet). Sorted, so a
   * caller passing this into a CodeMirror extension gets a stable reference
   * between renders that learned nothing new.
   */
  linkPaths: readonly string[];
  /**
   * Write a working `privacy.md` over one that is missing or unreadable.
   *
   * Present on every browser and inert on most of them, like every other
   * mutating method here — and the UI decides whether to offer it from
   * `canResetPrivacy` rather than from whether calling it would throw.
   */
  resetPrivacy: () => void;
  /**
   * Re-home Context's reserved bucket objects under `.context/`.
   *
   * Optional because this is an owner maintenance control, not an editing
   * capability: an absent function means the Explorer must not offer it.
   */
  updateStorageLayout?: () => void;
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
   * Whether this console can hand a file to the device.
   *
   * **Not a permission.** Downloading is a read and non-negotiable #1 says the
   * exit is never gated — a `member` in somebody else's context and a viewer of
   * the pinned one both download what they can see. What this answers is
   * whether there is a bucket behind the console at all: the landing page's
   * demo has none, and its `FileBrowser` methods are no-ops, so a Download
   * there would be a control that silently does nothing.
   */
  canDownload: boolean;

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
   * Send one filled-in ```form block on the open note.
   *
   * Here rather than on `NoteEditor` because it is a bucket write like every
   * other member of this interface, and because of what makes it unlike them:
   * it is the **only** one a `member` may call. `canEdit` is false for that
   * role and stays false — `files.writeNote` requires `editor` and must — so a
   * console that offered this through the editor's write path would either have
   * to widen that path or would refuse every submission. It is its own action
   * with its own `minimum: "member"`, and this is where it comes out.
   *
   * Resolves rather than throws: the outcome is drawn inside the form block
   * that sent it, beside the button that was pressed, and a rejected promise
   * there is a widget that has to phrase the failure itself.
   */
  submitForm(submission: FormSubmission): Promise<FormOutcome>;

  /**
   * The bytes behind an image the open note embeds, as an `<img>` src.
   *
   * `null` for every failure — missing, forbidden, or a store that is down —
   * because the row draws the same absence for all three and there is nothing a
   * reader can do with the difference. The note is the open one, read inside the
   * implementation: an image borrows its visibility from the notes that
   * reference it, so the pair (note, key) is the question, and a caller choosing
   * the note would be choosing which note vouches for the image.
   */
  loadImage(target: string): Promise<string | null>;

  /** Store a pasted image, and answer with the key to embed or why not. */
  storeImage(image: {
    bytes: ArrayBuffer;
    contentType: string;
  }): Promise<{ target: string } | { error: string }>;

  /** Read the response note named by a form, subject to ordinary note visibility. */
  readFormResponses?: (responsesPath: string) => Promise<FormResponsesOutcome>;

  /** Add or remove the signed-in person's named vote on one response. */
  voteForm?: (vote: FormVote) => Promise<FormOutcome>;

  /** Replace answers on a response when the server allows this viewer to. */
  updateFormResponse?: (change: FormResponseUpdate) => Promise<FormOutcome>;

  /** Delete a response when the server allows this viewer to. */
  retractFormResponse?: (change: FormResponseRetract) => Promise<FormOutcome>;

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
   * Claim or release a link's short name, answering whether it landed.
   *
   * A promise where `revokeShare` above is fire-and-forget, because the
   * dialog's field decides what to do with what was typed on the strength of
   * the answer — and the notice a refusal sets is behind the modal.
   */
  setShareSlug: (shareId: string, slug: string | null) => Promise<boolean>;

  /**
   * Turn a link's answer-taking on or off, answering whether it landed.
   *
   * A toggle, never a re-mint: the token is unchanged, so a link already sent
   * goes on working either way. Only an `anyone` link over a note may be
   * switched on, and the server is what refuses the other two — a client that
   * decided for itself would be a third place for that rule to live.
   */
  setShareCollecting: (shareId: string, collecting: boolean) => Promise<boolean>;

  /**
   * Put a link to this note on the clipboard, and say whether it landed.
   *
   * **Minting and copying are one method because they are one press.** They
   * were two — the dialog awaited a URL and then wrote it — and on iOS Safari
   * that never worked: the clipboard is granted to a call made inside the user
   * activation a press starts, and awaiting a round trip spends it. The write
   * was refused, the caller correctly declined to claim a copy, and the button
   * silently stayed "Copy link". See `copyDeferred`, which is what makes the
   * team case possible at all.
   *
   * Three targets, and the first two are two different audiences rather than
   * two spellings of one:
   *
   *  - `team` mints-or-reuses the link for people who already have access — it
   *    grants nothing, since reading is authorised by membership on every
   *    request, and its token exists to make the URL unguessable, which is what
   *    lets its card carry a title.
   *  - `link` mints-or-reuses the **unlisted** link, which anybody holding can
   *    open with no account. Reusing rather than replacing is the whole
   *    difference between Copy link and Revoke: pressing it on a note that
   *    already has one hands back the link that is already out there.
   *  - `share` copies a link that already exists.
   *
   * The first two were briefly one control in the dialog, and it was the bug
   * that made this comment worth extending: the lock published a note by
   * unlisted link and the only Copy button in reach handed over the *team*
   * URL, which shows nothing at all to the person it was sent to.
   *
   * A copy has to be confirmed and cannot be seen — the clipboard is invisible
   * — so this answers with the words as well as the outcome, and the **caller
   * decides where they go**. That is not ceremony: a success is reported by the
   * pane, after the dialog closes, and a failure has to be reported *inside*
   * the dialog, because the dialog stays open and a notice raised behind a
   * modal is a message nobody can read. Raising it here for both was the
   * version that looked finished and left a person tapping a button that did
   * nothing at all.
   *
   * `message` is `null` when the link could not be made: the server has
   * already said why, and saying "couldn't copy" over the top of a real
   * refusal replaces it with a symptom.
   */
  copyShareLink: (
    target:
      | { kind: "team"; path: string }
      | { kind: "link"; path: string }
      | { kind: "share"; url: string },
  ) => Promise<{ ok: boolean; message: string | null }>;

  /**
   * Turn the link's preview title on or off for one share.
   *
   * Routed through `createShare`, which supersedes an existing share in place
   * and returns the same token — so this changes what a crawler is told without
   * breaking a link the owner has already sent.
   *
   * It takes the **row**, not its recipient string, because which mutation
   * supersedes it depends on which kind of share it is — and for two of the
   * three the recipient is a display string that no mutation can parse. See
   * the implementation for what passing the string alone was doing.
   */
  setSharePreviewTitle: (
    path: string,
    share: { audience: NoteShare["audience"]; recipient: string },
    titleInPreview: boolean,
  ) => void;

  /**
   * Ensure a folder's listing is cached, without selecting it.
   *
   * `select` already loads a folder's listing as a side effect of opening it —
   * this is that fetch on its own, for a view that needs several folders at
   * once and none of them is "the selected one". The Inbox landing page reads
   * every connected channel's folder this way: `0-inbox`, `0-inbox/email` (to
   * find which mailboxes exist), and each channel folder in turn, none of
   * which the person has navigated *into*.
   *
   * A no-op once `listings[path]` is populated — this is a cache to fill, not
   * a subscription, so a caller that wants a fresh read after a write already
   * has `select`/`refresh` for that. Fire-and-forget: the result shows up in
   * `listings` on the next render, the same way every other listing does.
   */
  ensureListing: (path: string) => void;

  /**
   * Read one note's raw text and etag, without opening it in the editor.
   *
   * For a view that reads several notes that are not "the open note" — a
   * channel-day's split parts, a contact page's linked days before they are
   * opened. Goes through the same visibility as everything else: a path this
   * scope cannot see answers `null`, byte-identically to a path that does not
   * exist, exactly as `read_channel_day` and `read_note` already promise.
   *
   * Never touches `editor`, `opening` or any of `select`'s bookkeeping — this
   * is a plain read, not a navigation, and does not compete with one for the
   * generation counters that keep a superseded read from landing.
   */
  readRaw: (path: string) => Promise<{ text: string; etag: string } | null>;
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

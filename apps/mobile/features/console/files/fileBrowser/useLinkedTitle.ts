/**
 * The open note's title renaming its file — `linkedTitle.ts` has the rule, and
 * this is when it runs.
 *
 * ## When: on leaving the title, once the editor has settled
 *
 * Not on a timer. A rename is a move, and a move rewrites every link to the
 * note across the context — so it should happen once per edit of the title,
 * not once per pause in typing it. The web editor reports whether the caret is
 * in the title (`setTitleCaret`); leaving it — Enter, ↓, a click in the body,
 * the editor losing focus — is the commit.
 *
 * And not while anything is in flight. `clean` and `saved` are the two states
 * where the draft is in the bucket and the etag the editor holds is the one the
 * bucket answered with; renaming at any other moment races the write. That is
 * the rule the one-time untitled rename this replaces was written around, and
 * it carries over unchanged.
 *
 * The native editor reports focus and nothing finer, so there a focused
 * editor counts as "in the title" (`noteEditor/document.tsx`) and the rename
 * runs when the keyboard goes away.
 *
 * ## Leaving the note before it settles does not cancel the rename
 *
 * Leaving the note is leaving the title too, and it is the moment the save is
 * least likely to have settled — the autosave is flushed on the way out, and a
 * collaborative note's keystrokes are still on their way to the bucket (or
 * waiting out a reconnect). Waiting only while the note is open meant that the
 * commonest way to finish naming a note, going to the next one, dropped the
 * rename and left it `untitled-<date>` (reported 2026-09-26). So a rename that
 * is owed when the editor moves on is carried: it runs once a read of the
 * bucket shows the draft that was left there, which is the same "the draft is
 * in the bucket" condition a settled status stands for, asked of the bucket
 * directly because this editor is no longer watching that note. If it never
 * shows up — somebody else kept typing, or the connection never came back —
 * the note keeps its name, which is no worse than before. Reopening the note
 * before then hands it back to the editor, which renames it the ordinary way.
 *
 * ## Only for a title somebody changed here, under their own caret
 *
 * The rename needs the title to differ from the one the note was **opened**
 * with, not merely from the file name — an `untitled-<date>` note from last
 * week whose heading its owner changed by hand is linked by name, and must not
 * move because somebody opened it today. And it needs the change to have been
 * made while this person's caret was in the title: a collaborator typing into
 * the same note changes this draft too, and it is theirs to rename. One
 * attempt per title, so a refusal is said once and not retried on every save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isLinkedTitle, proposeTitle, type TitleProposal } from "../linkedTitle";
import { sharesBreakingWarning } from "../shares";
import { isUntitled, titleFor } from "../untitled";
import type { BrowserStateValues } from "./useBrowserState";
import type { CreateAndMoveValues } from "./useCreateAndMove";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { RowCommandsValues } from "./useRowCommands";
import type { SharesValues } from "./useShares";

type LinkedTitleDeps =
  & Pick<FileActionsValues, "readNote" | "workspaceId">
  & Pick<BrowserStateValues, "editor" | "renamed">
  & Pick<OfflineQueueValues, "listings">
  & Pick<CreateAndMoveValues, "awaitingTitle">
  & Pick<RowCommandsValues, "rename">
  & Pick<SharesValues, "shares">;

/** What the open note's title is doing to its name, for the chrome to draw. */
export interface TitleEdit {
  path: string;
  /** The name the tab and the row show while the title is being typed. */
  label: string | null;
  /** The line under the title, when there is something to say. */
  note: { tone: "problem" | "held"; message: string } | null;
}

/**
 * When a rename carried out of the note reads the bucket to see whether the
 * new title has landed — immediately, then backing off. Long enough to ride
 * out a reconnect; bounded, so a title that never reaches the bucket is not a
 * move that fires at some arbitrary moment later in the session.
 */
export const OWED_RENAME_DELAYS_MS: readonly number[] = [0, 500, 1_500, 4_000, 10_000, 30_000];

/** A rename the open note was owed when the editor moved to another one. */
interface OwedRename {
  from: string;
  name: string;
  /**
   * The whole draft as it was left. The bucket must hold exactly this before
   * the file moves — the title alone is not enough, because a collaborative
   * note's unsent keystrokes wait on this device under the note's *path*, and
   * a move made before they land would strand them at the old name.
   */
  text: string;
  /** The title the note was opened with, for handing it back on reopen. */
  openedTitle: string | null;
  workspaceId: FileActionsValues["workspaceId"];
}

export function useLinkedTitle(deps: LinkedTitleDeps) {
  const { awaitingTitle, editor, listings, readNote, rename, renamed, shares, workspaceId } = deps;

  /*
    The rename the open note is owed and has not asked for yet, kept current
    while the note is open so that leaving it can carry it (see the header).
    `carried` is every rename that left with its note, by path, until it runs,
    gives up, or is handed back.
  */
  const owed = useRef<OwedRename | null>(null);
  const carried = useRef(new Map<string, OwedRename>());
  const latest = useRef({ readNote, rename, workspaceId });
  latest.current = { readNote, rename, workspaceId };
  useEffect(() => {
    const pending = carried.current;
    return () => pending.clear();
  }, []);

  const carry = useCallback((left: OwedRename) => {
    carried.current.set(left.from, left);
    void (async () => {
      for (const delay of OWED_RENAME_DELAYS_MS) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (carried.current.get(left.from) !== left) return;
        const now = latest.current;
        if (now.workspaceId !== left.workspaceId || left.workspaceId === null) break;
        try {
          const note = await now.readNote({ workspaceId: left.workspaceId, path: left.from });
          if (carried.current.get(left.from) !== left) return;
          if (note.readOnly || note.encrypted === true) break;
          if (note.text === left.text) {
            carried.current.delete(left.from);
            awaitingTitle.current.delete(left.from);
            now.rename(left.from, left.name);
            return;
          }
        } catch {
          // Offline, or the read failed: the next attempt asks again.
        }
      }
      if (carried.current.get(left.from) === left) carried.current.delete(left.from);
    })();
  }, [awaitingTitle]);

  /*
    What the note was when it was opened: whether its title is its name, and
    what the title was. Reset whenever the editor moves to another path — a
    rename landing is one of those, and the note then reads as linked again at
    its new name, which is what lets a second edit of the title follow too.
  */
  const [opened, setOpened] = useState<{ path: string; linked: boolean; title: string | null } | null>(
    null,
  );
  /*
    The title a rename was last asked for, on this open. State rather than a
    ref because the chrome reads it: while that rename is in flight the row is
    already drawn at the new name, and a proposal computed against that listing
    would call the note's own new name taken.
  */
  const [acted, setActed] = useState<{ title: string; label: string; path: string } | null>(null);
  /*
    Whether the title changed under this person's own caret. A collaborator
    typing a new title into the same note changes this draft too, and their
    half-typed "Q4 pl" is not a name anybody here asked for — so only a change
    made while the caret was in the title is one this client may act on. The
    person typing it renames it, from their own client, when they leave it.
  */
  const [touched, setTouched] = useState(false);
  const [titleFocus, setTitleFocus] = useState<{ path: string; id: number } | null>(null);
  const baseline = editor.baseline;
  useEffect(() => {
    const path = editor.path;
    const left = owed.current;
    owed.current = null;
    if (left !== null && left.from !== path) carry(left);
    setActed(null);
    setTouched(false);
    if (path === null) {
      setOpened(null);
      return;
    }
    // Back on a note whose rename was carried out of it: the editor takes it
    // over again, as if this person had never left.
    const returned = carried.current.get(path);
    if (returned !== undefined) {
      carried.current.delete(path);
      setOpened({ path, linked: true, title: returned.openedTitle });
      setTouched(true);
      return;
    }
    const title = titleFor(baseline);
    setOpened({ path, linked: awaitingTitle.current.has(path) || isLinkedTitle(path, baseline), title });
    // A note made a moment ago opens with its placeholder title selected, so
    // the first keystroke replaces it rather than landing after it.
    if (awaitingTitle.current.has(path) && isUntitled(path)) {
      setTitleFocus((last) => ({ path, id: (last?.id ?? 0) + 1 }));
    }
    // Keyed on the path alone: the baseline moves on every save, and a note
    // whose saved title now differs from its name is exactly the one this is
    // about to rename — reading it again would unlink it first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.path]);

  const [inTitle, setInTitle] = useState(false);
  const setTitleCaret = useCallback((next: boolean) => setInTitle(next), []);
  const draftTitle = titleFor(editor.draft);
  useEffect(() => {
    if (inTitle && opened !== null && draftTitle !== opened.title) setTouched(true);
  }, [draftTitle, inTitle, opened]);

  const proposal: TitleProposal | null = useMemo(() => {
    if (opened === null || !opened.linked || !touched || opened.path !== editor.path) return null;
    if (editor.readOnly || editor.encrypted) return null;
    const title = titleFor(editor.draft);
    if (title === opened.title || title === acted?.title) return null;
    return proposeTitle({
      path: opened.path,
      draft: editor.draft,
      listings,
      sharesWarning: sharesBreakingWarning(shares, opened.path, "Renaming"),
    });
  }, [acted, editor.draft, editor.encrypted, editor.path, editor.readOnly, listings, opened, shares, touched]);

  /*
    Kept current only while the editor is still on the opened note: the render
    in which it moves on computes no proposal for the note it left, and that
    must not read as the title having gone back.
  */
  useEffect(() => {
    if (opened === null || opened.path !== editor.path) return;
    owed.current =
      proposal !== null && proposal.kind === "rename" && draftTitle !== null
        ? {
            from: opened.path,
            name: proposal.name,
            text: editor.draft,
            openedTitle: opened.title,
            workspaceId,
          }
        : null;
  }, [draftTitle, editor.draft, editor.path, opened, proposal, workspaceId]);

  useEffect(() => {
    if (proposal === null || proposal.kind !== "rename" || opened === null) return;
    if (inTitle) return;
    if (editor.status !== "clean" && editor.status !== "saved") return;
    const folder = opened.path.includes("/") ? opened.path.slice(0, opened.path.lastIndexOf("/") + 1) : "";
    owed.current = null;
    setActed({ title: draftTitle!, label: proposal.label, path: `${folder}${proposal.name}` });
    awaitingTitle.current.delete(opened.path);
    rename(opened.path, proposal.name);
  }, [awaitingTitle, draftTitle, editor.status, inTitle, opened, proposal, rename]);

  const titleEdit: TitleEdit | null = useMemo(() => {
    if (opened === null) return null;
    /*
      The rename is in flight: the row is drawn at the new name, and the editor
      is still on the old path until the bucket says yes. Keep the tab on the
      name it is becoming — without this the proposal goes quiet the moment
      the rename is asked for, and the tab reads the old name for a frame
      before the strip follows. A refused rename sends `renamed` back the
      other way, and the tab goes back with it.
    */
    if (
      proposal === null &&
      acted !== null &&
      renamed?.from === opened.path &&
      renamed.to === acted.path &&
      editor.path === opened.path
    ) {
      return { path: opened.path, label: acted.label, note: null };
    }
    if (proposal === null) return null;
    if (proposal.kind === "rename") return { path: opened.path, label: proposal.label, note: null };
    if (proposal.kind === "same") return null;
    return {
      path: opened.path,
      label: null,
      note: { tone: proposal.kind, message: proposal.message },
    };
  }, [acted, editor.path, opened, proposal, renamed]);

  /*
    "Rename" on the row of the open, linked note goes to the title rather than
    to a dialog: that is where its name is. A counter so asking twice is two
    asks. Anything else answers `false`, and the caller opens the dialog.
  */
  const focusTitle = useCallback(
    (path: string): boolean => {
      if (opened === null || opened.path !== path || !opened.linked) return false;
      if (editor.readOnly || editor.encrypted) return false;
      setTitleFocus((last) => ({ path, id: (last?.id ?? 0) + 1 }));
      return true;
    },
    [editor.encrypted, editor.readOnly, opened],
  );

  return { titleEdit, setTitleCaret, titleFocus, focusTitle };
}

export type LinkedTitleValues = ReturnType<typeof useLinkedTitle>;

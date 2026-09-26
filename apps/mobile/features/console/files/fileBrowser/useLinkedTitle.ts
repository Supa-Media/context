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

import { useCallback, useEffect, useMemo, useState } from "react";
import { isLinkedTitle, proposeTitle, type TitleProposal } from "../linkedTitle";
import { sharesBreakingWarning } from "../shares";
import { isUntitled, titleFor } from "../untitled";
import type { BrowserStateValues } from "./useBrowserState";
import type { CreateAndMoveValues } from "./useCreateAndMove";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { RowCommandsValues } from "./useRowCommands";
import type { SharesValues } from "./useShares";

type LinkedTitleDeps =
  & Pick<BrowserStateValues, "editor">
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

export function useLinkedTitle(deps: LinkedTitleDeps) {
  const { awaitingTitle, editor, listings, rename, shares } = deps;

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
  const [acted, setActed] = useState<string | null>(null);
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
    setActed(null);
    setTouched(false);
    if (path === null) {
      setOpened(null);
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
    if (title === opened.title || title === acted) return null;
    return proposeTitle({
      path: opened.path,
      draft: editor.draft,
      listings,
      sharesWarning: sharesBreakingWarning(shares, opened.path, "Renaming"),
    });
  }, [acted, editor.draft, editor.encrypted, editor.path, editor.readOnly, listings, opened, shares, touched]);

  useEffect(() => {
    if (proposal === null || proposal.kind !== "rename" || opened === null) return;
    if (inTitle) return;
    if (editor.status !== "clean" && editor.status !== "saved") return;
    setActed(draftTitle);
    awaitingTitle.current.delete(opened.path);
    rename(opened.path, proposal.name);
  }, [awaitingTitle, draftTitle, editor.status, inTitle, opened, proposal, rename]);

  const titleEdit: TitleEdit | null = useMemo(() => {
    if (proposal === null || opened === null) return null;
    if (proposal.kind === "rename") return { path: opened.path, label: proposal.label, note: null };
    if (proposal.kind === "same") return null;
    return {
      path: opened.path,
      label: null,
      note: { tone: proposal.kind, message: proposal.message },
    };
  }, [opened, proposal]);

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

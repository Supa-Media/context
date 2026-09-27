import { BottomBar } from "./BottomBar";
import { parentPath } from "./files/paths";
import { targetFolder } from "./files/tree";
import { canGoBack, type HistoryState } from "./files/history";
import type { FolderListing } from "./files/types";
import type { ConsoleData } from "./types";

/**
 * Where the Browse key goes: the folder page of what is open.
 *
 * A note opens the folder it is in. A folder page is already a folder, so the
 * key goes one up — pressing it on `1-projects/trips` shows `1-projects`, which
 * is what "the folder this is in" means for a folder. `""` is the context's own
 * page, which the pane draws with nothing selected, so the caller deselects
 * rather than selecting `""` (`NavBand`'s root pill argues why a selection of
 * `""` is the wrong spelling of it).
 *
 * `null` when nothing is open: the phone is already on the context's own page
 * and the key has nowhere further out to take you.
 */
export function browseDestination(
  listings: Readonly<Record<string, FolderListing | undefined>>,
  selectedPath: string | null,
): string | null {
  if (selectedPath === null) return null;
  const folder = targetFolder(listings, selectedPath);
  return folder === selectedPath ? parentPath(folder) : folder;
}

/**
 * THE PHONE'S FIVE KEYS: Back, Browse, Search, New, Recent.
 *
 * Approved by the owner on 2026-09-27 (the phone artboards, screen 1): a short
 * centred capsule of five icon-only keys, the shape of Obsidian's, for a
 * visitor on the homepage and a signed-in member alike. It was six — `‹ ›`,
 * Search, `+`, Recent and a `✓` Save — and two went:
 *
 *  - **`›` (forward)** was the least-pressed key on the row. Recent reaches the
 *    page you came back from, and holding `‹` opens that list too.
 *  - **`✓` (save)** duplicated autosave, which writes two seconds after the
 *    last keystroke, and the top bar's sync mark, which says whether it
 *    landed. The one state autosave will not retry from — a failed save — has
 *    its Save button at the foot of the note on a phone now (`noteFoot`'s
 *    `manualSave`), beside the sentence explaining what went wrong.
 *
 * Browse took a slot: it opens the folder page of the note you are on, the
 * page the breadcrumb's segments already open, so the listing a phone lost
 * with its file tree is one press from any note.
 *
 * It lives outside `app/(app)/console/_layout.tsx` so the design canvas
 * (`features/e2e/AppFrameVisualFixture.tsx`) can mount the real row rather
 * than a stub. The bar's own geometry and its dimming policy are `BottomBar`'s.
 */
export function ConsoleBottomBar({
  data,
  history,
  hasRecent,
  onStep,
  onSearch,
  onOpenRecent,
  onCreate,
}: {
  data: ConsoleData;
  /** Where you have been, for `‹`. */
  history: HistoryState;
  /**
   * Whether the Recent sheet has anywhere to send you.
   *
   * Computed by the caller, which is where the selection is — the list always
   * contains the note on screen, so "not empty" is the wrong question.
   */
  hasRecent: boolean;
  /** One step through `history`. The phone's row only ever steps back. */
  onStep: (delta: -1 | 1) => void;
  onSearch: () => void;
  onOpenRecent: () => void;
  /**
   * Raises the create sheet for a destination — see the `new` action.
   *
   * `null` where that sheet would have no rows at all: the caller wires them, so
   * the caller is the one that can answer it (`files/createSheet.ts`). A `+` that
   * opens a sheet holding nothing but Cancel is worse than no `+`.
   */
  onCreate: ((folder: string) => void) | null;
}) {
  const files = data.files;
  // The same rule the explorer's own `+` uses, from the same function: a
  // selected *folder* is the destination, anything else means its parent.
  const folder = targetFolder(files.listings, files.selectedPath);
  const browse = browseDestination(files.listings, files.selectedPath);

  return (
    <BottomBar
      actions={[
        /*
          `‹` leads the bar, where Obsidian and every browser put it. A phone
          shows one note at a time, so "the one I was just looking at" is a
          destination somebody reaches constantly and cannot see.

          Dimmed in place rather than removed at the start of the history —
          `BottomBar`'s rule: a bar whose first position comes and goes moves
          every other target under a thumb already travelling to it.

          Held, it opens the Recent sheet, which is where every browser keeps
          its history list. A second route, never the only one: Recent is on
          the row too. `disabled` suppresses the hold with the press, which is
          right — at the start of a history the sheet has nothing to offer.
        */
        {
          id: "back",
          label: "Go back",
          hint: "Hold for recent",
          icon: "chevronLeft" as const,
          disabled: !canGoBack(history),
          onPress: () => onStep(-1),
          onLongPress: hasRecent ? onOpenRecent : undefined,
        },
        /*
          Browse: the folder page of what is open. See `browseDestination`.
          Dimmed in place on the context's own page, where there is nowhere
          further out to go, for the reason `‹` dims rather than vanishing.
        */
        {
          id: "browse",
          label: "Browse this folder",
          icon: "folder" as const,
          disabled: browse === null,
          onPress: () => {
            if (browse === null) return;
            if (browse === "") files.deselect();
            else files.select(browse);
          },
        },
        { id: "search", label: "Search notes", icon: "search" as const, onPress: onSearch },
        /*
          ONE KEY FOR EVERYTHING YOU START.

          It raises the sheet that offers everything a `+` can start — a note,
          a drawing, a folder, a chat, a meeting — the same rows in the same
          order as `CreateButton`'s menu (`files/createSheet.ts`), presented as
          a bottom sheet on a phone (`CreatePrompt`). Nothing is written until a
          row is chosen, so the destination is said before anything lands.

          **Present for a read-only context too.** `menu.ts`'s rule — read-only
          means the control is gone, not present and refusing — holds a row
          lower down: the sheet draws no Note, Drawing or Folder row without
          `canEdit`, and a meeting is something a reader can still start. `null`
          is absent, for the one case where there is genuinely nothing behind
          it.
        */
        ...(onCreate === null
          ? []
          : [
              {
                id: "new",
                label: "Create",
                icon: "plus" as const,
                onPress: () => onCreate(folder),
              },
            ]),
        /*
          Recent: somewhere you were, from `history.ts`.

          No count and no marker. A phone opens one note at a time, so a tab
          count there could only ever read `1`; a recency list has no number
          worth printing. **Dimmed in place, never absent**, for the first
          moments of a session when there is nowhere to go back to — the rule
          `‹` lives by, since this is a second control over the same history.
        */
        {
          id: "recent",
          label: "Recently opened",
          icon: "clock" as const,
          disabled: !hasRecent,
          onPress: onOpenRecent,
        },
      ]}
    />
  );
}

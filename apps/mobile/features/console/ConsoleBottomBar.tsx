import { BottomBar } from "./BottomBar";
import { targetFolder } from "./files/tree";
import { canGoBack, type HistoryState } from "./files/history";
import type { ConsoleData } from "./types";

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
 * Browse took a slot. It first opened the folder page of the note on screen,
 * which was "up a level" wearing a folder glyph, dimmed on the context's own
 * page and duplicating the breadcrumb (Dev2 found it unclear, 2026-09-28). It
 * now opens the whole tree as a sheet (`TreeSheet`), and is never dimmed.
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
  onBrowse,
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
  /** Raises the tree sheet — see `TreeSheet`. */
  onBrowse: () => void;
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
          Browse: the whole tree, as a sheet (`TreeSheet`). Never dimmed:
          there is always a tree, including on the first page a visitor
          lands on, which is where the old "up a level" key had nowhere to go.
        */
        {
          id: "browse",
          label: "Browse files",
          icon: "folder" as const,
          onPress: onBrowse,
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

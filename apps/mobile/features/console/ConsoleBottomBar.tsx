import { BottomBar } from "./BottomBar";
import { targetFolder } from "./files/tree";
import { canGoBack, canGoForward, type HistoryState } from "./files/history";
import type { ConsoleData } from "./types";

/**
 * THE PHONE'S SIX KEYS.
 *
 * Lifted out of `app/(app)/console/_layout.tsx` — every comment below is the one
 * it was written with, and nothing about the bar's geometry moved with it.
 *
 * It was seven. The seventh was a microphone that opened the meeting sheet, and
 * it is gone: *"we no longer need a dedicated mic button on the bottom row, just
 * a plus button that opens different options"*. Recording is one of the things
 * the `+` now offers, so the row lost a key rather than a capability.
 *
 * It left the route file for two reasons, and the second is the one that
 * prompted it:
 *
 *  1. `_layout.tsx` is a route, and this repository's own lint rule says a
 *     route file should be thin. This was 210 lines of it.
 *  2. **A component defined inside a route cannot be mounted by anything
 *     else** — including `features/e2e/AppFrameVisualFixture.tsx`, which is
 *     where the design canvas is compared against the running app. So the
 *     phone board had `<Text>toolbar</Text>` in the slot where the product
 *     draws this, and "does the phone match the design" was a question that
 *     surface could not answer. A fixture that stubs the thing under review is
 *     a fixture reporting on itself.
 *
 * Every rule about *which* keys and *why* stays in the comments inside; the
 * bar's own geometry, its dimming policy and its separator are `BottomBar`'s.
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
  /** Where you have been, for `‹` and `›`. */
  history: HistoryState;
  /**
   * Whether the Recent sheet has anywhere to send you.
   *
   * Computed by the caller, which is where the selection is — the list always
   * contains the note on screen, so "not empty" is the wrong question.
   */
  hasRecent: boolean;
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

  return (
    <BottomBar
      actions={[
        /*
          No drawer toggle here.

          There were two — this one and `AppFrame`'s top-bar button — with the
          same icon, calling the same function, on one 390pt screen. The
          defence written here was thumb reach: "the tree toggle is here as
          well as in the top bar because this is where a thumb is, and the top
          bar is a stretch on a tall phone."

          That was never a fallback for any layout. `regionsFor` turns
          `drawerToggle` on only at `compact`, which is the one density where
          `bottomBar` is unconditionally true — so the two existed together or
          not at all, and neither was ever the only way in.

          The owner chose the top-left one (2026-08). It is where Obsidian
          puts the sidebar toggle and where the panel it opens comes from, so
          the button and its result are on the same side. The thumb-reach half
          of the old argument is answered by the edge-swipe, not by a second
          button in the other corner.
        */
        /*
          `‹` and `›` lead the bar, which is where Obsidian puts them and where
          every browser puts them. A phone shows one note at a time, so "the one
          I was just looking at" is a destination somebody reaches constantly
          and cannot see — and before this the only route to it was to open the
          drawer and find it in the tree again.

          Dimmed in place rather than removed at the ends of the history, which
          is `BottomBar`'s own rule for Save and is doubly right here: these two
          spend most of a session with at least one of them unavailable, and a
          bar whose first two positions come and go moves every other target.
        */
        /*
          Held, `‹` opens the same Recent sheet its own target further along the
          row opens. That is where every browser on every platform keeps its
          history list, so it costs nothing to honour and it puts the list under
          the thumb that just pressed back and found it went one step too few.

          A second route, never the only one — see `onLongPress` in
          `BottomBar`. `disabled` suppresses the hold with the press, which is
          right: at the start of a history there is nothing behind you, and that
          is precisely when the sheet has nothing to offer either.
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
        {
          id: "forward",
          label: "Go forward",
          icon: "chevronRight" as const,
          disabled: !canGoForward(history),
          onPress: () => onStep(1),
        },
        { id: "search", label: "Search notes", icon: "search" as const, onPress: onSearch },
        /*
          ONE KEY FOR EVERYTHING YOU START.

          This used to call `createNote(folder, "Untitled")` directly, which
          made one icon mean two different things on one screen: the drawer's
          `+` asked for a name and said where it was going, this one wrote
          immediately and said neither. Worse, `folder` is derived from a
          selection that lives *in the drawer* — normally shut when this button
          is pressed — so the destination was invisible, defaulted to the
          bucket root, and a second press failed on the name collision rather
          than making a second note.

          It then raised a chooser of three files, and now raises the sheet that
          offers all five things a `+` can start, because the row beside it went:
          *"we no longer need a dedicated mic button on the bottom row, just a
          plus button that opens different options"*. Same rows, same order, from
          the same function as `CreateButton`'s menu — see `CreatePrompt` and
          `files/createSheet.ts`.

          **Present for a read-only context too, where it used to be absent.**
          `menu.ts`'s rule — read-only means the control is *gone*, not present
          and refusing — still holds, a row lower down: the sheet draws no Note,
          Drawing or Folder row without `canEdit`, and a meeting is something a
          reader can still start. Dropping the key on `canEdit` would take
          meeting capture off every shared context somebody reads, which is what
          the seventh key used to guarantee it had. `null` is still absent, for
          the one case where there is genuinely nothing behind it.
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
          Recent, in the slot the tab count used to hold.

          **The count is gone rather than fixed, and that is the change.** It
          was Obsidian's, Safari's and Chrome's number-in-a-square, and its
          whole affordance was that the number moves as you work — on a phone it
          could not. Nothing here opens a second tab: `openInNewTab` is
          `platform === "web"` only (`menu.ts`), its row menu lives in the
          Explorer, and `frame.ts` hides the Explorer at `compact`. Every open
          arrives as a `preview`, and a preview replaces the preview slot. A `1`
          that is always `1` is a label pretending to be a state.

          What a phone actually needs from that slot is the thing `‹` gives one
          step at a time: somewhere you were. `history.ts` already holds it.

          No `count` and no `marker`. A recency list has no number worth
          printing, and the dot the tab control carried said "unsaved" about a
          console that autosaves at 2s — a warning that resolves itself while
          you read it. The states that do not resolve are a conflict and a
          failed save, and those are `needsDecision`, which speaks in the notice
          line rather than as a dot in a sheet.

          **Dimmed in place, never absent** — the rule `‹` and `›` two positions
          up already live by, and this is the third control over the same
          history. The tab count it replaces was conditional, and its own
          comment defended that as "the last item on the bar", which it was not:
          Save, a rule and the meeting key all sat after it, so every one of
          them slid sideways the first time a note opened. A recency control is
          unavailable for the first moments of every session and available for
          the rest, which is precisely the shape `BottomBar` says must not come
          and go.
        */
        {
          id: "recent",
          label: "Recently opened",
          icon: "clock" as const,
          disabled: !hasRecent,
          onPress: onOpenRecent,
        },
        {
          id: "save",
          label: "Save this note",
          icon: "check" as const,
          // Absent rather than dead would move every other button mid-reach,
          // so it dims in place — see `BottomBar`. Live for `error` too: that
          // is the one state autosave will not retry from, so the thumb has to
          // be able to. Same set as ⌘S; see `Shortcuts`.
          disabled: files.editor.status !== "dirty" && files.editor.status !== "error",
          marker: files.editor.status === "dirty" || files.editor.status === "error",
          onPress: files.save,
        },
      ]}
    />
  );
}

import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { AsidePanel } from "../aside/AsidePanel";
import { ConsoleBottomBar } from "../ConsoleBottomBar";
import { noteQuickActions, type NoteQuickId } from "../NoteQuickBar";
import type { FileEntry } from "../files/types";
import { noteActionItems } from "./noteActions";
import { runNoteAction } from "./NoteActionsSheet";
import { Explorer, type Dialog } from "../files/Explorer";
import type { TreePick } from "../files/selection";
import { saveChip } from "../files/status";
import { SyncPill } from "../files/SyncSheet";
import type { useTabs } from "../files/useTabs";
import { PhoneBack } from "../home/PhoneBack";
import { phoneBackTarget } from "../home/phoneBack";
import { SwitcherMenu } from "../SwitcherMenu";
import type { ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";

/*
  The console's pieces of `AppFrame`'s slots: the phone's sync pill,
  the right panel, the file tree, and the phone's toolbar. Each
  is a function returning the element rather than a component, so the tree the
  layout renders is exactly the one it rendered when these were inline.
*/

export function consoleSyncSlot({
  phone,
  browsing,
  data,
  setSyncOpen,
}: {
  phone: boolean;
  browsing: boolean;
  data: ConsoleData;
  setSyncOpen: Dispatch<SetStateAction<boolean>>;
}) {
  /*
    The phone's half of the status strip — Offline, the queue, and the
    open note's own `Queued` / `Cached copy` — as a pill in the header
    that opens a sheet naming the notes. `SyncPill` renders nothing when
    there is nothing to say, which is almost always.

    `browsing`, as the Recent sheet is: the sheet's rows open notes, and
    Browse is where a note is opened. `AppFrame` refuses the slot at a
    pointer density on its own, where the strip and `SaveMark` say it.
  */
  return (
    phone && browsing ? (
      <SyncPill
        sync={data.files.sync}
        save={saveChip({ editor: data.files.editor, now: Date.now() })}
        onPress={() => setSyncOpen(true)}
      />
    ) : undefined
  );
}

/**
 * The phone's top-left: the workspace's own button on Home, and ‹ back on
 * every page below it (owner, 2026-10-01). See `home/phoneBack.ts`.
 *
 * A signed-out visitor keeps Sign in beside the back button: it is the one call
 * to action the top bar carries, and the homepage opens on a page, not on Home.
 */
export function consoleAccountSlot({
  phone,
  browsing,
  data,
  switcherProps,
}: {
  phone: boolean;
  browsing: boolean;
  data: ConsoleData;
  switcherProps: ComponentProps<typeof SwitcherMenu>;
}) {
  const account = <SwitcherMenu {...switcherProps} trigger="phone" />;
  const target = phone && browsing ? phoneBackTarget(data.files.selectedPath) : null;
  if (target === null) return account;
  return (
    <PhoneBack
      target={target}
      onBack={() => {
        if (target.folder === null) data.files.deselect();
        else data.files.select(target.folder);
      }}
      after={switcherProps.onSignIn !== undefined ? account : undefined}
    />
  );
}

export function consoleAsidePanel({
  data,
  agentEngine,
  agentPlace,
  asked,
  meetingsAt,
  newChatAt,
  router,
}: {
  data: ConsoleData;
  agentEngine: ConsoleAside["agentEngine"];
  agentPlace: ConsoleAside["agentPlace"];
  asked: ConsoleAside["asked"];
  meetingsAt: number | null;
  newChatAt: number | null;
  router: ConsoleRouter;
}) {
  /*
    The right panel's contents. Supplied here rather than by the pane for
    `explorer`'s reason: it is a region of the frame, so the frame owns
    whether it is a column or an overlay, and this owns what is in it.

    **No `browsing` guard, deliberately**, where `explorer` has one. The
    tree is about a route — Map and Connections have none — and the panel
    is about the context, so a question asked from the Map is a question
    about the same notes. `regionsFor` says the same thing by taking no
    `hasExplorer` term for it.
  */
  return (
    data.demo && data.visitor?.meetings === undefined ? undefined : (
      <AsidePanel
        /*
          The homepage's visitor gets the Meetings tab alone: their demo
          meeting runs here, and there is no agent behind a chat for them.
        */
        chat={!data.demo}
        engine={agentEngine}
        place={agentPlace}
        asked={asked}
        started={meetingsAt}
        newChat={newChatAt}
        /*
          A finished meeting's note, opened in the editor behind the
          panel. `noteEditorHref` builds a console address out of the
          record's own two halves, so this is the ordinary "open a note"
          the console already does rather than a route of this feature's.
        */
        onOpenNote={
          data.visitor?.meetings !== undefined
            ? (_href, path) => data.visitor?.meetings?.openNote(path)
            : data.demo
              ? null
              : (href) => router.push(href)
        }
      />
    )
  );
}

export function consoleExplorer({
  browsing,
  data,
  contextLabel,
  treePick,
  setTreePick,
  tabs,
  setTreeOverlay,
  switcherProps,
}: {
  browsing: boolean;
  data: ConsoleData;
  contextLabel: string;
  treePick: TreePick;
  setTreePick: Dispatch<SetStateAction<TreePick>>;
  tabs: ReturnType<typeof useTabs>;
  setTreeOverlay: Dispatch<SetStateAction<boolean>>;
  switcherProps: ComponentProps<typeof SwitcherMenu>;
}) {
  return (
    browsing ? (
      <Explorer
        files={data.files}
        contextLabel={contextLabel}
        pick={treePick}
        onPickChange={setTreePick}
        /*
          The foot line and the tree's dots. Absent on the demo console,
          which has no control plane — the column then ends at the counts
          line, exactly as it did before this existed.
        */
        activity={data.activity}
        // The tree's agent squares and the foot's "N agents active".
        agents={data.agents}
        /*
          **No `vault` and no `vaultDetail` any more, and the line they
          composed has not been deleted — it has moved.**

          They were the phone's: the context's name with a chevron and a
          gear, and under it `binding · index · counts`. The line existed
          on a phone because **the status bar does not** — at `compact` the
          frame draws a bottom toolbar and no status strip
          (`features/app/frame.ts`), so without it the only way to learn
          how far a backfill had got was to open settings, which is the
          state that made a stuck backfill and a working one look the same
          for hours.

          A phone has no file tree now, so that footer has no supplier and
          the three facts needed a surface that still exists. They are the
          foot of the context's own page — `features/console/files/contextFoot.ts`
          composes them and `FolderView` draws them — and this component
          is a pointer-layout column, where the top bar's chips and the
          status strip already say all three.
        */
        onOpenPinned={(path) => {
          data.files.select(path);
          tabs.pin(path);
        }}
        onOverlayChange={setTreeOverlay}
        /*
          You, at the foot of the column: the account button, and behind it
          the workspaces, Settings and Sign out. Discord's shape, which the
          owner asked for on 2026-09-26 in place of the title bar's chip and
          the row of recent-workspace marks that used to sit here — see
          `SwitcherMenu`'s header. When the tree is folded away, `AppFrame`
          draws the same menu behind an avatar in the status bar instead.

          `phone` is not a condition here. A phone has no file tree at all
          (`features/app/frame.ts`), so this slot has no supplier at that
          density and the account sheet in its top-left slot (this same
          component, `trigger="phone"`) is its answer.
        */
        workspaces={<SwitcherMenu {...switcherProps} />
        }
      />
    ) : undefined
  );
}

export function consoleBottomBar({
  browsing,
  data,
  setPaletteOpen,
  setSearchScope,
  canCreate,
  setBarDialog,
  note,
}: {
  browsing: boolean;
  data: ConsoleData;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setSearchScope: (scope: string | null) => void;
  canCreate: boolean;
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
  /**
   * The note on screen, for the phone's note bar: its entry, the workspace's
   * label its actions name, and a fresh AI conversation where there is one.
   * `null` on Home, on a folder, and off a phone.
   */
  note: { entry: FileEntry; contextLabel: string; ask: (() => void) | null } | null;
}) {
  const quick =
    note === null
      ? undefined
      : {
          actions: noteQuickActions(
            noteActionItems({
              entry: note.entry,
              canEdit: data.files.canEdit,
              canShare: data.files.canShare,
              visitor: data.visitor !== undefined,
            }).map((item) => item.id),
            note.ask !== null,
          ),
          onAction: (id: NoteQuickId) => {
            if (id === "ask") note.ask?.();
            else runNoteAction(id, { data, entry: note.entry, contextLabel: note.contextLabel, setBarDialog });
          },
        };
  return (
    browsing ? (
      <ConsoleBottomBar
        data={data}
        note={quick}
        onSearch={(scope) => {
          setSearchScope(scope);
          setPaletteOpen(true);
        }}
        onCreate={
          canCreate ? (folder) => setBarDialog({ kind: "create", folder }) : null
        }
      />
    ) : undefined
  );
}

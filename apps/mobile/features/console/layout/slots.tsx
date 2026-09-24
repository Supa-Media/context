import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { AsidePanel } from "../aside/AsidePanel";
import { ConsoleBottomBar } from "../ConsoleBottomBar";
import { ContextFootRow } from "../ContextFootRow";
import { Explorer, type Dialog } from "../files/Explorer";
import type { HistoryState } from "../files/history";
import type { TreePick } from "../files/selection";
import { saveChip } from "../files/status";
import { SyncPill } from "../files/SyncSheet";
import type { useTabs } from "../files/useTabs";
import { MEETINGS_ROUTE } from "../../meetings/route";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
} from "../settings/sections";
import { SwitcherMenu } from "../SwitcherMenu";
import type { ConsoleContext, ConsoleData } from "../types";
import { Account } from "./chrome";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";

/*
  The console's pieces of `AppFrame`'s slots: the phone's sync pill and
  account mark, the right panel, the file tree, and the phone's toolbar. Each
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
    pointer density on its own, where the strip and `SaveChip` say it.
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

export function consoleAccountSlot({
  data,
  requestSignOut,
  router,
  current,
}: {
  data: ConsoleData;
  requestSignOut: () => void;
  router: ConsoleRouter;
  current: ConsoleContext | null;
}) {
  /*
    A phone's top row, and the one thing left pinned in it.

    The account never scrolls away — it is the only sign-out control in
    the product, and a control you have to scroll to find is one somebody
    concludes is missing. The contexts used to be pinned beside it and are
    now the first row of `NavBand`, inside the scroller: navigation that
    lay across the note has become navigation that scrolls with it. The
    trailing capsule is untouched, because the scope and Share act on what
    is on screen and were never navigation.
  */
  return (
    <Account
      data={data}
      compact
      touch
      onSignOut={requestSignOut}
      /*
        The phone's only way to the meetings it has already recorded.

        Its key records now — the sheet that used to carry a "Past
        meetings" row is gone — and at every pointer density this row is
        on the switcher instead, so there is exactly one of it per
        surface. `data.demo` has no meetings behind it.
      */
      onOpenMeetings={data.demo ? undefined : () => router.push(MEETINGS_ROUTE)}
      /*
        Present with no context too. The account scope is about the
        person, so "nothing selected" is a reason to open on an account
        section rather than a reason to withhold the only settings
        control a phone has.
      */
      onOpenSettings={() =>
        router.setParams({
          settings:
            current === null
              ? DEFAULT_ACCOUNT_SETTINGS_SECTION
              : DEFAULT_SETTINGS_SECTION,
        })
      }
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
    data.demo ? undefined : (
      <AsidePanel
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
        onOpenNote={data.demo ? null : (href) => router.push(href)}
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
  current,
  places,
  router,
  contextHrefFrom,
  switcherProps,
}: {
  browsing: boolean;
  data: ConsoleData;
  contextLabel: string;
  treePick: TreePick;
  setTreePick: Dispatch<SetStateAction<TreePick>>;
  tabs: ReturnType<typeof useTabs>;
  setTreeOverlay: Dispatch<SetStateAction<boolean>>;
  current: ConsoleContext | null;
  places: ConsoleAside["places"];
  router: ConsoleRouter;
  contextHrefFrom: ConsoleAside["contextHrefFrom"];
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
          The workspaces, at the foot of the column. `foot.ts` decides what
          fits in the width the panel has been dragged to; this supplies
          the three things it cannot reach on its own — the list, the
          recently-visited log and the router.

          `phone` is not a condition here. A phone has no file tree at all
          (`features/app/frame.ts`), so this slot has no supplier at that
          density and `NavBand`'s strip goes on being its answer.
        */
        workspaces={
          <ContextFootRow
            contexts={data.contexts}
            currentSlug={current?.slug ?? null}
            recent={places}
            /*
              Resolved at press time, never when the row rendered — the log
              moves on every navigation. Same rule, same reason and the
              same call as the phone's strip: a switch lands on the note
              you had open in that context rather than at its root.
            */
            onOpen={(slug) => router.replace(contextHrefFrom(slug))}
            menu={<SwitcherMenu {...switcherProps} trigger="chevron" />}
          />
        }
      />
    ) : undefined
  );
}

export function consoleBottomBar({
  browsing,
  data,
  history,
  somewhereToGo,
  step,
  setPaletteOpen,
  setRecentOpen,
  canCreate,
  setBarDialog,
}: {
  browsing: boolean;
  data: ConsoleData;
  history: HistoryState;
  somewhereToGo: boolean;
  step: (delta: -1 | 1) => void;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setRecentOpen: Dispatch<SetStateAction<boolean>>;
  canCreate: boolean;
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
}) {
  return (
    browsing ? (
      <ConsoleBottomBar
        data={data}
        history={history}
        hasRecent={somewhereToGo}
        onStep={step}
        onSearch={() => setPaletteOpen(true)}
        onOpenRecent={() => setRecentOpen(true)}
        onCreate={
          canCreate ? (folder) => setBarDialog({ kind: "create", folder }) : null
        }
      />
    ) : undefined
  );
}

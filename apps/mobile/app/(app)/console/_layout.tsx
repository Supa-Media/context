import { useCallback, useEffect, useRef, useState } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { useWindowDimensions } from "react-native";
import { ToastHost } from "../../../features/design/components/Toast";
import { AppFrame } from "../../../features/app/AppFrame";
import { densityFor } from "../../../features/app/frame";
import { SwitcherMenu } from "../../../features/console/SwitcherMenu";
import { Avatar } from "../../../features/console/AccountBlock";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { ConsoleNavProvider } from "../../../features/console/ConsoleNavContext";
import { PluginSuggestDialog } from "../../../features/console/plugins/PluginSuggestDialog";
import { PluginTextDialog } from "../../../features/console/plugins/PluginTextDialog";
import { PluginSettingsPane } from "../../../features/console/plugins/PluginSettingsPane";
import { EditorRegion } from "../../../features/console/EditorRegion";
import { type Dialog } from "../../../features/console/files/Explorer";
import { useSignOutFlow } from "../../../features/console/useSignOutFlow";
import { useTabs } from "../../../features/console/files/useTabs";
import { TabStrip } from "../../../features/console/files/TabStrip";
import { hasSomewhereToGo } from "../../../features/console/files/history";
import { NO_PICK, type TreePick } from "../../../features/console/files/selection";
import { useUnsavedGuard } from "../../../features/console/files/useUnsavedGuard";
import { atName } from "../../../features/console/format";
import { NavBandProvider } from "../../../features/console/NavBand";
import { VoiceHostProvider } from "../../../features/voice/VoiceHost";
import {
  hrefFor,
  routeForPath,
  sameRoute,
  type ConsoleRoute,
} from "../../../features/console/nav";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
} from "../../../features/console/settings/sections";
import { selectedContext } from "../../../features/console/types";
import {
} from "../../../features/console/files/scope";
import { useReadMode } from "../../../features/console/files/readMode";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";
import { MEETINGS_ROUTE } from "../../../features/meetings/route";
import { WELCOME_ROUTE } from "../../../features/onboarding/route";
import { NEW_WORKSPACE_ROUTE } from "../../../features/workspace/create";
/*
  The layout's pieces live in `features/console/layout/`, not beside this file:
  every file under `app/` is a route to Expo Router, so a module placed here
  would be one. This file keeps the component, its state and the order its
  hooks run in, and the tree it renders; the pieces are named by what they are.
*/
import { OpenAsideOn } from "../../../features/console/layout/frameBridges";
import { Shortcuts } from "../../../features/console/layout/Shortcuts";
import { Status } from "../../../features/console/layout/chrome";
import {
  useConsoleParams,
  useContextRouteResolution,
  useQuickNoteAction,
} from "../../../features/console/layout/routeCommands";
import { useConsoleHistory } from "../../../features/console/layout/useConsoleHistory";
import { usePaletteSearch } from "../../../features/console/layout/usePaletteSearch";
import { useConsoleCommands } from "../../../features/console/layout/useConsoleCommands";
import { noteTargetsFor } from "../../../features/console/layout/noteTargets";
import { useConsoleAside } from "../../../features/console/layout/useConsoleAside";
import { consoleTopTrailing } from "../../../features/console/layout/topTrailing";
import {
  consoleAccountSlot,
  consoleAsidePanel,
  consoleBottomBar,
  consoleExplorer,
  consoleSyncSlot,
} from "../../../features/console/layout/slots";
import { consoleNavBandNodes } from "../../../features/console/layout/navBand";
import {
  consoleCloseTabConfirm,
  consoleRecentSheet,
  consoleAgentSetup,
  consoleSettings,
  consoleSyncSheet,
} from "../../../features/console/layout/sheets";
import { consoleBarDialogs } from "../../../features/console/layout/barDialogs";
import { consoleCreateButton, consolePhoneChat } from "../../../features/console/layout/createButton";
import { consolePalette } from "../../../features/console/layout/palette";

/**
 * The console, as an application rather than a page.
 *
 * ## What this used to be
 *
 * A `ScrollView` containing a decorative backdrop containing a 1200px centred
 * wrap, with a "Context.lc / Sign out" header above it and a "Free. You bring
 * the bucket · MIT · self-hostable" footer below. That is landing-page
 * furniture, and wrapping a working tool in it produced exactly what it looks
 * like: a card floating in a marketing page, with the file tree scrolling
 * inside a fixed 432px box inside a document that also scrolled.
 *
 * Now the frame owns the viewport and the regions scroll individually. The
 * wordmark and the footer are gone — a header whose only job is to hold a
 * sign-out button is a header you can delete, and the identity moved to the
 * foot of the rail where every application puts it.
 *
 * The landing page still mounts `ConsoleShell` with its fake window chrome,
 * and should: there the console is a *picture* of the product.
 *
 * ## Why the explorer is mounted here and not in the pane
 *
 * The file tree is a region of the frame, not content inside Browse. Mounting
 * it here is what lets it be a resizable column on a desktop and a drawer on a
 * phone without Browse knowing which. It is passed only for routes that have a
 * tree: Map and Connections are app-level panes spanning every context, and
 * `AppFrame` draws no column and no drawer button when the slot is absent.
 *
 * The layout still owns the Convex subscriptions and the URL-is-the-truth rule
 * for which context you are in — both unchanged.
 */
export default function ConsoleLayout() {
  const data = useLiveConsoleData();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const route = routeForPath(pathname);
  const { quickParams, openSettingsSection, checkoutReturn, connectAgent } = useConsoleParams();
  /*
    Ending the session, asked for from either the rail's account block or the
    settings overlay's Sign out row. One flow, because it decides whether
    unsaved work is about to be discarded and two copies of that decision would
    be two answers to it.
  */
  const { requestSignOut, dialog: signOutDialog } = useSignOutFlow(data);
  const handledQuickNote = useRef(false);

  const cleanQuickNoteHref = useContextRouteResolution({ route, data, router, pathname });

  const [paletteOpen, setPaletteOpen] = useState(false);
  /*
    The phone's answer to the tab strip: a Recent sheet over `history`, where
    the tab count and its switcher used to be. `RecentSheet.tsx` carries the
    whole argument — the short version is that nothing on a phone could open a
    second tab, so the count could only ever read `1` and its × was a no-op you
    could watch.

    Held here beside `history` for the reason the tab state is: the sheet acts
    on that model, and a piece of state living one level down from the thing it
    opens is a ref waiting to be written.
  */
  const [recentOpen, setRecentOpen] = useState(false);
  /*
    The phone's sync sheet, behind the pill in its header. A phone has no
    status strip, so this is where "which notes?" is answered there — see
    `SyncSheet.tsx`.
  */
  const [syncOpen, setSyncOpen] = useState(false);
  const closeSync = useCallback(() => setSyncOpen(false), []);
  /*
    The toolbar's `+` raises the explorer's own dialog. Held here rather than
    inside `Explorer` because the toolbar is a sibling of the explorer, not a
    child of it — and `ExplorerDialogs` was already split out of `Explorer` for
    exactly this: "so the tree and the editor can drive the same set without
    either owning it".
  */
  const [barDialog, setBarDialog] = useState<Dialog>(null);
  /*
    The tree's ⌘/shift-click pick. Held here rather than in `Explorer` for the
    reason `barDialog` is: `Shortcuts` is a sibling of the tree, and ⌘⇧⌫ has to
    act on the rows the tree draws selected — see `picked` in `rowCommand.ts`.
  */
  const [treePick, setTreePick] = useState<TreePick>(NO_PICK);
  useQuickNoteAction({ quickParams, handledQuickNote, data, cleanQuickNoteHref, router });
  /*
    The tab whose close is waiting on a confirm.

    `tabs.ts`'s `closed` case says a modal decision has no business inside a
    data structure and that "the UI confirms before dispatching". Nothing did:
    the tab's × and ⌘W both reached the reducer directly, so a dirty tab closed
    silently and the draft was gone. One state, so both routes ask.

    What they ask about is now much narrower. A draft autosave can write is
    written on the way out instead of being asked about — see `closeTab` — so
    this is raised only for a conflict or a failed save.
  */
  const [closingTab, setClosingTab] = useState<string | null>(null);

  /*
    The exit the app does not own. Opening another note and closing a tab both
    write the pending draft now; this is the one the app cannot do that for by
    itself, so on web it flushes when the tab is hidden or closed and prompts
    only for a draft nothing will ever write — a conflict, or a save that
    failed. Native is deliberately a no-op — see the hook.
  */
  useUnsavedGuard({ editor: data.files.editor, flush: data.files.flushAutosave });
  /*
    A menu or a dialog raised by the tree is an overlay too, not just the
    palette. Without this, ⌘K opens the palette *behind* an open context menu:
    `keymap.ts` enforces "nothing behind an overlay fires", but only for the
    scope it is told about.
  */
  const [treeOverlay, setTreeOverlay] = useState(false);
  /*
    Tabs are owned here rather than inside Browse because the keyboard is owned
    here: ⌘W, ⌘⇧T and ⌘1–9 are frame-level chords, and a tab model living one
    level down would have to be reached through a ref or duplicated.
  */
  // Keyed on the context, so switching workspaces empties the strip. Without
  // it, tabs from the previous context survived — pruning cannot close them,
  // because a subfolder of the context you left is never loaded in the one you
  // arrive at — and the strip showed one context's note names under another
  // context's name.
  const tabs = useTabs(data.files, data.selectedContextId);
  const { history, step } = useConsoleHistory({ data, router, route, openSettingsSection });
  const current = selectedContext(data);
  /*
    Whether tabs are on screen at all. `TabStrip` is the pointer instrument and
    there is no thumb half any more — a phone gets Recent instead, over the same
    `history` its `‹ ›` already read. Read here rather than inside either,
    because it also decides which of the two the bottom toolbar carries.
  */
  const phone = densityFor(width) === "compact";
  const insideContext = route.kind === "context";
  const browsing = route.kind === "context" && route.view === "browse";
  const { search, paletteItems } = usePaletteSearch({ data, insideContext, current, paletteOpen });
  /*
    A panel is not a preference — `frame.ts` states the rule for its own two,
    and this is a third one living outside it. The sheet can only be raised on
    a phone, on Browse; rotating a tablet out of compact, or walking to Map,
    leaves nothing on screen that could put it away. Without this it comes back
    the moment you rotate home, over a note you never asked about.

    Cleared rather than merely not rendered, because "not rendered" is what
    makes it come back: the flag would still be true.
  */
  useEffect(() => {
    if (!phone || !browsing) setRecentOpen(false);
  }, [phone, browsing]);

  /**
   * Whether the Recent sheet has anywhere to send you.
   *
   * The list itself is built where it is drawn, below: this runs on every
   * render of the whole console and the sheet is closed for nearly all of them,
   * so the cheap `.some()` is the one that belongs up here.
   */
  const somewhereToGo = hasSomewhereToGo(history, data.files.selectedPath);

  const { nav, closeTab } = useConsoleCommands({ tabs, step, history, data, setClosingTab });

  const contextLabel = atName(current?.slug ?? "your context");

  const { selectedEntry, shareTarget, readable } = noteTargetsFor({ browsing, data });
  const reading = useReadMode();

  const {
    meetingsAt, newChatAt, phoneChatAt, setPhoneChatAt, showMeetings, places, contextHrefFrom,
    startMeetingFlow, meetingSheet, startNewChat, startMeeting, canCreate, agentPlace, asked,
    setAsked, openAsideAt, agentEngine, resumeRow, voiceHost,
  } = useConsoleAside({ data, router, phone, insideContext, current, selectedEntry, pathname });

  /**
   * Where the control is and where a press takes it.
   *
   * Computed unconditionally so the two never disagree about which entry they
   * describe — a `scope` read from the selection and a `next` read from
   * somewhere else is how a control ends up publishing the wrong note. The
   * button is not drawn when there is no target, so the fallbacks are never
   * rendered.
   *
   * A folder has two positions, not three: `createLinkShare` is note-only, so
   * offering a third would be a press that always fails. `scope.ts` states it.
   */

  /*
    One set of handlers, two triggers.

    The title bar's chip opens this menu and so does the chevron at the end of
    `ContextFootRow`, and they have to open the *same* list: every row in it is
    conditional on something — the claim offer, "New workspace", Leave on a
    context you do not own — and a second element built at the other call site is
    how one of those conditions quietly goes missing from one of them. See
    `SwitcherMenu`'s `trigger` prop.
  */
  const switcherProps = {
    data,
    label: insideContext ? contextLabel : "Your context",
    tone: insideContext ? (current?.status ?? "warn") : "neutral",
    onOpenContext: (slug: string) => {
      const next: ConsoleRoute = { kind: "context", slug, view: "browse" };
      if (!sameRoute(next, route)) router.replace(hrefFor(next));
    },
    onOpenMeetings: data.demo ? undefined : () => router.push(MEETINGS_ROUTE),
    onClaimContext: data.demo ? undefined : () => router.push(WELCOME_ROUTE),
    onNewWorkspace: data.demo ? undefined : () => router.push(NEW_WORKSPACE_ROUTE),
    onOpenSettings: () => {
      router.setParams({
        settings:
          route.kind === "context" ? DEFAULT_SETTINGS_SECTION : DEFAULT_ACCOUNT_SETTINGS_SECTION,
      });
    },
    /*
      Leave, on the context you are standing in and only where the server would
      allow it: `leaveWorkspace` refuses an owner (`OWNER_CANNOT_LEAVE`), so a
      row offered on your own workspace would be a press whose only outcome is
      an error. Fire-and-watch, exactly as the rail's row was — the membership
      row deleting is what takes the context out of the list, through the
      subscription — and then land on `/console` so nobody is left standing in a
      context they just left.
    */
    onLeaveContext:
      current === null || current.role === "owner" || data.leaveContext === undefined
        ? undefined
        : () => {
            void data.leaveContext?.(current.id);
            router.replace("/console");
          },
    onSignOut: requestSignOut,
  } as const;

  return (
    <ConsoleDataProvider value={data}>
      <ConsoleNavProvider value={nav}>
      <VoiceHostProvider value={voiceHost}>
      {data.pluginRuntime?.host}
      {/*
        Beside the host and at console scope for the same reason: a plugin can
        ask for its dialog from a command pressed on any pane, so the surface
        that draws it cannot belong to one of them. It renders nothing until a
        plugin actually asks.
      */}
      <PluginSuggestDialog runtime={data.pluginRuntime} />
      <PluginTextDialog runtime={data.pluginRuntime} />
      <PluginSettingsPane runtime={data.pluginRuntime} />
      <AppFrame
        /*
          The switcher is the rail now.

          It was a static chip naming the open context, beside a 216pt column.
          `regionsFor` answers `rail: "hidden"` at every pointer density (see
          `features/app/frame.ts`), so the column is gone and everything it
          offered is under the name you already look at to know whose notes are
          open. `SwitcherMenu` carries `railGroup`'s list unchanged, with the
          same two offers behind the same conditions.

          Each callback keeps the navigation the rail entry had, including
          which of `push` and `replace` it used and why — a claim, a new
          workspace and Meetings all leave the console, so Back has to be the
          way home.
        */
        switcher={<SwitcherMenu {...switcherProps} />}
        /*
          No `switcherLabel`.

          It was the accessible name of the control that pulled the rail in as
          a sheet on a phone, and it had to be a string because a *pressable*
          cannot derive its name from its own content on native. There is no
          such control now: at compact the panels are gone and the chip is a
          label again, which reads its own text. The prop went with the reader.
        */
        /*
          The open notes, in the title bar — see `AppFrame`'s `tabs` prop.

          `browsing && !phone` is exactly the condition `EditorRegion` applied
          when it drew the strip itself: tabs are Browse's, and they are a
          pointer instrument. The emptiness check moved here with them, so a
          route with nothing open passes `undefined` and the frame draws no
          slot rather than an empty one.
        */
        tabs={
          browsing && !phone && tabs.state.tabs.length > 0 ? (
            <TabStrip
              state={tabs.state}
              onActivate={tabs.activate}
              onClose={closeTab}
              onCloseOthers={tabs.closeOthers}
              onCloseToRight={tabs.closeToRight}
              onReopen={tabs.reopen}
            />
          ) : undefined
        }
        topTrailing={consoleTopTrailing({
          phone, readable, shareTarget, reading, setBarDialog, showMeetings, data, insideContext,
          current, router,
        })}
        onSearch={insideContext ? () => setPaletteOpen(true) : undefined}
        syncSlot={consoleSyncSlot({ phone, browsing, data, setSyncOpen })}
        accountSlot={consoleAccountSlot({ data, requestSignOut, router, current })}
        /*
          `browsing`, not `insideContext`.

          Settings is inside a context, so gating on that shipped Browse's
          whole toolbar to a screen with no notes on it: a file tree, a `+`
          that wrote a note you could not see, a Save with nothing to save, and
          a Recent key whose sheet selected notes behind the settings pane.
          Tapping a note in that drawer selected it and closed the drawer with
          no visible change at all.
        */
        aside={consoleAsidePanel({
          data, agentEngine, agentPlace, asked, meetingsAt, newChatAt, router,
        })}
        explorer={consoleExplorer({
          browsing, data, contextLabel, treePick, setTreePick, tabs, setTreeOverlay, current,
          places, router, contextHrefFrom, switcherProps,
        })}
        status={<Status data={data} onOpenSync={browsing ? () => setSyncOpen(true) : undefined} />}
        bottomBar={consoleBottomBar({
          browsing, data, history, somewhereToGo, step, setPaletteOpen, setRecentOpen, canCreate,
          setBarDialog,
        })}
      >
        <Shortcuts
          files={data.files}
          tabs={tabs}
          nav={nav}
          onCloseTab={closeTab}
          onDialog={setBarDialog}
          picked={treePick}
          onPickSpent={() => setTreePick(NO_PICK)}
          onSearch={() => setPaletteOpen(true)}
          paletteOpen={
            paletteOpen ||
            treeOverlay ||
            recentOpen ||
            syncOpen ||
            openSettingsSection !== null ||
            connectAgent !== null
          }
        />
        {/*
          The contexts, built here and drawn inside whatever scroller the
          surface below owns — Browse's on a note or a folder,
          `EditorRegion`'s on Map, Connections and Settings. See `NavBand`.

          `phone` gates it because at every other density the contexts are the
          rail, which is a permanent column there. Building it here rather than
          at the leaf is what keeps one strip in the app: it needs the context
          list, the recently-visited log and the router, and a second copy
          assembled where it is drawn is how one of them ends up with a handler
          the other does not have.
        */}
        <NavBandProvider
          nodes={consoleNavBandNodes({
            phone, current, route, router, data, contextHrefFrom, places,
          })}
        >
          <EditorRegion browse={browsing} failure={data.failure} phone={phone}>
            <Slot />
          </EditorRegion>
        </NavBandProvider>

        {consoleRecentSheet({
          recentOpen, phone, somewhereToGo, history, data, setRecentOpen,
        })}

        {consoleSyncSheet({
          syncOpen, browsing, data, setSyncOpen, closeSync,
        })}

        {consoleSettings({
          openSettingsSection, data, checkoutReturn, router, requestSignOut,
        })}

        {consoleAgentSetup({ connectAgent, data, router })}

        {signOutDialog}

        {consoleCloseTabConfirm({ closingTab, tabs, setClosingTab })}

        {consoleBarDialogs({
          data, barDialog, setBarDialog, startMeeting, startNewChat, resumeRow, current,
          insideContext, router,
        })}

        {/*
          The way back from a move, a rename or an archive.

          Mounted here rather than beside the notice line in `BrowsePane`,
          because the operations that raise it are reachable from the tree, the
          toolbar and the keyboard — and a toast that lives inside the pane
          would be absent on the one layout where the tree is a drawer over it.

          `bottomInset` is left at its default: this renders inside `AppFrame`'s
          editor region, which already ends where the toolbar begins, and the
          toolbar already owns the safe area. See `ToastHost`.
        */}
        <ToastHost
          toasts={data.files.toasts}
          onDismiss={data.files.dismissToast}
        />

        {consoleCreateButton({
          data, phone, startMeetingFlow, resumeRow, setBarDialog, startNewChat,
        })}

        {/*
          The panel, opened by anything above the frame that cannot reach
          `useFrame` — today the note's right-click menu. It renders nothing;
          it exists to be *inside* `AppFrame`, which is where the command is.
        */}
        <OpenAsideOn at={openAsideAt} />

        {consolePhoneChat({
          phoneChatAt, agentEngine, agentPlace, phone, setPhoneChatAt,
        })}

        {consolePalette({
          paletteOpen, setAsked, paletteItems, search, setPaletteOpen, router, data,
        })}
        {/*
          The meeting sheet, rendered once and inside the frame so it sits over
          the console the way every other overlay here does. It is `null` until
          the microphone key is pressed, and it is what opens the microphone —
          not the key.
        */}
        {meetingSheet}
      </AppFrame>
      </VoiceHostProvider>
      </ConsoleNavProvider>
    </ConsoleDataProvider>
  );
}

export { Avatar };

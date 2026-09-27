import {
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useWindowDimensions } from "react-native";
import { ToastHost } from "../design/components/Toast";
import { AppFrame } from "../app/AppFrame";
import { densityFor } from "../app/frame";
import { SwitcherMenu } from "./SwitcherMenu";
import { ConsoleDataProvider } from "./ConsoleDataContext";
import { CustomEmojiProvider } from "./emoji/CustomEmojiProvider";
import { ConsoleNavProvider } from "./ConsoleNavContext";
import { PluginSuggestDialog } from "./plugins/PluginSuggestDialog";
import { PluginTextDialog } from "./plugins/PluginTextDialog";
import { PluginSettingsPane } from "./plugins/PluginSettingsPane";
import { EditorRegion } from "./EditorRegion";
import { type Dialog } from "./files/Explorer";
import { useSignOutFlow } from "./useSignOutFlow";
import { useTabs } from "./files/useTabs";
import { TabStrip } from "./files/TabStrip";
import { hasSomewhereToGo } from "./files/history";
import { NO_PICK, type TreePick } from "./files/selection";
import { useUnsavedGuard } from "./files/useUnsavedGuard";
import { atName } from "./format";
import { NavBandProvider } from "./NavBand";
import { VoiceHostProvider } from "../voice/VoiceHost";
import { hrefFor, sameRoute, type ConsoleRoute, type settingsFromQuery } from "./nav";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
} from "./settings/sections";
import { selectedContext, type ConsoleData, type VisitorActions } from "./types";
import { useReadMode } from "./files/readMode";
import { MEETINGS_ROUTE } from "../meetings/route";
import { WELCOME_ROUTE } from "../onboarding/route";
import { NEW_WORKSPACE_ROUTE } from "../workspace/create";
import { OpenAsideOn } from "./layout/frameBridges";
import { Shortcuts } from "./layout/Shortcuts";
import { Status } from "./layout/chrome";
import type { CheckoutOutcome } from "@context/shared";
import type { SetupAgent } from "../agentSetup/guides";
import type { ConsoleRouter } from "./layout/types";
import { useConsoleHistory } from "./layout/useConsoleHistory";
import { usePaletteSearch } from "./layout/usePaletteSearch";
import { useConsoleCommands } from "./layout/useConsoleCommands";
import { noteTargetsFor } from "./layout/noteTargets";
import { useConsoleAside } from "./layout/useConsoleAside";
import { consoleTopTrailing } from "./layout/topTrailing";
import { NoteActionsSheet } from "./layout/NoteActionsSheet";
import { noteActionItems } from "./layout/noteActions";
import {
  consoleAccountSlot,
  consoleAsidePanel,
  consoleBottomBar,
  consoleExplorer,
  consoleSyncSlot,
} from "./layout/slots";
import { consoleNavBandNodes } from "./layout/navBand";
import {
  consoleCloseTabConfirm,
  consoleRecentSheet,
  consoleAgentSetup,
  consoleSettings,
  consoleSyncSheet,
} from "./layout/sheets";
import { consoleBarDialogs } from "./layout/barDialogs";
import { consoleCreateButton, consolePhoneChat } from "./layout/createButton";
import { consolePalette } from "./layout/palette";
import { OrganizerProvider } from "../organizer/OrganizerContext";
import {
  consoleReviewSheet,
  consoleToasts,
  useConsoleOrganizer,
} from "../organizer/consoleOrganizer";


/**
 * The console's frame, with whatever data it is handed.
 *
 * This was the body of `app/(app)/console/_layout.tsx`, and it is still that
 * route's whole screen: the route file keeps what only a real console URL has
 * (the live Convex data, which context the address names, the quick note) and
 * renders this around its `<Slot/>`.
 *
 * It is its own module so there is one of it. The homepage renders this same
 * frame, tree, tabs, note header, status bar, `+` and account button over the
 * website's notes (`features/home/HomeShell.tsx`), in visitor mode, so a change
 * to the console's shell is a change to the homepage in the same commit. The
 * homepage used to compose `AppFrame` itself, and every piece it did not copy
 * was simply missing there — the account button, the eye, Share, `‹ ›`.
 *
 * `data.visitor` is what differs, and only where an account is the point:
 * Settings, the agent setup, Sign out and the right panel are not drawn, the
 * account button offers Sign in, and Share copies a link. See `VisitorActions`.
 */
export function ConsoleFrame({
  data,
  route,
  pathname,
  router,
  params,
  children,
}: {
  data: ConsoleData;
  /** Which console page this is. The homepage is always a context's Browse. */
  route: ConsoleRoute;
  pathname: string;
  router: ConsoleRouter;
  /** The query the console acts on — `useConsoleParams` on a real route. */
  params: {
    openSettingsSection: ReturnType<typeof settingsFromQuery>;
    checkoutReturn: CheckoutOutcome | null;
    connectAgent: SetupAgent | null;
  };
  /** The pane: the route's `<Slot/>`, or the homepage's `BrowsePane`. */
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const { openSettingsSection, checkoutReturn, connectAgent } = params;
  /*
    Ending the session, asked for from either the rail's account block or the
    settings overlay's Sign out row. One flow, because it decides whether
    unsaved work is about to be discarded and two copies of that decision would
    be two answers to it.
  */
  const { requestSignOut, dialog: signOutDialog } = useSignOutFlow(data);
  const visitor = data.visitor;

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
  const [barDialog, raiseBarDialog] = useState<Dialog>(null);
  /*
    A visitor has no workspace to share from, so Share is the one dialog they
    are never shown: the same press copies the page's public address instead.
    The phone's capsule, the tree's menu and the toolbar all raise it through
    this, so no way to the real dialog is left open.
  */
  const setBarDialog = useVisitorShare(raiseBarDialog, visitor);
  /*
    The tree's ⌘/shift-click pick. Held here rather than in `Explorer` for the
    reason `barDialog` is: `Shortcuts` is a sibling of the tree, and ⌘⇧⌫ has to
    act on the rows the tree draws selected — see `picked` in `rowCommand.ts`.
  */
  const [treePick, setTreePick] = useState<TreePick>(NO_PICK);
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
  const { search, paletteItems, recent } = usePaletteSearch({ data, insideContext, current, paletteOpen, history });
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
  // Auto-organize, for the surfaces that draw it; absent-as-nothing everywhere else.
  const organizer = useConsoleOrganizer(data.organizer, router);

  const { selectedEntry, readable } = noteTargetsFor({ browsing, data });
  const reading = useReadMode();
  /*
    The phone's ••• over the open note or folder: its actions as a bottom
    sheet (`NoteActionsSheet`). Drawn only where there is at least one row
    this person may use — `noteActionItems` decides, so the button and the
    sheet cannot disagree about whether there is anything behind it.
  */
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsEntry =
    phone && browsing && selectedEntry !== null &&
    noteActionItems({
      entry: selectedEntry,
      canEdit: data.files.canEdit,
      canShare: data.files.canShare,
      visitor: visitor !== undefined,
    }).length > 0
      ? selectedEntry
      : null;
  useEffect(() => {
    if (actionsEntry === null) setActionsOpen(false);
  }, [actionsEntry]);

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

    The account button at the foot of the tree opens this menu and so does the
    avatar the status bar carries while the tree is folded away, and they have
    to open the *same* list: every row in it is
    conditional on something — the claim offer, "New workspace", Leave on a
    context you do not own — and a second element built at the other call site is
    how one of those conditions quietly goes missing from one of them. See
    `SwitcherMenu`'s `trigger` prop.
  */
  const switcherProps: ComponentProps<typeof SwitcherMenu> = visitor !== undefined ? {
    data,
    label: contextLabel,
    onOpenContext: () => {},
    onSignIn: visitor.signIn,
    onCreateAccount: visitor.createAccount,
    onOpenApp: visitor.openApp,
  } : {
    data,
    label: insideContext ? contextLabel : "Your context",
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
  };

  return (
    <ConsoleDataProvider value={data}>
      <OrganizerProvider value={organizer}>
      <ConsoleNavProvider value={nav}>
      <VoiceHostProvider value={voiceHost}>
      {/*
        The open workspace's own emoji, at console scope because the editor's
        `:` menu and Settings › Emoji both reach it, and the Add emoji dialog it
        draws can be asked for from either. See `CustomEmojiProvider`.
      */}
      <CustomEmojiProvider
        workspaceId={data.demo ? null : data.files.contextId}
        canEdit={data.files.canEdit}
      >
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
          The account button, when the file tree is not on screen.

          Its home is the foot of the tree (`consoleExplorer`'s `workspaces`
          slot). `AppFrame` draws this one at the leading end of the status
          bar only while the tree is folded away or the route has none, so
          folding the tree never takes the workspaces, Settings and the only
          pointer sign-out with it. Each callback keeps the navigation the
          rail entry had, including which of `push` and `replace` it used — a
          claim, a new workspace and Meetings all leave the console, so Back
          has to be the way home.
        */
        account={<SwitcherMenu {...switcherProps} trigger="avatar" />}
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
              relabel={data.files.titleEdit}
            />
          ) : undefined
        }
        topTrailing={consoleTopTrailing({
          phone, readable, reading, showMeetings, data, insideContext, current, router,
          onOpenActions: actionsEntry === null ? undefined : () => setActionsOpen(true),
        })}
        onSearch={insideContext ? () => setPaletteOpen(true) : undefined}
        /*
          `‹ ›` in the title row over the file tree. They were at the head of
          the note's breadcrumb, which only a note or folder page drew; up
          here they are on every console page, Settings included, which is
          what `history.ts` has always walked.
        */
        history={
          phone
            ? undefined
            : {
                canBack: nav.canBack,
                canForward: nav.canForward,
                onBack: nav.back,
                onForward: nav.forward,
              }
        }
        syncSlot={consoleSyncSlot({ phone, browsing, data, setSyncOpen })}
        accountSlot={
          visitor === undefined
            ? consoleAccountSlot({ data, requestSignOut, router, current })
            : <SwitcherMenu {...switcherProps} trigger="avatar" />
        }
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
          browsing, data, contextLabel, treePick, setTreePick, tabs, setTreeOverlay,
          switcherProps,
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
            actionsOpen ||
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
            {children}
          </EditorRegion>
        </NavBandProvider>

        {consoleRecentSheet({
          recentOpen, phone, somewhereToGo, history, data, setRecentOpen,
        })}

        {consoleSyncSheet({
          syncOpen, browsing, data, setSyncOpen, closeSync,
        })}

        {/* An account's own surfaces, and a visitor has no account. */}
        {visitor === undefined
          ? consoleSettings({ openSettingsSection, data, checkoutReturn, router, requestSignOut })
          : null}

        {visitor === undefined ? consoleAgentSetup({ connectAgent, data, router }) : null}

        {visitor === undefined ? signOutDialog : null}

        {consoleCloseTabConfirm({ closingTab, tabs, setClosingTab })}

        {actionsOpen && actionsEntry !== null ? (
          <NoteActionsSheet
            data={data}
            entry={actionsEntry}
            contextLabel={contextLabel}
            setBarDialog={setBarDialog}
            onDismiss={() => setActionsOpen(false)}
          />
        ) : null}

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
        <ToastHost {...consoleToasts(data.files, organizer)} />

        {consoleReviewSheet({ organizer, phone, browsing })}

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
          paletteOpen, setAsked, paletteItems, recent, search, setPaletteOpen, router, data,
        })}
        {/*
          The meeting sheet, rendered once and inside the frame so it sits over
          the console the way every other overlay here does. It is `null` until
          the microphone key is pressed, and it is what opens the microphone —
          not the key.
        */}
        {meetingSheet}
      </AppFrame>
      </CustomEmojiProvider>
      </VoiceHostProvider>
      </ConsoleNavProvider>
      </OrganizerProvider>
    </ConsoleDataProvider>
  );
}

/** `setBarDialog`, with Share turned into the visitor's copy-a-link. */
function useVisitorShare(
  raise: Dispatch<SetStateAction<Dialog>>,
  visitor: VisitorActions | undefined,
): Dispatch<SetStateAction<Dialog>> {
  const share = visitor?.share;
  return useCallback(
    (next: SetStateAction<Dialog>) => {
      if (share === undefined || typeof next === "function") return raise(next);
      if (next !== null && next.kind === "share") return share(next.path);
      raise(next);
    },
    [raise, share],
  );
}

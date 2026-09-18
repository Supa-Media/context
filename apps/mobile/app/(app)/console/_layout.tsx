import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { checkoutOutcomeFrom } from "@context/shared";
import { SettingsOverlay } from "../../../features/console/settings/SettingsOverlay";
import {
  DEFAULT_ACCOUNT_SETTINGS_SECTION,
  DEFAULT_SETTINGS_SECTION,
} from "../../../features/console/settings/sections";
import { StyleSheet, useWindowDimensions } from "react-native";
import { PressRow } from "../../../features/design/components/Button";
import { Dot } from "../../../features/design/components/Dot";
import { Pill } from "../../../features/design/components/Pill";
import { Palette } from "../../../features/design/components/Palette";
import { StatusBar } from "../../../features/design/components/StatusBar";
import { ToastHost } from "../../../features/design/components/Toast";
import { layout, radii } from "../../../features/design/tokens";
import { useThemedStyles, type Colors } from "../../../features/design/theme";
import { AppFrame, FrameIconButton, useFrame } from "../../../features/app/AppFrame";
import { setReadMode, useReadMode } from "../../../features/console/files/readMode";
import { useOptionalGlobalSearchParams, useOptionalLocalSearchParams } from "../../../features/app/useOptionalLocalSearchParams";
import { densityFor } from "../../../features/app/frame";
import { ConsoleBottomBar } from "../../../features/console/ConsoleBottomBar";
import { SwitcherMenu } from "../../../features/console/SwitcherMenu";
import { AccountBlock, Avatar } from "../../../features/console/AccountBlock";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { PluginSuggestDialog } from "../../../features/console/plugins/PluginSuggestDialog";
import { PluginTextDialog } from "../../../features/console/plugins/PluginTextDialog";
import { PluginSettingsPane } from "../../../features/console/plugins/PluginSettingsPane";
import { EditorRegion } from "../../../features/console/EditorRegion";
import { SaveChip, TierChip } from "../../../features/console/ConsoleShell";
import {
  Explorer,
  ExplorerDialogs,
  type Dialog,
} from "../../../features/console/files/Explorer";
import { inviteHref } from "../../../features/auth/redirect";
import { Confirm } from "../../../features/console/files/Dialogs";
import { useSignOutFlow } from "../../../features/console/useSignOutFlow";
import { itemsFromListings, itemsFromPaths } from "../../../features/console/files/palette";
import { useContextSearch } from "../../../features/console/files/useContextSearch";
import { useDeviceSearch, useMirrorPaths } from "../../../features/offline/useDeviceSearch";
import { useTabs } from "../../../features/console/files/useTabs";
import { readFocus, scopeForFocus } from "../../../features/console/keyboardScope";
import { TabStrip } from "../../../features/console/files/TabStrip";
import { tabAt } from "../../../features/console/files/tabs";
import {
  currentPlace,
  emptyHistory,
  hasSomewhereToGo,
  placeOf,
  recentPaths,
  samePlace,
  stepped,
  visited,
  type HistoryState,
  type Place,
} from "../../../features/console/files/history";
import { entryAt } from "../../../features/console/files/tree";
import {
  applyRowIntent,
  intentForRowCommand,
} from "../../../features/console/files/rowCommand";
import { RecentSheet } from "../../../features/console/files/RecentSheet";
import { saveChip, statusSegments } from "../../../features/console/files/status";
import { withMirrorSegment } from "../../../features/offline/mirrorCopy";
import { SyncPill, SyncSheet } from "../../../features/console/files/SyncSheet";
import { NO_PENDING } from "../../../features/console/files/pendingMarks";
import { closeIntent, isTabDirty } from "../../../features/console/files/tabs";
import { needsDecision } from "../../../features/console/files/editor";
import { useUnsavedGuard } from "../../../features/console/files/useUnsavedGuard";
import { atName } from "../../../features/console/format";
import { ContextStrip, CurrentContextPill } from "../../../features/console/ContextStrip";
import { ContextFootRow } from "../../../features/console/ContextFootRow";
import { NavBandProvider } from "../../../features/console/NavBand";
import { useContextHref, useContextPlaces } from "../../../features/console/useLastPlace";
import { useMeetingFlow } from "../../../features/meetings/useMeetingFlow";
import { VoiceHostProvider, type VoiceHost } from "../../../features/voice/VoiceHost";
import { useAgentEngine } from "../../../features/agent/useAgentEngine";
import {
  currentContextPress,
  hrefFor,
  resolveContextRoute,
  routeForPath,
  sameRoute,
  searchHref,
  settingsHref,
  settingsFromQuery,
  type ConsoleRoute,
} from "../../../features/console/nav";
import { storagePillLabel } from "../../../features/console/storage/pill";
import { describeIndexProgress } from "../../../features/console/search/fastSearch";
import { selectedContext, type ConsoleData } from "../../../features/console/types";
import { useKeymap } from "../../../features/design/useKeymap";
import type { FileBrowser } from "../../../features/console/files/browser";
import {
} from "../../../features/console/files/scope";
import { removalHandler } from "../../../features/console/files/access";
import { audienceContextOf } from "../../../features/console/privacy/audience";
import { capabilitiesForRole } from "../../../features/console/capabilities";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";
import { MEETINGS_ROUTE } from "../../../features/meetings/route";
import { WELCOME_ROUTE } from "../../../features/onboarding/route";
import { NEW_WORKSPACE_ROUTE } from "../../../features/workspace/create";

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
  const quickParams = useOptionalLocalSearchParams<{ quickAction?: string | string[] }>();
  /*
    Settings rides in the query beside `?note=`, so Browse stays mounted under
    the scrim and the note keeps its address. Global rather than local params:
    this layout is above the `[slug]` route that owns them, and reading the
    local ones here returns nothing.
  */
  const settingsParams = useOptionalGlobalSearchParams<{
    settings?: string | string[];
    checkout?: string | string[];
  }>();
  const openSettingsSection = settingsFromQuery(settingsParams.settings);
  /*
    Where Stripe put them. `?checkout=done` says the payment page handed the
    browser back — which is a different fact from "the plan is active", because
    the webhook that decides that may not have landed yet. Read here with every
    other parameter this console acts on, and carried to the one panel that has
    anything to say about the gap. Anything we did not write is nothing.
  */
  const rawCheckout = settingsParams.checkout;
  const checkoutReturn = checkoutOutcomeFrom(
    Array.isArray(rawCheckout) ? rawCheckout[0] : rawCheckout,
  );
  /*
    Ending the session, asked for from either the rail's account block or the
    settings overlay's Sign out row. One flow, because it decides whether
    unsaved work is about to be discarded and two copies of that decision would
    be two answers to it.
  */
  const { requestSignOut, dialog: signOutDialog } = useSignOutFlow(data);
  const handledQuickNote = useRef(false);

  const resolution = resolveContextRoute({
    route,
    contexts: data.contexts,
    selectedContextId: data.selectedContextId,
    loading: data.loading,
    // `undefined` while the query is in flight, which reads as "nobody told
    // me" rather than "there are none" — so a slow list never sends an invited
    // person to the map before their invitation has arrived.
    invitations: data.invitations,
  });
  const cleanQuickNoteHref =
    resolution.action === "redirect" ? resolution.href : pathname;

  const { selectContext } = data;
  useEffect(() => {
    if (resolution.action === "select") selectContext(resolution.contextId);
    if (resolution.action === "redirect") router.replace(resolution.href);
    // `resolution` is derived and stable enough to compare by its parts; the
    // action and its payload are the only things that should retrigger this.
  }, [
    resolution.action,
    resolution.action === "select" ? resolution.contextId : null,
    resolution.action === "redirect" ? resolution.href : null,
    router,
    selectContext,
  ]);

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
  useEffect(() => {
    if (
      quickParams.quickAction !== "note" ||
      handledQuickNote.current ||
      data.loading ||
      !data.files.canEdit
    ) return;
    handledQuickNote.current = true;
    // Remove the command from this history entry before opening the prompt, so
    // a remount or a trip back through history cannot replay it.
    router.replace(cleanQuickNoteHref);
    setBarDialog({ kind: "newNote", folder: "0-inbox" });
  }, [
    data.files.canEdit,
    data.loading,
    cleanQuickNoteHref,
    quickParams.quickAction,
    router,
  ]);
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
  /*
    Where you have been in this context, for the toolbar's `‹` and `›`.

    Recorded from the selection rather than from `select` call sites, because
    the selection moves from the tree, the tab strip, the palette, a search hit
    and a rename, and a history that only knew about some of those would send
    you back somewhere you had not been. Keyed on the context for the reason
    `useTabs` is: a path is relative to a bucket.
  */
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  /*
    THE PLACE A BACK OR FORWARD PRESS IS ON ITS WAY TO, or `null`.

    So the effect below does not record the move as a fresh visit — which would
    truncate the forward tail on the first press of `‹` and make `›` dead.

    **A place rather than the boolean it was**, because a step can now change
    two things. Reaching a note from Map is a `router.replace` *and* a
    `select`, and if those land in two renders the intermediate one is a real
    `here` — the old path under the new route — which a one-shot boolean
    spends itself on, leaving the arrival to be recorded as a fresh visit and
    the forward tail truncated by the very press that was meant to walk it.
    Holding the destination instead means every state between the press and
    the arrival is skipped, however many there are, and the flag clears on the
    place it was waiting for rather than on the next render to come along.
  */
  const navigatingTo = useRef<Place | null>(null);
  const selectedPath = data.files.selectedPath;

  useEffect(() => {
    setHistory(emptyHistory);
  }, [data.selectedContextId]);

  /** The context a path place belongs to, for a step that has left it. */
  const contextSlug = selectedContext(data)?.slug ?? null;
  /*
    WHERE YOU ARE, AS ONE PLACE, WHATEVER KIND OF PAGE IT IS.

    This effect watched `selectedPath` alone, so Settings, Search, Map and
    Connections were not somewhere you had been — they were nothing at all, and
    `‹` walked past them to the note underneath. That was the reported defect:
    open Settings, open a note from it, press back, and you land on the
    previous *note*.

    The console already knows which page it is on — the URL says so — so this
    derives the place from the same three things the render does, in the order
    the screen stacks them: the settings overlay is on top of everything when
    it is open, an app pane is not inside a context at all, and otherwise you
    are on the selected path. One expression, so the list cannot disagree with
    what is drawn.
  */
  const here = useMemo<Place | null>(
    () =>
      placeOf({
        settingsSection: openSettingsSection,
        routeKind: route.kind,
        appSection: route.kind === "app" ? route.section : null,
        selectedPath,
      }),
    [openSettingsSection, route, selectedPath],
  );

  useEffect(() => {
    if (here === null) return;
    if (navigatingTo.current !== null) {
      if (samePlace(navigatingTo.current, here)) navigatingTo.current = null;
      return;
    }
    setHistory((current) => visited(current, here));
  }, [here]);

  const step = useCallback(
    (delta: -1 | 1) => {
      setHistory((state) => {
        const next = stepped(state, delta);
        const place = currentPlace(next);
        if (next === state || place === null) return state;
        navigatingTo.current = place;

        /*
          Applying a place is the mirror of deriving one, and each kind has to
          undo the others: arriving at a note with the settings overlay still
          up would draw the note behind a panel nobody asked to keep, and
          arriving at a settings section from Map has to be back inside the
          context first.
        */
        if (place.kind === "settings") {
          router.setParams({ settings: place.section });
          return next;
        }

        if (place.kind === "app") {
          router.setParams({ settings: undefined });
          router.replace(hrefFor({ kind: "app", section: place.section }));
          return next;
        }

        if (openSettingsSection !== null) router.setParams({ settings: undefined });
        /*
          Back into the context first, when the step is leaving an app pane:
          Map is not inside one, and selecting a path while the route still
          says `app` moves the selection under a screen that is not showing it.

          `hrefFor` rather than `contextHrefFrom`, and for two reasons. It is
          pure, so it is not a dependency declared 140 lines below this — and
          `contextHrefFrom` resolves a context to the *last place you were in
          it*, which is the opposite of what a back step wants: the place is
          already decided, and `select` below is what applies it.
        */
        if (route.kind !== "context" && contextSlug !== null) {
          router.replace(hrefFor({ kind: "context", slug: contextSlug, view: "browse" }));
        }
        // The guard can still refuse — an unsaved draft. Then the selection
        // does not move, and neither should the cursor.
        if (!data.files.select(place.path)) {
          navigatingTo.current = null;
          return state;
        }
        return next;
      });
    },
    [contextSlug, data.files, openSettingsSection, route, router],
  );
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
  /*
    Whole-context search, behind the same palette that filters what is loaded.
    `null` while no context is selected — an all-contexts route has no single
    bucket to ask, so the palette falls back to filtering listings, which is
    what it did everywhere before this.
  */
  /*
    …and the same search over the copy of this context on the device, which
    answers when the device is offline or the bucket does not — see
    `useContextSearch` for when, and `mirrorSearch.ts` for what it reads.
  */
  const deviceSearch = useDeviceSearch(insideContext ? (current?.id ?? null) : null, current?.role);
  const reachability = data.files.sync?.reachability ?? "unknown";
  const mirrorStatus = data.files.sync?.mirror;
  const device = useMemo(
    () =>
      deviceSearch === null
        ? null
        : { reachability, status: mirrorStatus, search: deviceSearch },
    [deviceSearch, reachability, mirrorStatus],
  );
  const search = useContextSearch(insideContext ? data.files.search : null, device);
  /*
    Quick open by name, offline, over every note the mirror holds rather than
    only the folders that had been expanded before the signal went.
  */
  const mirrorPaths = useMirrorPaths(
    insideContext ? (current?.id ?? null) : null,
    current?.role,
    paletteOpen && reachability === "offline",
  );
  const listings = data.files.listings;
  const paletteItems = useMemo(
    () => (paletteOpen ? itemsFromPaths(mirrorPaths, itemsFromListings(listings)) : []),
    [paletteOpen, mirrorPaths, listings],
  );
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

  /**
   * Close a tab: write what is pending, and ask only about what cannot be.
   *
   * The clean tabs — nearly all of them — still close on one press. A confirm
   * on every close would train people to dismiss it, which is how the one that
   * mattered gets dismissed too, and closing a tab with an ordinary draft in it
   * used to raise exactly that: a question whose honest answer was always
   * "yes, obviously save it".
   *
   * So the ordinary draft is flushed instead — by path, because the tab being
   * closed is not always the note in the editor, and closing tab B must not
   * spend a write on tab A's draft before its own timer is due. What is left is
   * `needsDecision`: a conflict, and a save that failed. Both are about the
   * note in the editor, which is the only note the console holds a draft for.
   */
  const closeTab = useCallback(
    (path: string) => {
      const editor = data.files.editor;
      const intent = closeIntent({
        dirty: isTabDirty(tabs.state, path),
        open: editor.path === path,
        undecided: needsDecision(editor),
      });
      if (intent === "confirm") return setClosingTab(path);
      // By path: closing tab B must not spend a write on tab A's draft before
      // its own timer is due. A `close` intent has nothing pending anyway.
      if (intent === "flush") data.files.flushAutosave(path);
      tabs.close(path);
    },
    [data.files, tabs],
  );

  const contextLabel = atName(current?.slug ?? "your context");

  /**
   * The note the top bar's Share acts on, or `null`.
   *
   * The one control that had to find a new home when the breadcrumb row went.
   * `BrowsePane` puts Share beside the note's name on a pointer layout, and the
   * name is inside the document now — so on a phone it moves into the top bar's
   * trailing group, which is what Obsidian's ⋯ container is for.
   *
   * The same three conditions the pane applied, because they are the server's:
   * `canShare` is `canEdit && isOwner`, `privacy.md` is read-only, and a folder
   * has its own team-link offer in `FolderView` rather than this one.
   */
  const selectedEntry =
    data.files.selectedPath === null
      ? null
      : entryAt(data.files.listings, data.files.selectedPath, data.files.editor);
  /**
   * **A folder is a share target too, and it used to draw its own button.**
   *
   * `FolderView` had a text "Share…" pill in its heading and a full-width
   * "Make this folder private" beneath it, so a folder and a note offered the
   * same two capabilities through two different sets of controls in two
   * different places — the folder's being the pair that filled the top third
   * of a phone screen. They are one pair now, in the group Obsidian's ⋯
   * container is for, and `FolderView` draws neither.
   *
   * What is shared differs and that is the dialog's business, not this
   * button's: `ShareDialog` offers a person a note and offers a *team link*
   * for a folder, because `createShare` has no folder form — see
   * `SHARE_TRAVERSAL_DEPTH` in `functions/shares.ts` and the rule `menu.ts`
   * states for the row menu.
   */
  const shareTarget =
    browsing && data.files.canShare && selectedEntry !== null && !selectedEntry.readOnly
      ? selectedEntry.path
      : null;

  /**
   * Whether the eye is offered, which is a wider question than Share's.
   *
   * Any open **note** can be read, including the ones `shareTarget` refuses:
   * `privacy.md` and an encrypted envelope are exactly the notes somebody is
   * reading rather than editing, and both are already `readOnly`, so the mode
   * costs them nothing and the markup goes quiet for them too. A folder has no
   * document to put into reading mode and gets no eye.
   */
  const readable = browsing && selectedEntry !== null && selectedEntry.kind === "file";
  const reading = useReadMode();

  const places = useContextPlaces();
  const contextHrefFrom = useContextHref(data.contexts);
  const { startMeetingFlow, sheet: meetingSheet } = useMeetingFlow({
    contexts: data.contexts,
    page: insideContext && current
      ? {
          contextSlug: current.slug,
          // The note when one is open, else the folder standing in for it —
          // the same `targetFolder` rule the `+` key uses, so "this page" and
          // "new note here" can never mean two different folders.
          path: data.files.selectedPath ?? "",
          isNote: selectedEntry?.kind === "file",
        }
      : null,
    onClaimName: data.demo ? undefined : () => router.push(WELCOME_ROUTE),
  });

  /**
   * What the microphone over the note needs, which is only what this layout
   * already knows.
   *
   * `context` is the whole `ConsoleContext` rather than its slug: the dictation
   * sheet has to say who can read the open note before the microphone opens,
   * and that is a question about `kind` and `role` — see
   * `features/voice/audience.ts` for why an unrecognised `kind` is never
   * answered "only you".
   *
   * `writable` is the entry's own answer, not the membership's. `privacy.md`
   * and an encrypted envelope are read-only inside a context you own outright,
   * and `NoteEditor` narrows this again with its own `editable` — reading mode
   * and a conflict both close the note to typing without changing either of
   * these.
   */
  /*
    The agent's own engine, built here and not in the editor.

    It mints this app's gateway grant on demand — an ordinary, revocable OAuth
    grant clamped to this person's role — and holds it in memory for the hour
    it lives. `features/agent/useAgentEngine.ts` has the argument for why it is
    never written to the device.
  */
  const agentEngine = useAgentEngine({
    workspaceId: data.selectedContextId,
    endpoint: data.endpoint,
  });

  const voiceHost = useMemo<VoiceHost>(
    () => ({
      page: {
        context: insideContext ? current : null,
        notePath: selectedEntry?.kind === "file" ? selectedEntry.path : null,
        writable: selectedEntry !== null && !selectedEntry.readOnly,
        /*
          The entry's own answer to who can read it, which is the question the
          sheet asks and the one `kind` cannot answer: a personal workspace
          takes members, so `team` on a note inside one means real people. Left
          absent when a folder is on screen, and `audience.ts` treats absent as
          "not established" rather than as private.
        */
        noteVisibility: selectedEntry?.kind === "file" ? selectedEntry.visibility : undefined,
      },
      onRecordMeeting: startMeetingFlow,
      /*
        The one place holding both halves the engine needs: the workspace the
        grant is minted for, and the endpoint its `/agent` route is derived
        from. `NoteEditor` has never seen either, and the surfaces that render
        `BrowsePane` without this provider get the stub instead.
      */
      agent: agentEngine,
    }),
    [insideContext, current, selectedEntry, startMeetingFlow, agentEngine],
  );

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
        /*
          Absent on a phone, where both chips have moved to the foot of the
          context's own page — `features/console/files/contextFoot.ts` composes
          the line and `FolderView` draws it.

          (This used to cite `ContextFoot` and `Explorer`'s `vault` slot. There
          is no such component — the module is `files/contextFoot.ts` — and the
          `vault` slot went with the phone's file tree, so the citation pointed
          at one name that never existed and one that no longer does.)

          They are facts *about the context you are in*: which bucket it is
          bound to, and what you are allowed to see in it. Under the context's
          own heading, at the foot of the page that lists it, they read as a
          caption. Floating over the note in the top-right corner of a 390pt
          screen they read as chrome about the note, which is what they were
          being mistaken for — and getting them there cost a bordered pill
          wrapping two bordered pills.

          The pointer layout keeps them in the bar. It has the width, the bar
          has a surface of its own to sit them on, and the tree's foot there is
          a 26pt strip at the bottom of a 260pt column rather than a page's.
        */
        topTrailing={
          phone ? (
            /*
              Obsidian's trailing group, holding the one action the note has
              that is not on the bottom toolbar.

              `AppFrame` draws the capsule; this passes what goes in it. Absent
              rather than dimmed when there is nothing to share — `menu.ts`
              states the rule for exactly this case, and an empty capsule
              floating over a note is chrome about nothing.

              It raises the dialog through `barDialog`, which `ExplorerDialogs`
              already renders below with its own `canShare` re-check. A second
              `ShareDialog` mounted here would be a second contract for one
              offer.
            */
            /*
              One control, not two.

              This group used to carry a padlock beside the share icon. They
              were two controls for one question — and worse, they overlapped
              on the dangerous state: the padlock cycled private → team →
              *link anyone can open*, minting exactly the share row the sheet's
              own "Create link" minted. Most notes sit at `team` already by
              folder inheritance, so a note was one tap on an unlabelled 20pt
              icon away from a link that needs no account.

              Audience lives inside the sheet now, as named positions with the
              public step confirmed in words — `ShareDialog`'s `onSetScope`
              carries the full argument. `scope.ts` is untouched: it is still
              the pure model of what the positions are and how to move between
              them, and `setScope` is still the single point every surface goes
              through. Only the control that drove it changed.
            */
            !readable && shareTarget === null ? undefined : (
              <>
                {/*
                  Reading mode, leading the group.

                  Before Share rather than after it, because the two are not
                  peers: this changes how the note in front of you is drawn and
                  is undone by pressing it again, and Share opens a sheet that
                  grants somebody access. The reversible one is the safer
                  neighbour for a thumb, and the group is read left to right.

                  **The glyph is the act, and there is no `selected` fill.**
                  This used to be one eye lit by `selected`, on the argument
                  that one mark cannot draw "will hide the markup" and "will
                  bring it back" — so the state went in the fill and the label
                  carried the act. Two marks can draw it, and once they do the
                  fill is not merely redundant but wrong: it would light the
                  *pencil*, and a lit control says "this mode is on" while the
                  pencil means "press to start editing". Icon and label now say
                  the same thing, which is what an unlabelled 20pt target needs.
                */}
                {readable ? (
                  <FrameIconButton
                    label={reading ? "Edit this note" : "Read this note"}
                    icon={reading ? "pencil" : "eye"}
                    grouped
                    onPress={() => setReadMode(!reading)}
                    testID="note-read"
                  />
                ) : null}
                {shareTarget === null ? null : (
                  <FrameIconButton
                    label="Share this"
                    icon="share"
                    grouped
                    onPress={() => setBarDialog({ kind: "share", path: shareTarget })}
                    testID="note-share"
                  />
                )}
              </>
            )
          ) : (
            <>
              {/*
                Whether the last keystroke is in the bucket, leading the group —
                see `SaveChip` for why this is a chip here rather than a Save
                button over the note. Not gated on `insideContext` either: it is
                a claim about the note that is open, and a note stays open
                behind Map, Connections and the settings overlay.
              */}
              <SaveChip editor={data.files.editor} />
              {/*
                Gated on `insideContext`, and the two chips beside it are not.
                That is deliberate rather than an oversight to tidy: a bucket is
                one fact about the selected context, but a tier is a claim about
                what *you* can see, and on an all-contexts route you may be
                looking at three contexts you hold three different roles in. One
                chip cannot speak for them, and the wrong direction for it to be
                wrong in is "you are seeing everything".
              */}
              {insideContext ? <TierChip role={current?.role} /> : null}
              <StorageChip
                data={data}
                onOpenSettings={
                  current === null
                    ? undefined
                    : /*
                        `setParams` inside a context, a push out of one.

                        Both open the overlay now — it draws on every console
                        route — but only a context route carries the note in
                        its URL, and `setParams` is what keeps it there while
                        settings is over the top of it. From Map or Connections
                        there is no note to keep, and the push names the
                        context whose binding this chip is stating.
                      */
                      insideContext
                      ? () => router.setParams({ settings: DEFAULT_SETTINGS_SECTION })
                      : () => router.push(settingsHref(current.slug))
                }
              />
            </>
          )
        }
        onSearch={insideContext ? () => setPaletteOpen(true) : undefined}
        /*
          The phone's half of the status strip — Offline, the queue, and the
          open note's own `Queued` / `Cached copy` — as a pill in the header
          that opens a sheet naming the notes. `SyncPill` renders nothing when
          there is nothing to say, which is almost always.

          `browsing`, as the Recent sheet is: the sheet's rows open notes, and
          Browse is where a note is opened. `AppFrame` refuses the slot at a
          pointer density on its own, where the strip and `SaveChip` say it.
        */
        syncSlot={
          phone && browsing ? (
            <SyncPill
              sync={data.files.sync}
              save={saveChip({ editor: data.files.editor, now: Date.now() })}
              onPress={() => setSyncOpen(true)}
            />
          ) : undefined
        }
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
        accountSlot={
          <Account
            data={data}
            compact
            touch
            onSignOut={requestSignOut}
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
        explorer={
          browsing ? (
            <Explorer
              files={data.files}
              contextLabel={contextLabel}
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
        }
        status={<Status data={data} onOpenSync={browsing ? () => setSyncOpen(true) : undefined} />}
        bottomBar={
          browsing ? (
            <ConsoleBottomBar
              data={data}
              history={history}
              hasRecent={somewhereToGo}
              onStep={step}
              onSearch={() => setPaletteOpen(true)}
              onOpenRecent={() => setRecentOpen(true)}
              onNewNote={(folder) => setBarDialog({ kind: "create", folder })}
              onStartMeeting={startMeetingFlow}
            />
          ) : undefined
        }
      >
        <Shortcuts
          files={data.files}
          tabs={tabs}
          onCloseTab={closeTab}
          onDialog={setBarDialog}
          onSearch={() => setPaletteOpen(true)}
          paletteOpen={
            paletteOpen || treeOverlay || recentOpen || syncOpen || openSettingsSection !== null
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
          nodes={{
            /*
              The context you are IN, at the head of the breadcrumb — the way up
              to its root, and the long-press route to its settings. Absent
              outside a context (the app-level panes), where there is no root to
              open and nothing to name.
            */
            current:
              phone && current !== null ? (
                <CurrentContextPill
                  context={current}
                  /*
                    `deselect()`, not `router.replace(browseHref(slug))`. That
                    was the shipped fix's own words for "open the root", and it
                    is exactly right about *where* the root is and exactly
                    wrong about how to get there while already standing in it:
                    `router.replace` is a `REPLACE` action, `StackRouter`
                    mints a fresh route key for every one regardless of
                    whether the params actually changed, and a fresh key
                    remounts `ContextBrowseRoute` — while `ConsoleDataProvider`
                    and `FileBrowser` stay mounted here in `_layout` and do
                    not. `useNoteAddress`'s `seen` ref lives on the remounted
                    side, so it resets to `null` on every press, and the note
                    it should have closed comes right back — see
                    `docs/decisions/app-and-console.md`, "the first fix did
                    not hold".

                    There is nothing to navigate *to*: deselecting is the
                    entire effect a round trip to the same route with no
                    `?note=` was standing in for. `useNoteAddress` sees the
                    selection change under an unchanged URL and mirrors it —
                    the same "address" step a tapped-closed tab already takes
                    — so the URL still ends up at the bare context, one commit
                    later, with no remount and no `seen` reset anywhere. It
                    also covers standing in a top-level *folder*:
                    `selectedPath` names the folder, and `deselect` clears
                    that exactly as it clears a note. `E2EFixtureScreen.tsx`
                    already does this for the same reason — it is what the
                    navigation *does* to this browser's state, and there is no
                    router in that fixture to stand in for it.
                  */
                  onOpenRoot={() => {
                    /*
                      **And on an app-level pane it is a navigation after all.**

                      Everything above is about pressing this while standing
                      *in* the context: there is nowhere to go, and deselecting
                      is the whole of the effect. On Search, Map or Connections
                      there is somewhere to go and deselecting did nothing you
                      could see — which, on a phone, left those three panes with
                      no way out at all: `regionsFor` draws no rail there and the
                      console passes no bottom toolbar off Browse, so the strip
                      is the only navigation on the glass and its own pill was
                      the one dead pill in it.

                      `replace`, and through the remembered place, so leaving a
                      pane puts somebody back on the note they had open rather
                      than at the root of a context they never left.
                    */
                    if (currentContextPress(route) === "navigate") {
                      router.replace(contextHrefFrom(current.slug));
                      return;
                    }
                    data.files.deselect();
                  }}
                  onSelect={(next) => {
                    if (!sameRoute(next, route)) router.replace(hrefFor(next));
                  }}
                  onLeaveContext={(id) => {
                    void data.leaveContext?.(id);
                    router.replace("/console");
                  }}
                />
              ) : null,
            contexts: phone ? (
              <ContextStrip
                contexts={data.contexts}
                currentSlug={current?.slug ?? null}
                recent={places}
                loading={data.loading}
                /*
                  Resolved at press time, never when the strip rendered: the
                  log moves on every navigation, so an href worked out at
                  render is the answer to where somebody was two contexts ago.

                  This is what keeps a switch on the path you had open there
                  rather than dropping you at the root. `contextHrefFrom` falls
                  back to the root on its own when nothing is remembered, when
                  the slug is no longer reachable, or when the path does not
                  resolve.

                  Every pill here is a context you are **not** in — the current
                  one is `CurrentContextPill` above — so there is no case where
                  this resolves to where somebody already is.
                */
                onOpen={(slug) => router.replace(contextHrefFrom(slug))}
                onSelect={(next) => {
                  /*
                    Settings on the context you are already in is a parameter,
                    not a navigation: `hrefFor` emits the legacy path for a
                    settings route, and replacing with it drops the `?note=`
                    beside it — closing somebody's note as a side effect of
                    opening settings, which is the whole defect the overlay
                    exists to fix.
                  */
                  if (
                    next.kind === "context" &&
                    next.view === "settings" &&
                    route.kind === "context" &&
                    next.slug === route.slug
                  ) {
                    router.setParams({ settings: DEFAULT_SETTINGS_SECTION });
                    return;
                  }
                  if (!sameRoute(next, route)) router.replace(hrefFor(next));
                }}
                onLeaveContext={(id) => {
                  void data.leaveContext?.(id);
                  router.replace("/console");
                }}
                onClaimContext={data.demo ? undefined : () => router.push(WELCOME_ROUTE)}
                onCreateWorkspace={
                  data.demo ? undefined : () => router.push(NEW_WORKSPACE_ROUTE)
                }
              />
            ) : null,
          }}
        >
          <EditorRegion browse={browsing} failure={data.failure} phone={phone}>
            <Slot />
          </EditorRegion>
        </NavBandProvider>

        {/*
          The Recent sheet, mounted only where there is a control that opens it.
          It closes itself when the list empties (see its effect), and the guard
          on `somewhereToGo` is what stops it re-opening onto a single row
          pointing at the note already on screen — a context switch clears the
          history from under it, and this component sits above the route that
          does that.

          `select` rather than `router`: the note is a selection this browser
          holds, the URL follows it through `useNoteAddress`, and asking the
          router to navigate instead remounts the route under the press. See
          `docs/decisions/app-and-console.md` on the breadcrumb root, which is
          the same press taking the same shortcut for the same reason.
        */}
        {recentOpen && phone && somewhereToGo ? (
          <RecentSheet
            paths={recentPaths(history)}
            currentPath={data.files.selectedPath}
            pendingStateFor={data.files.pending?.stateFor}
            onOpen={(path) => {
              data.files.select(path);
              setRecentOpen(false);
            }}
            onDismiss={() => setRecentOpen(false)}
          />
        ) : null}

        {/*
          The phone's sync sheet. `select` for the reason the Recent sheet
          above uses it — and opening a note is the whole answer the sheet
          offers: a waiting write is checked by looking at it, and a parked one
          is restored as a conflict the moment its note opens (`open` in
          `useFileBrowser`), which is where its three answers are.
        */}
        {/*
          Every layout, not only the phone's: on a pointer layout the strip's
          sync segments open it (`Status`), because a parked rename or delete
          is answered on this sheet's rows and nowhere else — marked and
          counted but unanswerable is a change stranded with no way to act on
          it.
        */}
        {syncOpen && browsing ? (
          <SyncSheet
            sync={data.files.sync}
            save={saveChip({ editor: data.files.editor, now: Date.now() })}
            pending={data.files.pending ?? NO_PENDING}
            onOpen={(path) => {
              data.files.select(path);
              setSyncOpen(false);
            }}
            onAnswer={data.files.answerOp}
            onDismiss={closeSync}
          />
        ) : null}

        {/*
          Settings, over whatever is behind it rather than instead of it.
          Closing drops one query parameter, which is why there is no
          reconstruction of where somebody came from here: the note they had
          open is still in the URL and still on screen.
        */}
        {/*
          Drawn on every console route, not only a context's. The account
          sections are about the person and reachable from anywhere, and the
          list itself now switches contexts — so gating this on `route.kind`
          left `?settings=apps` on `/console/map` as a URL that changed nothing
          and drew nothing, and left the gear absent on exactly the routes with
          no other way in.
        */}
        {openSettingsSection === null ? null : (
          <SettingsOverlay
            data={data}
            section={openSettingsSection}
            /*
              What Stripe's return URL said, read here because this is where
              every other query parameter this console acts on is read. It is a
              different fact from "the plan is active" — the webhook that
              decides that may not have landed yet — and Premium is the only
              panel that has anything to say about the gap.
            */
            returned={checkoutReturn}
            onSelect={(next) => router.setParams({ settings: next })}
            /*
              A context switch inside settings is a navigation, because the
              context a console is showing is a route rather than component
              state — the same `settingsHref` the storage chip pushes, carrying
              the open section so switching does not also change the subject.
            */
            onSwitchContext={(slug) => router.push(settingsHref(slug, openSettingsSection))}
            onSignOut={requestSignOut}
            onOpenInvitation={(token) => router.push(inviteHref(token))}
            onDismiss={() => router.setParams({ settings: undefined })}
          />
        )}

        {signOutDialog}

        {closingTab === null ? null : (
          <Confirm
            title="Close without settling this?"
            body={`${closingTab} has changes your bucket has not accepted — somebody else wrote it while you had it open, or the save failed. Autosave will not decide that for you, and closing this tab leaves it undecided. What you typed is not in your bucket.`}
            confirmLabel="Close anyway"
            onCancel={() => setClosingTab(null)}
            onConfirm={() => {
              tabs.close(closingTab);
              setClosingTab(null);
            }}
          />
        )}

        {/* The toolbar's `+`. `Explorer` renders its own copy for the tree's. */}
        <ExplorerDialogs
          files={data.files}
          dialog={barDialog}
          onClose={() => setBarDialog(null)}
          /*
            The share dialog raised from the toolbar is the one a phone
            reaches, and it was drawing without the people or the groups —
            which is how it came to be three paragraphs and a keyboard. Read
            off the console's own single subscriptions; `groups.actions` is
            absent for anybody who is not an owner, so the field offers no
            group rows rather than a pick the server would refuse.
          */
          access={{
            members: data.members?.members ?? [],
            groups:
              data.groups?.actions === undefined
                ? undefined
                : data.groups.groups.map((group) => ({
                    name: group.name,
                    label: group.label,
                    liveCount: group.members.filter((member) => member.live).length,
                  })),
            onShareWithGroup:
              data.groups?.actions === undefined
                ? undefined
                : (path, kind, group) => data.files.shareWithGroup(path, kind, group),
            /*
              The same three halves the pane passes, each present only where
              this caller holds it. Built per path rather than once, because
              narrowing a note names the note — see `removalHandler`.
            */
            groupSlug: current?.slug,
            /*
              Named audiences, from the one derivation every surface uses. The
              share sheet says "Everyone in @supa" rather than "Workspace",
              which is a set the reader can check. See `privacy/audience.ts`.
            */
            audience: audienceContextOf(
              current?.slug,
              current?.kind,
              capabilitiesForRole(current?.role).isOwner,
            ),
            onCreateGroup:
              data.groups?.actions === undefined
                ? undefined
                : (path, kind, label, userIds) =>
                    data
                      .groups!.actions!.createWith(label, userIds)
                      .then((name) => data.files.shareWithGroup(path, kind, name)),
            removalRouteFor: (path, kind) =>
              removalHandler({
                path,
                kind,
                setPrivate: (target, targetKind) =>
                  data.files.setVisibility(target, targetKind, "private"),
                removeMember: data.members?.actions?.remove,
                openGroups:
                  data.groups?.actions === undefined || !insideContext
                    ? undefined
                    : () => {
                        setBarDialog(null);
                        router.setParams({ settings: "groups" });
                      },
              }),
          }}
        />

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

        {paletteOpen ? (
          <Palette
            items={paletteItems}
            placeholder="Search this context"
            /*
              Reached only when the whole-context search is idle too — under
              `MIN_QUERY`, or with no context selected. Once it has run, the
              palette's own states say what happened, and none of them is this.
            */
            noMatchMessage={
              "Nothing loaded matches that. Keep typing to search the rest of this context."
            }
            search={search}
            /*
              The handoff to the dedicated search page.

              The overlay stays what it is — ten rows, no scrolling, gone on
              the first press — and stops pretending to be the whole answer.
              Somebody who is looking *up* a note is already done; somebody who
              is reading *around* a subject presses this and gets a page with
              scrolling, a scope they can change, and a URL that survives
              opening a result and coming back.

              The scope is deliberately not carried over. The palette searched
              the context you are standing in; the page defaults to every
              context you can reach, which is the question the page exists for.
              Narrowing it back to one is a chip away and is in the URL when you
              do it.
            */
            onSeeAll={(query) => {
              setPaletteOpen(false);
              router.push(searchHref(query));
            }}
            onChoose={(item) => {
              setPaletteOpen(false);
              data.files.select(item.id);
            }}
            onDismiss={() => setPaletteOpen(false)}
          />
        ) : null}
        {/*
          The meeting sheet, rendered once and inside the frame so it sits over
          the console the way every other overlay here does. It is `null` until
          the microphone key is pressed, and it is what opens the microphone —
          not the key.
        */}
        {meetingSheet}
      </AppFrame>
      </VoiceHostProvider>
    </ConsoleDataProvider>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The keyboard.
 *
 * One listener for the whole console, with the scope resolved **at the moment
 * a key arrives** rather than at render — see `keyboardScope.ts` for why a
 * `focusedRegion` state cannot work here.
 *
 * ## Every chord the menu prints, this answers
 *
 * That is the contract, and it was broken before this: the tree and editor
 * scopes were never passed, so thirty-three of the thirty-seven commands
 * resolved to nothing while the context menu cheerfully printed `F2`, `⌘D`,
 * `⌘⇧M`, `⌘C`, `⌘X`, `⌘⌫` and `⌘⇧⌫` beside its rows — and **⌘S did not save.**
 * `menu.ts`'s doc argues that routing shortcuts through `describeBinding` means
 * a printed chord is a real one; that guarantees the chord is in the table, not
 * that anything is listening. This is the listener.
 *
 * A command that lands somewhere with nothing to do returns `false`, which
 * leaves the browser's own behaviour alone — that is why `preventDefault` is
 * conditional on a `true` in the first place.
 */
function Shortcuts({
  files,
  tabs,
  onCloseTab,
  onDialog,
  onSearch,
  paletteOpen,
}: {
  files: FileBrowser;
  tabs: ReturnType<typeof useTabs>;
  /** ⌘W. Asks before discarding a draft, exactly as the × does. */
  onCloseTab: (path: string) => void;
  /** Raise one of the tree's dialogs — the same set the toolbar's `+` uses. */
  onDialog: (dialog: Dialog) => void;
  onSearch: () => void;
  paletteOpen: boolean;
}) {
  const frame = useFrame();

  useKeymap({
    scope: useCallback(() => scopeForFocus(readFocus(paletteOpen)), [paletteOpen]),
    onCommand: useCallback(
      (command) => {
        switch (command) {
          /* ---- frame ---------------------------------------------------- */
          case "palette":
          case "quickSwitcher":
            onSearch();
            return true;
          case "toggleExplorer":
            frame.toggleExplorer();
            return true;
          case "toggleFocus":
            frame.toggleFocus();
            return true;
          case "dismiss":
            // `keymap.ts` says Escape "closes whatever is open, wherever you
            // are", and until this the console answered for nothing but the
            // palette — so the one panel that is the only way off a pane could
            // be dismissed by a press or a scrim and not by the key everybody
            // tries. Returns whether there was anything to close, so an Escape
            // with no panel up still reaches the browser.
            return frame.closeOverlays();

          /* ---- the note ------------------------------------------------- */
          case "save":
            /*
              The one people try first, and it still works with autosave on:
              every editor lets somebody save *now* rather than in two seconds,
              and the press is the same conditional write the timer would have
              made.

              `error` as well as `dirty`, which it was not before. That is the
              state autosave deliberately does not retry from, so the keyboard
              has to be able to reach it — the same reason `saveButton` keeps
              the button pressable there. `conflict` is left out: a plain save
              would be checked against an etag somebody else has moved past and
              come straight back as the same refusal, and the answer to it is
              the resolver's three choices.
            */
            if (!files.canEdit) return false;
            if (files.editor.status !== "dirty" && files.editor.status !== "error") return false;
            files.save();
            return true;

          /* ---- tabs ----------------------------------------------------- */
          case "closeTab":
            if (tabs.state.activePath === null) return false;
            onCloseTab(tabs.state.activePath);
            return true;
          case "reopenTab":
            if (tabs.state.closed.length === 0) return false;
            tabs.reopen();
            return true;
          case "nextTab":
          case "prevTab": {
            const { tabs: open, activePath } = tabs.state;
            if (open.length < 2 || activePath === null) return false;
            const index = open.findIndex((tab) => tab.path === activePath);
            const step = command === "nextTab" ? 1 : -1;
            // Wraps, because a strip you can only walk to the end of makes you
            // reverse direction to reach the tab one place behind you.
            const next = open[(index + step + open.length) % open.length];
            tabs.activate(next.path);
            return true;
          }

          /* ---- the tree ------------------------------------------------- */
          case "newNote":
          case "newFolder":
          case "rename":
          case "duplicate":
          case "moveTo":
          case "copy":
          case "cut":
          case "paste":
          case "archive":
          case "deleteForever": {
            /*
              These used to return `false` under a comment saying "`Explorer`
              binds them itself". It binds no key at all — it has no keyboard
              handler of any kind — so every chord the row menu prints beside
              these ten was dead: `F2`, `⌘D`, `⌘⇧M`, `⌘C`, `⌘X`, `⌘V`, `⌘⌫`,
              `⌘⇧⌫`. `menu.ts` argues that routing a printed chord through
              `describeBinding` means it is a real one; that proves the chord is
              in the table, not that anything is listening. This is what listens.

              The dialog state is here rather than duplicated — the toolbar's
              `+` already raises `ExplorerDialogs` from this component, which is
              why `ExplorerDialogs` was split out of `Explorer` in the first
              place.

              A keystroke acts on the *selection*; the menu acts on the row
              under the pointer. `rowCommand.ts` owns what they must agree
              about, and answers `null` for a command with no target — which
              leaves the browser's own behaviour alone, as an unhandled command
              should.
            */
            const intent = intentForRowCommand(command, {
              canEdit: files.canEdit,
              selectedPath: files.selectedPath,
              listings: files.listings,
              clipboard: files.clipboard,
            });
            if (intent === null) return false;
            return applyRowIntent(intent, files, onDialog);
          }

          default: {
            // ⌘1–⌘9. Written as a fall-through rather than nine cases.
            const index = (NUMBERED_TABS as readonly string[]).indexOf(command);
            if (index < 0) return false;
            const target = tabAt(tabs.state, index);
            if (target === null) return false;
            tabs.activate(target);
            return true;
          }
        }
      },
      [files, tabs, onCloseTab, onDialog, frame, onSearch],
    ),
  });

  return null;
}

/** ⌘1 … ⌘9, in order, so `tabAt` can be indexed straight off the command. */
const NUMBERED_TABS = [
  "tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "tab9",
] as const;

/**
 * The thumb's half of the console.
 *
 * Only the verbs that have nowhere else to go on a phone. Creating and
 * searching have no gesture of their own — a long press on a row raises what
 * you can do *to a note*, and neither of these is about a note that already
 * exists. The tree toggle is here as well as in the top bar because this is
 * where a thumb is, and the top bar is a stretch on a tall phone.
 */

/**
 * The bucket this context is bound to, in the top bar.
 *
 * It sat beside the Browse pane's title, which meant it disappeared on every
 * other route even though the binding is a property of the context you are in.
 * A context with nowhere to keep notes is a legitimate state and one you have
 * to be able to *see*, so it is warn-toned rather than another grey chip.
 *
 * The words come from `storagePillLabel`, which is what stopped a Dropbox
 * binding — no bucket, by design — from printing "dropbox · undefined" here.
 *
 * And it is a way in, not just a fact: pressing it opens the selected
 * context's storage settings, for every provider alike. It always was the one
 * place the binding is stated on every route, and a stated fact you cannot act
 * on — "no bucket connected", with the connect form two unadvertised
 * navigations away — is most of the way to a bug. The press target fills the
 * top bar's height (`topBarHeight` is `minTouchTarget + 1`), so it is
 * reachable by a thumb without growing the bar.
 */
function StorageChip({
  data,
  onOpenSettings,
}: {
  data: ConsoleData;
  /** Absent only while there is no selected context to have settings. */
  onOpenSettings?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  // `undefined` is a binding that has not answered. Saying "no bucket
  // connected" about it is a warn pill on somebody's own bucket, and
  // `data.loading` does not cover it — see `ConsoleData.storage`.
  if (data.loading || data.storage === undefined) return null;
  const label = storagePillLabel(data.storage);

  const pill =
    label === null ? (
      <Pill tone="warn" leading={<Dot tone="warn" />}>
        no bucket connected
      </Pill>
    ) : (
      <Pill tone="neutral">{label}</Pill>
    );

  if (onOpenSettings === undefined) return pill;
  return (
    <PressRow
      accessibilityLabel="Open storage settings"
      onPress={onOpenSettings}
      radius={radii.pill}
      style={styles.storagePress}
      hoverStyle={styles.storagePressHover}
      testID="storage-pill"
    >
      {pill}
    </PressRow>
  );
}

/**
 * Who you are signed in as, and the way out.
 *
 * Presentational now. Ending a session is `useSignOutFlow`, which the console
 * layout owns and hands to both this block and the settings overlay's Sign out
 * row — see that hook for what sign-out actually does to the device's cache
 * and its unsent writes, and why the person is asked first.
 */
function Account({
  data,
  compact,
  touch = false,
  onOpenSettings,
  onSignOut,
}: {
  data: ConsoleData;
  compact: boolean;
  touch?: boolean;
  onOpenSettings?: () => void;
  onSignOut: () => void;
}) {
  return (
    <AccountBlock
      // The viewer, resolved once in `identity.ts` — never the viewed context.
      // This block used to take the first `kind === "personal"` context (which
      // is somebody else's the moment one is shared with you) and the selected
      // context's capture address, so opening a shared context renamed the
      // signed-in person after it.
      name={data.viewer.name}
      detail={data.viewer.detail}
      initial={data.viewer.initial}
      compact={compact}
      touch={touch}
      onOpenSettings={onOpenSettings}
      onSignOut={onSignOut}
    />
  );
}

/**
 * Counts, save state — and the one thing nothing in this UI has ever said:
 * whether your bucket actually supports conditional writes.
 *
 * `SaveResult.conflictCheck` has always come back from the server and has
 * always been thrown away. B2 and Wasabi cannot do conditional writes, so a
 * save there is checked by re-reading first, and "degrade honestly" (see
 * CLAUDE.md) means somebody has to be able to see which one they got.
 */
function Status({
  data,
  onOpenSync,
}: {
  data: ConsoleData;
  /**
   * Opens the sync sheet — the phone's, reused, so the rows and the answers on
   * them are one implementation. Given only where the sheet can open (Browse),
   * and attached only to the two sync segments.
   */
  onOpenSync?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const segments = statusSegments({
    editor: data.files.editor,
    conflictCheck: data.files.editor.conflictCheck,
    // The same words as the top bar's chip, from the same function — two call
    // sites interpolating `provider · bucket` themselves is how one of them
    // printed "dropbox · undefined".
    storageLabel: storagePillLabel(data.storage),
    // How much of this context is in the hosted index, on every console route
    // rather than only in settings — which is the whole of what made a stuck
    // backfill and a working one look the same. `null` for a member, for a
    // context with fast search off, and before the status has answered, and
    // the strip then draws no segment rather than a placeholder.
    index: describeIndexProgress(data.fastSearch.status),
    now: Date.now(),
    // The connection and the writes that have not reached the bucket, from the
    // browser that owns them. They are drawn first: somebody who has lost
    // signal should not have to read past a word count to find that out.
    sync: data.files.sync,
  });

  /*
    Transparent and unpadded, because the frame's own status row already draws
    the surface, the height, the top rule and the gutter — and puts the tree's
    toggle inside it. Two copies of that chrome is a second rule under the
    first and the leading segment indented twice.
  */
  /*
    How much of this context is on the device, from the offline mirror — at
    the front beside "Offline" when part of it is missing and the device is
    offline, and quietly at the end of the leading group otherwise.
  */
  const withMirror = withMirrorSegment(segments, data.files.sync, Date.now()).map((segment) =>
    onOpenSync !== undefined && (segment.id === "queue" || segment.id === "connection")
      ? { ...segment, onPress: onOpenSync }
      : segment,
  );
  return <StatusBar segments={withMirror} style={styles.statusBar} testID="console-status" />;
}

export { Avatar };

const makeStyles = (colors: Colors) => StyleSheet.create({
  statusBar: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 0,
    borderTopWidth: 0,
    backgroundColor: "transparent",
  },

  switcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minWidth: 0,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  switcherKind: { color: colors.muted },

  /**
   * The pill's press target. `minHeight` is the touch floor — the top bar is
   * one point taller, so the target fills it instead of growing it — and the
   * pill centres inside the taller invisible surface.
   */
  storagePress: {
    minHeight: layout.minTouchTarget,
    justifyContent: "center",
    borderRadius: radii.pill,
  },
  storagePressHover: { backgroundColor: colors.surface3 },
});

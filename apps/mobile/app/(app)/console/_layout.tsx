import { useCallback, useEffect, useRef, useState } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { PressRow } from "../../../features/design/components/Button";
import { Dot } from "../../../features/design/components/Dot";
import { Icon } from "../../../features/design/components/Icon";
import { Pill } from "../../../features/design/components/Pill";
import { Palette } from "../../../features/design/components/Palette";
import { StatusBar } from "../../../features/design/components/StatusBar";
import { Text } from "../../../features/design/components/Text";
import { ToastHost } from "../../../features/design/components/Toast";
import { layout, radii, space } from "../../../features/design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../features/design/theme";
import { AppFrame, FrameIconButton, useFrame } from "../../../features/app/AppFrame";
import { densityFor } from "../../../features/app/frame";
import { BottomBar } from "../../../features/console/BottomBar";
import { AccountBlock, Avatar, ConsoleRail } from "../../../features/console/ConsoleRail";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { EditorRegion } from "../../../features/console/EditorRegion";
import { TierChip } from "../../../features/console/ConsoleShell";
import {
  Explorer,
  ExplorerDialogs,
  type Dialog,
} from "../../../features/console/files/Explorer";
import { Confirm } from "../../../features/console/files/Dialogs";
import { itemsFromListings } from "../../../features/console/files/palette";
import { useContextSearch } from "../../../features/console/files/useContextSearch";
import { useTabs } from "../../../features/console/files/useTabs";
import { readFocus, scopeForFocus } from "../../../features/console/keyboardScope";
import { tabAt } from "../../../features/console/files/tabs";
import {
  canGoBack,
  canGoForward,
  currentPath,
  emptyHistory,
  stepped,
  visited,
  type HistoryState,
} from "../../../features/console/files/history";
import { entryAt, targetFolder } from "../../../features/console/files/tree";
import {
  applyRowIntent,
  intentForRowCommand,
} from "../../../features/console/files/rowCommand";
import { TabSwitcher, tabCountLabel } from "../../../features/console/files/TabSwitcher";
import { statusSegments } from "../../../features/console/files/status";
import { dirtyCount, isTabDirty } from "../../../features/console/files/tabs";
import { isDirty } from "../../../features/console/files/editor";
import { useUnsavedGuard } from "../../../features/console/files/useUnsavedGuard";
import { atName } from "../../../features/console/format";
import {
  hrefFor,
  resolveContextRoute,
  routeForPath,
  sameRoute,
  settingsHref,
  type ConsoleRoute,
} from "../../../features/console/nav";
import { forgetLocalCopies, unsentOnDevice } from "../../../features/offline/forget";
import { signOutWarning } from "../../../features/offline/copy";
import { storagePillLabel } from "../../../features/console/storage/pill";
import { describeIndexProgress } from "../../../features/console/search/fastSearch";
import { selectedContext, type ConsoleData } from "../../../features/console/types";
import { useKeymap } from "../../../features/design/useKeymap";
import type { FileBrowser } from "../../../features/console/files/browser";
import {
  SCOPE_ICON,
  nextScope,
  scopeActionLabel,
  scopeOf,
} from "../../../features/console/files/scope";
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
  const styles = useThemedStyles(makeStyles);
  const data = useLiveConsoleData();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const route = routeForPath(pathname);

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
    The phone's answer to the tab strip. Held here beside `tabs` for the same
    reason the tab model is: the switcher acts on the model, and a piece of
    state that lives one level down from the thing it opens is a ref waiting to
    be written.
  */
  const [switcherOpen, setSwitcherOpen] = useState(false);
  /*
    The toolbar's `+` raises the explorer's own dialog. Held here rather than
    inside `Explorer` because the toolbar is a sibling of the explorer, not a
    child of it — and `ExplorerDialogs` was already split out of `Explorer` for
    exactly this: "so the tree and the editor can drive the same set without
    either owning it".
  */
  const [barDialog, setBarDialog] = useState<Dialog>(null);
  /*
    The tab whose close is waiting on a confirm.

    `tabs.ts`'s `closed` case says a modal decision has no business inside a
    data structure and that "the UI confirms before dispatching". Nothing did:
    the tab's ×, the switcher sheet and ⌘W all reached the reducer directly, so
    a dirty tab closed silently and the draft — which nothing autosaves and
    nothing persists — was gone. One state, so all three routes ask.
  */
  const [closingTab, setClosingTab] = useState<string | null>(null);

  /*
    The exit the app does not own. `guardLeaving` covers opening another note
    and the confirm above covers closing a tab; this covers closing the browser
    tab and reloading, which lost the draft in silence. Native is deliberately
    a no-op — see the hook.
  */
  useUnsavedGuard(isDirty(data.files.editor));
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
    Set while a back or forward press is moving the selection, so the effect
    below does not record the move as a fresh visit — which would truncate the
    forward tail on the first press of `‹` and make `›` dead.
  */
  const navigating = useRef(false);
  const selectedPath = data.files.selectedPath;

  useEffect(() => {
    setHistory(emptyHistory);
  }, [data.selectedContextId]);

  useEffect(() => {
    if (selectedPath === null) return;
    if (navigating.current) {
      navigating.current = false;
      return;
    }
    setHistory((current) => visited(current, selectedPath));
  }, [selectedPath]);

  const step = useCallback(
    (delta: -1 | 1) => {
      setHistory((current) => {
        const next = stepped(current, delta);
        const path = currentPath(next);
        if (next === current || path === null) return current;
        navigating.current = true;
        // The guard can still refuse — an unsaved draft. Then the selection
        // does not move, and neither should the cursor.
        if (!data.files.select(path)) {
          navigating.current = false;
          return current;
        }
        return next;
      });
    },
    [data.files],
  );
  const current = selectedContext(data);
  /*
    Which half of `tabs.ts` is on screen. `TabStrip` is the pointer half and
    `TabSwitcher` the thumb half — see either file's header for why they are two
    components rather than one with a breakpoint. Read here rather than inside
    them because it also decides whether the bottom toolbar carries a count.
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
  const search = useContextSearch(insideContext ? data.files.search : null);
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
    if (!phone || !browsing) setSwitcherOpen(false);
  }, [phone, browsing]);

  /**
   * Close a tab, asking first when that would throw a draft away.
   *
   * The clean tabs — nearly all of them — still close on one press. A confirm
   * on every close would train people to dismiss it, which is how the one that
   * mattered gets dismissed too.
   */
  const closeTab = useCallback(
    (path: string) => {
      if (isTabDirty(tabs.state, path)) setClosingTab(path);
      else tabs.close(path);
    },
    [tabs],
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
   * Visibility, as the second action in the same group.
   *
   * Owner-only, like every visibility control — `canSetVisibility` is the
   * server's rule and `FolderView`'s own comment records what offering it to
   * an editor cost. `readOnly` is excluded because `privacy.md` *is* the
   * access map: a control that offered to change its visibility would be
   * offering to edit the file that decides everybody else's.
   */
  const visibilityTarget =
    browsing && data.files.canSetVisibility && selectedEntry !== null && !selectedEntry.readOnly
      ? selectedEntry
      : null;

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
  const visibilityScope = scopeOf(
    visibilityTarget?.visibility ?? "private",
    visibilityTarget !== null && data.files.openLinkPaths.has(visibilityTarget.path),
  );
  const visibilityNext = nextScope(visibilityScope, visibilityTarget?.kind === "file");

  return (
    <ConsoleDataProvider value={data}>
      <AppFrame
        switcher={
          insideContext ? (
            /*
              `switcherCompact` takes this chip's own border and fill away on a
              phone. `AppFrame`'s `navToggleCompact` already draws a shadowed
              white capsule around it, and a bordered box inside that capsule is
              two containers for one control — most of what made the phone's top
              edge read as a toolbar drawn twice.
            */
            <View style={[styles.switcher, phone && styles.switcherCompact]}>
              <Dot tone={current?.status ?? "warn"} />
              <Text variant="wsSwitch" numberOfLines={1}>
                {contextLabel}
              </Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {current?.kind ?? ""}
              </Text>
            </View>
          ) : (
            // Map and Connections are not inside anything, and a context chip
            // above them would be naming a scope the pane is not in. "Your
            // context" is the aggregate — everything this person can reach —
            // which is exactly what these panes span (see CLAUDE.md,
            // "Vocabulary").
            <View style={[styles.switcher, phone && styles.switcherCompact]}>
              <Text variant="wsSwitch">Your context</Text>
              {/*
                No number until the list has arrived. `contexts` is empty on a
                cold launch because nothing has been fetched, and "0 reachable"
                over somebody's own console is the same accusation the storage
                banner used to make — see `ConsoleData.storage`.
              */}
              {data.loading ? null : (
                <Text variant="wsSwitch" style={styles.switcherKind}>
                  {`${data.contexts.length} reachable`}
                </Text>
              )}
            </View>
          )
        }
        /*
          The same words the chip draws, as a string. `AppFrame` cannot read
          them off the node — and on native it could not derive them from the
          rendered text either; see `switcherLabel`.
        */
        switcherLabel={
          insideContext
            ? [contextLabel, current?.kind].filter(Boolean).join(", ")
            : data.loading
              ? "Your context"
              : `Your context, ${data.contexts.length} reachable`
        }
        /*
          Absent on a phone, where both chips have moved to the foot of the file
          tree — see `ContextFoot` and `Explorer`'s `vault` slot.

          They are facts *about the context you are in*: which bucket it is
          bound to, and what you are allowed to see in it. Beside the context's
          own name, at the foot of the panel that lists it, they read as a
          caption. Floating over the note in the top-right corner of a 390pt
          screen they read as chrome about the note, which is what they were
          being mistaken for — and getting them there cost a bordered pill
          wrapping two bordered pills.

          The pointer layout keeps them in the bar. It has the width, the bar
          has a surface of its own to sit them on, and the tree's foot there is
          a 26pt strip at the bottom of a 260pt column rather than the panel's
          own footer.
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
            shareTarget === null && visibilityTarget === null ? undefined : (
              <>
                {visibilityTarget === null ? null : (
                  <FrameIconButton
                    /*
                      The label is the *destination*, because that is what a
                      screen reader has to announce about a button, while the
                      icon is the current state — see `ICON_NAMES`. The two
                      disagreeing is the point rather than a slip: one is read
                      aloud before the press and the other is looked at.

                      Three positions rather than two now, and every decision
                      about which is which is in `files/scope.ts` — a pure
                      module, for the reason `shareViewer.test.ts` records: in a
                      sabotage sweep of this codebase, every guard written as a
                      pure module held and every guard written inside a
                      component did not. This one composes the privacy manifest
                      with a share row, which is exactly the sort of thing that
                      rots into "is it team? then it must be public".
                    */
                    label={scopeActionLabel(visibilityNext)}
                    icon={SCOPE_ICON[visibilityScope]}
                    grouped
                    onPress={() =>
                      data.files.setScope(
                        visibilityTarget.path,
                        visibilityTarget.kind,
                        visibilityScope,
                        visibilityNext,
                      )
                    }
                    testID="note-visibility"
                  />
                )}
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
                Gated on `insideContext`, and `StorageChip` beside it is not.
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
                    : () => router.push(settingsHref(current.slug))
                }
              />
            </>
          )
        }
        onSearch={insideContext ? () => setPaletteOpen(true) : undefined}
        rail={(mode) => <Rail data={data} route={route} mode={mode} />}
        /*
          `browsing`, not `insideContext`.

          Settings is inside a context, so gating on that shipped Browse's
          whole toolbar to a screen with no notes on it: a file tree, a `+`
          that wrote a note you could not see, a Save with nothing to save, and
          a tab count whose sheet activated notes behind the settings pane.
          Tapping a note in that drawer selected it and closed the drawer with
          no visible change at all.
        */
        explorer={
          browsing ? (
            <Explorer
              files={data.files}
              contextLabel={contextLabel}
              /*
                Obsidian's vault-switcher slot, and on a phone it is where the
                two chips from the old top-right pill now live. Absent on a
                pointer layout, where the top bar still carries them — see
                `topTrailing`.
              */
              vault={
                phone ? (
                  <VaultSwitcher
                    label={contextLabel}
                    kind={current?.kind ?? ""}
                    tone={current?.status ?? "warn"}
                    onOpenSettings={
                      current === null
                        ? undefined
                        : () => router.push(settingsHref(current.slug))
                    }
                  />
                ) : undefined
              }
              /*
                The binding, then how much of the context is in the hosted
                index, then the counts. `storagePillLabel` is the same function
                the pointer layout's chip and the status bar read, so the three
                cannot come to describe one bucket three ways — which is how
                "dropbox · undefined" got printed once — and
                `describeIndexProgress` is likewise the same function the
                settings card and the status bar read.

                This line exists on a phone because **the status bar does not**:
                at `compact` the frame draws a bottom toolbar and no status
                strip (`features/app/frame.ts`), so without this a phone would
                only ever learn how far the backfill had got by opening
                settings. `null` is omitted rather than filled in, which for a
                member is the owner-only rule doing its work — see
                `describeIndexProgress`.
              */
              vaultDetail={
                phone && data.storage !== undefined
                  ? [
                      storagePillLabel(data.storage) ?? "no bucket connected",
                      describeIndexProgress(data.fastSearch.status)?.label,
                    ]
                      .filter((part): part is string => part !== undefined)
                      .join(" · ")
                  : undefined
              }
              onOpenPinned={(path) => {
                data.files.select(path);
                tabs.pin(path);
              }}
              onOverlayChange={setTreeOverlay}
            />
          ) : undefined
        }
        status={<Status data={data} />}
        bottomBar={
          browsing ? (
            <ConsoleBottomBar
              data={data}
              tabs={tabs}
              history={history}
              onStep={step}
              onSearch={() => setPaletteOpen(true)}
              onOpenTabs={() => setSwitcherOpen(true)}
              onNewNote={(folder) => setBarDialog({ kind: "newNote", folder })}
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
          paletteOpen={paletteOpen || treeOverlay || switcherOpen}
        />
        <EditorRegion
          browse={browsing}
          failure={data.failure}
          tabs={browsing && !phone ? tabs : null}
          onCloseTab={closeTab}
          phone={phone}
        >
          <Slot />
        </EditorRegion>

        {/*
          The tab sheet, mounted only where there is a control that opens it.
          `TabSwitcher` closes itself when the last tab goes (see its effect),
          and the guard on `tabs.length` is what stops it re-opening empty if
          something else empties the strip while it is up.
        */}
        {switcherOpen && phone && tabs.state.tabs.length > 0 ? (
          <TabSwitcher
            state={tabs.state}
            onActivate={(path) => {
              tabs.activate(path);
              setSwitcherOpen(false);
            }}
            onClose={closeTab}
            onDismiss={() => setSwitcherOpen(false)}
          />
        ) : null}

        {closingTab === null ? null : (
          <Confirm
            title="Discard unsaved changes?"
            body={`${closingTab} has changes that have not been saved to your bucket. Closing this tab throws them away — nothing here is autosaved.`}
            confirmLabel="Discard and close"
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
            items={itemsFromListings(data.files.listings)}
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
            onChoose={(item) => {
              setPaletteOpen(false);
              data.files.select(item.id);
            }}
            onDismiss={() => setPaletteOpen(false)}
          />
        ) : null}
      </AppFrame>
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
          case "toggleRail":
            frame.toggleRail();
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
            // The one people try first. It is `editor`-scoped, so it fires from
            // inside the textarea and nowhere else.
            if (!files.canEdit || files.editor.status !== "dirty") return false;
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
 * The rail, wired to the router — and, on a phone, to the sheet it is inside.
 *
 * A component rather than an inline node in the slot, because it needs
 * `useFrame`, and the slot is rendered *inside* `AppFrame`'s provider while the
 * layout that passes it is above it.
 *
 * Choosing a destination dismisses the sheet, for the same reason choosing a
 * note dismisses the tree drawer: on a phone the panel is covering the thing
 * you just asked for. It dismisses even when the destination is the route you
 * are already on — you asked for that pane, and a sheet that stays put because
 * the router had nothing to do reads as a dead press.
 *
 * `onClaimContext` leaves the console entirely, which is why it is a callback
 * rather than a `ConsoleRoute`: `/welcome` is not under `/console`, and the
 * rail renders the entry only for somebody who owns nothing. See
 * `offerOwnContext`.
 */
function Rail({
  data,
  route,
  mode,
}: {
  data: ConsoleData;
  route: ConsoleRoute;
  mode: "full" | "icons" | "sheet";
}) {
  const frame = useFrame();
  const router = useRouter();

  return (
    <ConsoleRail
      data={data}
      route={route}
      mode={mode}
      onNavigate={(next) => {
        frame.closeNav();
        // Pressing the rail entry you are already on should do nothing, not
        // re-enter the route — which on a context would reset the file browser
        // out from under an open note.
        if (!sameRoute(next, route)) router.replace(hrefFor(next));
      }}
      account={<Account data={data} compact={mode === "icons"} touch={mode === "sheet"} />}
      onClaimContext={() => {
        frame.closeNav();
        // `push`, not `replace`: somebody who opens this out of curiosity from
        // inside a context they were given must be able to come back with the
        // browser's own Back button. Onboarding has no Back of its own — step 1
        // claims a name out of a global namespace with no release path — so the
        // one before it is the only one there can be.
        router.push(WELCOME_ROUTE);
      }}
      /*
        Offered to everybody, and only in the live console.

        `data.demo` is the condition rather than a role or a count: the landing
        page renders this same rail as a picture, and an entry there would open
        a flow that immediately refuses for want of a session. How many
        workspaces one account may own is the control plane's rule, enforced in
        `createWorkspace`'s transaction, and it is not restated here — see
        `onCreateWorkspace` on `ConsoleRail`.
      */
      onCreateWorkspace={
        data.demo
          ? undefined
          : () => {
              frame.closeNav();
              // `push` for `onClaimContext`'s reason, and one more: this flow
              // is genuinely abandonable up to the moment the name is claimed,
              // so Back has somewhere real to return to.
              router.push(NEW_WORKSPACE_ROUTE);
            }
      }
      /*
        Meeting capture, which until now had no way in from anywhere in the app.

        `push`, not `replace`, for `onClaimContext`'s reason and one more: the
        meetings screens sit outside the console entirely, so the browser's Back
        — and the phone's — is the way back to the note somebody left. A
        `replace` would take that away and leave `/meetings` with no route out
        of it at all.

        Offered in the live console only, like `onCreateWorkspace`: the landing
        page mounts the rail as a picture and has nowhere to send anybody.
      */
      onOpenMeetings={
        data.demo
          ? undefined
          : () => {
              frame.closeNav();
              router.push(MEETINGS_ROUTE);
            }
      }
      onLeaveContext={(id) => {
        frame.closeNav();
        // Fire-and-watch: the membership row deleting is what removes the
        // context from the rail, via the subscription. Land on the Map so the
        // person is not left standing in a context they just left.
        void data.leaveContext?.(id);
        router.replace("/console");
      }}
    />
  );
}

/**
 * The thumb's half of the console.
 *
 * Only the verbs that have nowhere else to go on a phone. Creating and
 * searching have no gesture of their own — a long press on a row raises what
 * you can do *to a note*, and neither of these is about a note that already
 * exists. The tree toggle is here as well as in the top bar because this is
 * where a thumb is, and the top bar is a stretch on a tall phone.
 */
function ConsoleBottomBar({
  data,
  tabs,
  history,
  onStep,
  onSearch,
  onOpenTabs,
  onNewNote,
}: {
  data: ConsoleData;
  tabs: ReturnType<typeof useTabs>;
  /** Where you have been, for `‹` and `›`. */
  history: HistoryState;
  onStep: (delta: -1 | 1) => void;
  onSearch: () => void;
  onOpenTabs: () => void;
  /** Raises the naming dialog for a destination — see the `new` action. */
  onNewNote: (folder: string) => void;
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
        {
          id: "back",
          label: "Go back",
          icon: "chevronLeft" as const,
          disabled: !canGoBack(history),
          onPress: () => onStep(-1),
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
          Absent, not dimmed. `BottomBar` argues that a fixed strip must not
          move items out from under a thumb, and that is right for Save, which
          is unavailable for a moment. `canEdit` is not a moment — it is the
          whole console, for the whole session — and `menu.ts` states the rule
          for exactly this case: read-only means the control is **gone**, not
          present and refusing.
        */
        /*
          The same dialog the explorer's own `+` raises, not a second contract.

          This used to call `createNote(folder, "Untitled")` directly, which
          made one icon mean two different things on one screen: the drawer's
          `+` asked for a name and said where it was going, this one wrote
          immediately and said neither. Worse, `folder` is derived from a
          selection that lives *in the drawer* — normally shut when this button
          is pressed — so the destination was invisible, defaulted to the
          bucket root, and a second press failed on the name collision rather
          than making a second note.

          `ExplorerDialogs` already renders `NamePrompt` with the sentence that
          answers all of that: "It will be created in 1-projects as markdown."
        */
        ...(files.canEdit
          ? [
              {
                id: "new",
                label: "New note",
                icon: "plus" as const,
                onPress: () => onNewNote(folder),
              },
            ]
          : []),
        /*
          The tab count, in the position Obsidian, Safari and Chrome all put it:
          a number in the toolbar rather than a strip above the note. The strip
          is not drawn at this density at all — see `EditorRegion` — so this is
          the only way to a note that is open but not in front of you.

          Absent with nothing open, rather than a `0`. There is no sheet to
          raise, and a control that opens an empty sheet is worse than one that
          is not there. It is the last item on the bar for that reason too:
          appearing and disappearing must not move a target somebody is already
          reaching for, which is `BottomBar`'s rule, and the end of the row is
          the one place where it cannot.
        */
        ...(tabs.state.tabs.length > 0
          ? [
              {
                id: "tabs",
                // One phrasing, from the file that owns the counting.
                label: tabCountLabel(tabs.state),
                icon: "file" as const,
                // The number *is* the control — see `count` in `BottomBar`.
                // The accent badge it replaces read as a notification about
                // something that had happened, rather than a count of what is
                // already open.
                count: tabs.state.tabs.length,
                marker: dirtyCount(tabs.state) > 0,
                onPress: onOpenTabs,
              },
            ]
          : []),
        {
          id: "save",
          label: "Save this note",
          icon: "check" as const,
          // Absent rather than dead would move every other button mid-reach,
          // so it dims in place — see `BottomBar`.
          disabled: files.editor.status !== "dirty",
          marker: files.editor.status === "dirty",
          onPress: files.save,
        },
      ]}
    />
  );
}

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
 * Obsidian's vault switcher, at the foot of the file tree.
 *
 * One line: which context you are in, a chevron that changes it, and a gear
 * that configures it. It is the block the reference ends its sidebar with, and
 * it is where the `@seyi personal` chip from the top bar has gone.
 *
 * **The chevron is the only way to the rail on a phone with a tree open, and
 * that is deliberate rather than incidental.** The rail carries the other
 * contexts, the app-level panes and sign-out; the top bar used to carry a
 * switcher chip that opened it, and the whole point of this change is that the
 * top bar carries a toggle and one group of actions and nothing else. So the
 * control moved rather than went — it is here, beside the name it changes,
 * which is what a workspace switcher is. `frame.ts` keeps the top bar's chip
 * for the routes that have no tree (Map, Connections), where this footer does
 * not exist.
 *
 * The gear is `StorageChip`'s old press target: a fact you can act on. It opens
 * this context's settings, which is where the bucket is bound.
 */
function VaultSwitcher({
  label,
  kind,
  tone,
  onOpenSettings,
}: {
  label: string;
  kind: string;
  tone: "ok" | "warn" | "crit";
  /** Absent only while there is no selected context to have settings. */
  onOpenSettings?: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const frame = useFrame();

  return (
    <>
      <PressRow
        accessibilityLabel={`${label}, ${kind}. Switch context`}
        onPress={frame.toggleRail}
        radius={radii.md}
        style={styles.vaultName}
        hoverStyle={styles.storagePressHover}
        testID="vault-switcher"
      >
        <Dot tone={tone} />
        <Text variant="wsSwitch" numberOfLines={1} style={styles.vaultLabel}>
          {label}
        </Text>
        <Text variant="wsSwitch" style={styles.switcherKind} numberOfLines={1}>
          {kind}
        </Text>
        <Icon
          name={frame.state.navOpen ? "chevronUp" : "chevronDown"}
          size={14}
          color={colors.muted}
        />
      </PressRow>
      {onOpenSettings === undefined ? null : (
        <PressRow
          accessibilityLabel="Open storage settings"
          onPress={onOpenSettings}
          radius={radii.control}
          style={styles.vaultGear}
          hoverStyle={styles.storagePressHover}
          testID="vault-settings"
        >
          <Icon name="gear" size={18} color={colors.text2} />
        </PressRow>
      )}
    </>
  );
}

/** No context selected, or a browser with no offline layer under it. */
const NO_QUEUE = { pending: 0, conflicted: 0, rejected: 0 };

/**
 * Who you are signed in as, and the way out — which is also the moment this
 * device stops holding somebody's notes.
 *
 * Sign-out used to be `signOut().then(replace("/"))` and nothing else, while
 * `features/offline/cache.ts` carried a `forgetEverything` whose own comment
 * said it was "called on sign-out". Nothing called it. On a shared machine that
 * left cached note bodies — including ones an owner read at **private** tier —
 * keyed by workspace and by nothing about *who* read them, so the next person
 * to sign in who is a `team` member of the same context read them; and it left
 * the outbox, which `useOfflineNotes` drains the moment a queue and a
 * connection exist, sending the previous person's typing to the bucket under
 * the new person's session.
 *
 * Four properties, and each is a different failure if dropped:
 *
 *  - **The clear is awaited before `signOut`.** Not fire-and-forget: a clear
 *    that merely started leaves a window the next sign-in can race.
 *  - **The clear is also a barrier, not only a moment.** Awaiting it is not
 *    enough on its own: a read still in flight lands after it and writes a
 *    note body back. `forgetLocalCopies` ends the session epoch before it
 *    removes anything, and every writer in `useOfflineNotes` drops a write
 *    from a session that has ended.
 *  - **It cannot block.** Being unable to end a session is worse than a cache
 *    that outlives one, so the verdict is reported and never enforced — and
 *    the await itself is bounded, because a wedged native bridge never settles
 *    and a `catch` has nothing to catch. See `features/offline/forget.ts` for
 *    the whole stance.
 *  - **The person is asked first when the queue is not empty.** Discarding it
 *    is deliberate, so this is the last moment anybody can be told — and the
 *    count covers every context on the device, not just the one on screen,
 *    because that is what is about to go.
 *
 * The confirm is the console's own `Confirm`, the same primitive a dirty tab
 * close uses. A second dialog shape for the same question ("this throws away
 * work — still?") is how two answers to it start drifting apart.
 */
function Account({
  data,
  compact,
  touch = false,
}: {
  data: ConsoleData;
  compact: boolean;
  touch?: boolean;
}) {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [discarding, setDiscarding] = useState<string | null>(null);

  const signOutNow = useCallback(() => {
    void (async () => {
      // Awaited, and first — and bounded inside `forget.ts`, so a store that
      // stops answering cannot hold somebody on this button. The result is
      // deliberately not acted on here: `forget.ts` reports it, and there is
      // no surface left to show it on.
      await forgetLocalCopies();
      await signOut();
      router.replace("/");
    })();
  }, [router, signOut]);

  return (
    <>
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
        onSignOut={() => {
          void (async () => {
            /*
              The open context's queue is normally excluded from the device
              count and supplied by the live hook instead, because the hook's
              copy is newer than the persisted one — see `waitingOnDevice`.

              That swap only holds once the hook has actually read the queue
              back. Before `ready` its counts are an *empty* queue rather than
              this device's, so excluding the persisted copy at the same time
              warns about nothing and then discards it — and sign-out pressed
              during a cold load is not a corner, it is somebody who opened the
              console to leave. Unready, nothing is excluded; the live counts
              are zero, so there is nothing to double.
            */
            const live = data.files.sync;
            const elsewhere = await unsentOnDevice(
              live?.ready === true ? data.selectedContextId : null,
            );
            const here = live?.counts ?? NO_QUEUE;
            const warning = signOutWarning({
              pending: here.pending + elsewhere.pending,
              conflicted: here.conflicted + elsewhere.conflicted,
              rejected: here.rejected + elsewhere.rejected,
            });
            if (warning === null) {
              signOutNow();
              return;
            }
            setDiscarding(warning);
          })();
        }}
      />
      {discarding === null ? null : (
        <Confirm
          title="Sign out with edits still waiting?"
          body={`${discarding} Nothing else is lost — your bucket is untouched.`}
          confirmLabel="Sign out and discard"
          onCancel={() => setDiscarding(null)}
          onConfirm={() => {
            setDiscarding(null);
            signOutNow();
          }}
        />
      )}
    </>
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
function Status({ data }: { data: ConsoleData }) {
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

  return <StatusBar segments={segments} testID="console-status" />;
}

export { Avatar };

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  /**
   * The same chip with no box of its own.
   *
   * On a phone `AppFrame` wraps this in `navToggleCompact` — a white capsule
   * with a shadow — because the bar it sits in is transparent and a control
   * lying over a note needs a surface. Keeping the border and the 8pt radius
   * as well drew a rounded rectangle inside a capsule: two edges, two radii and
   * two fills for one line of type. One container per control.
   *
   * The horizontal padding goes with the border for the same reason. The
   * capsule already provides it, and paying it twice pushed the context name
   * far enough right that it ellipsised at 390pt.
   */
  switcherCompact: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
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

  /**
   * The vault switcher's name line: it takes the room, the gear takes the end.
   *
   * `flexShrink: 1` with `minWidth: 0` is what lets a long context name
   * ellipsise rather than pushing the gear off the panel — the same rule the
   * breadcrumb used to need beside Share, and the same failure if it is
   * dropped.
   */
  vaultName: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: layout.minTouchTarget,
    paddingHorizontal: space.x1,
    borderRadius: radii.md,
  },
  vaultLabel: { flexShrink: 1, minWidth: 0 },
  /** The gear, at the trailing edge, at a size a thumb can hit. */
  vaultGear: {
    flexGrow: 0,
    flexShrink: 0,
    marginLeft: "auto",
    width: layout.minTouchTarget,
    height: layout.minTouchTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.control,
  },

});

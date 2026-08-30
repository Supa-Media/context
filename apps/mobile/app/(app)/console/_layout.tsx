import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button, PressRow } from "../../../features/design/components/Button";
import { Dot } from "../../../features/design/components/Dot";
import { FormError } from "../../../features/design/components/Input";
import { Pill } from "../../../features/design/components/Pill";
import { Palette } from "../../../features/design/components/Palette";
import { StatusBar } from "../../../features/design/components/StatusBar";
import { Text } from "../../../features/design/components/Text";
import { colors, layout, radii, space } from "../../../features/design/tokens";
import { AppFrame, useFrame } from "../../../features/app/AppFrame";
import { densityFor } from "../../../features/app/frame";
import { BottomBar } from "../../../features/console/BottomBar";
import { AccountBlock, Avatar, ConsoleRail } from "../../../features/console/ConsoleRail";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { TierChip } from "../../../features/console/ConsoleShell";
import {
  Explorer,
  ExplorerDialogs,
  type Dialog,
} from "../../../features/console/files/Explorer";
import { Confirm } from "../../../features/console/files/Dialogs";
import { itemsFromListings } from "../../../features/console/files/palette";
import { useTabs } from "../../../features/console/files/useTabs";
import { readFocus, scopeForFocus } from "../../../features/console/keyboardScope";
import { tabAt } from "../../../features/console/files/tabs";
import { targetFolder } from "../../../features/console/files/tree";
import { TabStrip } from "../../../features/console/files/TabStrip";
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
import { storagePillLabel } from "../../../features/console/storage/pill";
import { selectedContext, type ConsoleData } from "../../../features/console/types";
import { useKeymap } from "../../../features/design/useKeymap";
import type { FileBrowser } from "../../../features/console/files/browser";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";
import { canReload, reloadApp } from "../../../features/app/reload";
import { WELCOME_ROUTE } from "../../../features/onboarding/route";

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

  return (
    <ConsoleDataProvider value={data}>
      <AppFrame
        switcher={
          insideContext ? (
            <View style={styles.switcher}>
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
            <View style={styles.switcher}>
              <Text variant="wsSwitch">Your context</Text>
              <Text variant="wsSwitch" style={styles.switcherKind}>
                {`${data.contexts.length} reachable`}
              </Text>
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
            : `Your context, ${data.contexts.length} reachable`
        }
        topTrailing={
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

        {paletteOpen ? (
          <Palette
            items={itemsFromListings(data.files.listings)}
            placeholder="Go to a note"
            noMatchMessage={
              "Nothing loaded matches that. Only folders you have opened are searched — " +
              "the rest of this context has not been read yet."
            }
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
 * The editor region's scrolling, which is not one answer.
 *
 * **Browse owns its own.** It is a tab strip and a breadcrumb pinned to the top
 * edge with a document filling the rest, and the document is a textarea that
 * scrolls itself. Wrapping that in a page scroller puts a second scrollbar
 * around the first and lets the strip slide out of view — which is the shape
 * this whole rebuild exists to remove.
 *
 * **Everything else scrolls as a page.** Map, Connections and Settings are
 * documents of stacked cards with no internal scroller of their own, and they
 * are routinely taller than the viewport.
 */
function EditorRegion({
  browse,
  failure,
  tabs,
  onCloseTab,
  phone,
  children,
}: {
  browse: boolean;
  failure: ConsoleData["failure"];
  /** Absent on a route with no notes open, and on every non-Browse pane. */
  tabs: ReturnType<typeof useTabs> | null;
  /** Closes a tab, asking first when it holds an unsaved draft. */
  onCloseTab: (path: string) => void;
  /** Compact. Decides the document panes' measure, not which regions exist. */
  phone: boolean;
  children: ReactNode;
}) {
  /*
    The console's own subscription came back as an error rather than data. It
    reaches here as a value — `useLiveConsoleData` reads it with `useQueries` —
    where a `useQuery` would have re-thrown during render and blanked the page.
    So: say what happened, offer the one thing that helps, and keep the chrome
    around it so there is still a way out.
  */
  const banner =
    failure === null ? null : (
      <View style={styles.failure} testID="console-failure">
        <FormError
          headline={failure.headline}
          next={[failure.next, failure.detail].filter(Boolean).join(" ")}
        />
        {canReload ? (
          <View style={styles.failureActions}>
            <Button label="Reload" variant="white" onPress={reloadApp} />
          </View>
        ) : null}
      </View>
    );

  if (browse) {
    return (
      <View style={styles.browseRegion}>
        {/*
          At the very top edge of the region, not inside the document's
          padding: an inset tab strip reads as a control belonging to the note
          rather than to the frame.
        */}
        {tabs !== null && tabs.state.tabs.length > 0 ? (
          <TabStrip
            state={tabs.state}
            onActivate={tabs.activate}
            onClose={onCloseTab}
            onCloseOthers={tabs.closeOthers}
            onReopen={tabs.reopen}
          />
        ) : null}
        {banner === null ? null : <View style={styles.bannerInset}>{banner}</View>}
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.pane}
      contentContainerStyle={[styles.paneContent, phone && styles.paneContentPhone]}
    >
      {banner}
      {children}
    </ScrollView>
  );
}

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
  onSearch,
  paletteOpen,
}: {
  files: FileBrowser;
  tabs: ReturnType<typeof useTabs>;
  /** ⌘W. Asks before discarding a draft, exactly as the × does. */
  onCloseTab: (path: string) => void;
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
          case "deleteForever":
            // These act on a tree row and are raised from the tree's own menu,
            // which owns the dialogs they need. Reaching them from here would
            // mean a second copy of that dialog state living in the frame.
            // Deliberately unhandled *here*; `Explorer` binds them itself.
            return false;

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
      [files, tabs, onCloseTab, frame, onSearch],
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
  onSearch,
  onOpenTabs,
  onNewNote,
}: {
  data: ConsoleData;
  tabs: ReturnType<typeof useTabs>;
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
                badge: tabs.state.tabs.length,
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
  if (data.loading) return null;
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
      onSignOut={() => {
        void signOut().then(() => router.replace("/"));
      }}
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
function Status({ data }: { data: ConsoleData }) {
  const segments = statusSegments({
    editor: data.files.editor,
    conflictCheck: data.files.editor.conflictCheck,
    // The same words as the top bar's chip, from the same function — two call
    // sites interpolating `provider · bucket` themselves is how one of them
    // printed "dropbox · undefined".
    storageLabel: storagePillLabel(data.storage),
    now: Date.now(),
  });

  return <StatusBar segments={segments} testID="console-status" />;
}

export { Avatar };

const styles = StyleSheet.create({
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

  /** Browse fills its region and scrolls inside itself. */
  browseRegion: { flex: 1, minHeight: 0 },
  bannerInset: { paddingHorizontal: space.x7, paddingTop: space.x5 },
  /** Every other pane scrolls as a page inside the region. */
  pane: { flex: 1, minHeight: 0 },
  paneContent: {
    paddingTop: space.x6,
    paddingHorizontal: space.x7,
    paddingBottom: space.x8,
  },
  /**
   * A phone's gutter, and a phone's tail.
   *
   * 28pt either side of a 390pt screen leaves a 334pt measure for a document
   * of cards; 20 leaves 350, which is a whole word per line on the settings
   * copy. The top loses most of its padding because the chrome above it is
   * transparent now — the 24 was clearing a ruled bar that is no longer there.
   */
  paneContentPhone: {
    paddingTop: space.x3,
    paddingHorizontal: space.x5,
    paddingBottom: space.x6,
  },

  failure: { marginBottom: 18 },
  failureActions: { marginTop: 14, flexDirection: "row", gap: 14 },
});

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { Button } from "../../../features/design/components/Button";
import { Dot } from "../../../features/design/components/Dot";
import { FormError } from "../../../features/design/components/Input";
import { Pill } from "../../../features/design/components/Pill";
import { Palette } from "../../../features/design/components/Palette";
import { StatusBar } from "../../../features/design/components/StatusBar";
import { Text } from "../../../features/design/components/Text";
import { colors, space } from "../../../features/design/tokens";
import { AppFrame, useFrame } from "../../../features/app/AppFrame";
import { BottomBar } from "../../../features/console/BottomBar";
import { AccountBlock, Avatar, ConsoleRail } from "../../../features/console/ConsoleRail";
import { ConsoleDataProvider } from "../../../features/console/ConsoleDataContext";
import { TierChip } from "../../../features/console/ConsoleShell";
import { Explorer } from "../../../features/console/files/Explorer";
import { itemsFromListings } from "../../../features/console/files/palette";
import { useTabs } from "../../../features/console/files/useTabs";
import { readFocus, scopeForFocus } from "../../../features/console/keyboardScope";
import { tabAt } from "../../../features/console/files/tabs";
import { targetFolder } from "../../../features/console/files/tree";
import { TabStrip } from "../../../features/console/files/TabStrip";
import { statusSegments } from "../../../features/console/files/status";
import { atName } from "../../../features/console/format";
import {
  hrefFor,
  resolveContextRoute,
  routeForPath,
  sameRoute,
  type ConsoleRoute,
} from "../../../features/console/nav";
import { selectedContext, type ConsoleData } from "../../../features/console/types";
import { useKeymap } from "../../../features/design/useKeymap";
import type { FileBrowser } from "../../../features/console/files/browser";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";
import { canReload, reloadApp } from "../../../features/app/reload";

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
  const router = useRouter();
  const pathname = usePathname();
  const route = routeForPath(pathname);

  const resolution = resolveContextRoute({
    route,
    contexts: data.contexts,
    selectedContextId: data.selectedContextId,
    loading: data.loading,
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
  const tabs = useTabs(data.files);
  const current = selectedContext(data);
  const insideContext = route.kind === "context";
  const browsing = route.kind === "context" && route.view === "browse";
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
            // above them would be naming a scope the pane is not in.
            <View style={styles.switcher}>
              <Text variant="wsSwitch">All contexts</Text>
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
            : `All contexts, ${data.contexts.length} reachable`
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
            <StorageChip data={data} />
          </>
        }
        onSearch={insideContext ? () => setPaletteOpen(true) : undefined}
        rail={(mode) => <Rail data={data} route={route} mode={mode} />}
        explorer={
          insideContext ? (
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
          insideContext ? (
            <ConsoleBottomBar data={data} onSearch={() => setPaletteOpen(true)} />
          ) : undefined
        }
      >
        <Shortcuts
          files={data.files}
          tabs={tabs}
          onSearch={() => setPaletteOpen(true)}
          paletteOpen={paletteOpen || treeOverlay}
        />
        <EditorRegion
          browse={browsing}
          failure={data.failure}
          tabs={browsing ? tabs : null}
        >
          <Slot />
        </EditorRegion>

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
  children,
}: {
  browse: boolean;
  failure: ConsoleData["failure"];
  /** Absent on a route with no notes open, and on every non-Browse pane. */
  tabs: ReturnType<typeof useTabs> | null;
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
            onClose={tabs.close}
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
    <ScrollView style={styles.pane} contentContainerStyle={styles.paneContent}>
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
  onSearch,
  paletteOpen,
}: {
  files: FileBrowser;
  tabs: ReturnType<typeof useTabs>;
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
            tabs.close(tabs.state.activePath);
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
      [files, tabs, frame, onSearch],
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
function ConsoleBottomBar({ data, onSearch }: { data: ConsoleData; onSearch: () => void }) {
  const frame = useFrame();
  const files = data.files;
  // The same rule the explorer's own `+` uses, from the same function: a
  // selected *folder* is the destination, anything else means its parent.
  const folder = targetFolder(files.listings, files.selectedPath);

  return (
    <BottomBar
      actions={[
        {
          id: "files",
          label: frame.state.drawerOpen ? "Close the file tree" : "Open the file tree",
          glyph: "\u2630",
          title: "Files",
          onPress: frame.toggleExplorer,
        },
        { id: "search", label: "Search notes", glyph: "\u2315", title: "Search", onPress: onSearch },
        /*
          Absent, not dimmed. `BottomBar` argues that a fixed strip must not
          move items out from under a thumb, and that is right for Save, which
          is unavailable for a moment. `canEdit` is not a moment — it is the
          whole console, for the whole session — and `menu.ts` states the rule
          for exactly this case: read-only means the control is **gone**, not
          present and refusing.
        */
        ...(files.canEdit
          ? [
              {
                id: "new",
                label: "New note",
                glyph: "\uff0b",
                title: "New",
                onPress: () => files.createNote(folder, "Untitled"),
              },
            ]
          : []),
        {
          id: "save",
          label: "Save this note",
          glyph: "\u2713",
          title: "Save",
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
 */
function StorageChip({ data }: { data: ConsoleData }) {
  if (data.loading) return null;
  const noBucket = data.storage === null;

  return (
    <Pill
      tone={noBucket ? "warn" : "neutral"}
      leading={noBucket ? <Dot tone="warn" /> : undefined}
    >
      {noBucket
        ? "no bucket connected"
        : `${shortProvider(data.storage!.provider)} · ${data.storage!.bucket}`}
    </Pill>
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
  const personal = data.contexts.find((context) => context.kind === "personal");

  return (
    <AccountBlock
      // The handle is the identity in this product — a name addresses the sole
      // owner of the personal context it names — so it is what the account
      // block says rather than an email we would have to fetch separately.
      name={personal ? atName(personal.slug) : "Signed in"}
      detail={data.ingestionAddress}
      initial={data.avatarInitial}
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
    storageLabel:
      data.storage === null
        ? null
        : `${shortProvider(data.storage.provider)} · ${data.storage.bucket}`,
    now: Date.now(),
  });

  return <StatusBar segments={segments} testID="console-status" />;
}

/** "Cloudflare R2" reads as "R2" in a chip that has to fit beside a name. */
function shortProvider(provider: string): string {
  if (/r2/i.test(provider)) return "R2";
  if (/s3/i.test(provider)) return "S3";
  if (/b2|backblaze/i.test(provider)) return "B2";
  return provider;
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

  failure: { marginBottom: 18 },
  failureActions: { marginTop: 14, flexDirection: "row", gap: 14 },
});

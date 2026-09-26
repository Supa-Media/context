import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Platform, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { AppFrame } from "../app/AppFrame";
import { densityFor } from "../app/frame";
import { WorkspaceMark } from "../console/WorkspaceMark";
import { Explorer } from "../console/files/Explorer";
import { TabStrip } from "../console/files/TabStrip";
import { baseName, displayName, displayPath } from "../console/files/paths";
import { emptyTabs, tabsReducer } from "../console/files/tabs";
import type { PaletteItem } from "../console/files/palette";
import { TextLink } from "../design/components/TextLink";
import { Palette } from "../design/components/Palette";
import { StatusBar } from "../design/components/StatusBar";
import { Text } from "../design/components/Text";
import { pointerType as t } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import {
  BUILT_IN_SITE,
  HOME_WORKSPACE_LABEL,
  MISSING_PAGE_MARKDOWN,
  homeLink,
  homeTree,
  liveHomeTree,
  pageParam,
  routeFromParam,
} from "./homeSite";
import { HomeEditor, HomePage } from "./HomePage";
import { useHomeSite } from "./useHomeSite";
import { useLocalFileBrowser } from "./useLocalFileBrowser";

/**
 * The homepage, as the app itself: the real frame, tree, tabs, ⌘K, editor and
 * status bar, on an `@context` workspace whose notes are the website.
 *
 * The notes are `@context-lc`'s `website/` folder, and the tree is that folder
 * exactly, so the front page is edited like any note. The router puts the site
 * in the page's HTML, so the first paint is the site and nothing is swapped in
 * after it (`useHomeSite`); when the site is off or unreachable the built-in
 * copy (`builtInPages.ts`) is drawn for the whole visit instead. The open page
 * is `?page=` in the address, so a link to `/?page=pricing` opens Pricing and
 * back works.
 *
 * A visitor can write in it the way they would in their own workspace: every
 * note opens in the editor, and notes and folders can be made, renamed, moved
 * and deleted.
 * All of it happens in this tab only (`useLocalFileBrowser`), and a reload is
 * the site again. A note they made has no address, so opening one leaves the
 * address where it was.
 */
/** The built-in tree: the same every visit, so it is built once. */
const BUILT_IN = homeTree(BUILT_IN_SITE);
const NOTHING = liveHomeTree([]);

export function HomeShell() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const auth = useConvexAuth();
  const params = useLocalSearchParams<{ page?: string | string[] }>();
  const routePath = routeFromParam(params.page);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const source = useHomeSite();
  const site = source.kind === "live" ? source.snapshot.pages : null;

  const home = useMemo(
    () => (source.kind === "builtIn" ? BUILT_IN : site === null ? NOTHING : liveHomeTree(site)),
    [source.kind, site],
  );

  const [tabs, dispatch] = useReducer(tabsReducer, emptyTabs);
  const local = useLocalFileBrowser(home, "home", routePath, {
    onMoved: (moves) => {
      for (const [from, to] of moves) dispatch({ type: "renamed", from, to });
    },
    onRemoved: (paths) => {
      for (const path of paths) dispatch({ type: "removed", path });
    },
  });
  const browser = local.files;
  const activePath = browser.selectedPath !== null && local.notes[browser.selectedPath] !== undefined
    ? browser.selectedPath
    : null;
  useEffect(() => {
    if (activePath !== null) dispatch({ type: "opened", path: activePath, mode: "pinned" });
  }, [activePath]);

  // With no note open: nothing while the site is on its way or after the
  // visitor deleted what was open, and the shell's own page for an address
  // the site does not have.
  const emptyMarkdown =
    source.kind === "waiting" || (local.touched && local.pathOf(routePath) === undefined)
      ? ""
      : MISSING_PAGE_MARKDOWN;

  // A push, not `setParams`: that replaces the entry, and Back then left the
  // site instead of going to the page before.
  const [notesOpen, setNotesOpen] = useState(false);
  const { routeOf, pathOf } = local;
  const openRoute = useCallback(
    (next: string) => {
      setNotesOpen(false);
      const path = pathOf(next);
      if (path !== undefined) browser.select(path);
      if (next === routePath) return;
      const page = pageParam(next);
      router.push(page === undefined ? "/" : { pathname: "/", params: { page } });
    },
    [browser, pathOf, routePath, router],
  );
  const openPath = useCallback(
    (path: string) => {
      const route = routeOf(path);
      if (route !== undefined) return openRoute(route);
      // A note the visitor made has no page, so the address stays put.
      setNotesOpen(false);
      browser.select(path);
    },
    [browser, openRoute, routeOf],
  );

  const files = useMemo(
    () => ({
      ...browser,
      select: (path: string) => {
        if (local.notes[path] !== undefined) openPath(path);
        else browser.toggleFolder(path);
        return true;
      },
    }),
    [browser, local.notes, openPath],
  );

  const followLink = useCallback(
    (href: string) => {
      const link = homeLink(href);
      if (link === null) return;
      if (link.kind === "app") router.push(link.href as never);
      else openRoute(link.routePath);
    },
    [openRoute, router],
  );

  const [paletteOpen, setPaletteOpen] = useState(false);
  useSearchShortcut(() => setPaletteOpen(true));
  const paletteItems = useMemo<PaletteItem[]>(
    () =>
      Object.keys(local.notes).map((path) => ({
        id: path,
        label: home.pages.get(path)?.title ?? displayName(baseName(path)),
        detail: path.includes("/") ? displayPath(path.slice(0, path.lastIndexOf("/"))) : undefined,
        kind: "note" as const,
      })),
    [home, local.notes],
  );

  const explorer = <Explorer files={files} contextLabel={HOME_WORKSPACE_LABEL} />;
  const trailing = auth.isAuthenticated ? null : (
    <View style={styles.actions}>
      <TextLink label="Sign in" onPress={() => router.push("/login")} testID="home-sign-in" />
    </View>
  );
  const switcher = (
    <View style={styles.switcher} testID="home-switcher">
      <WorkspaceMark label={HOME_WORKSPACE_LABEL} tone="ok" />
      <Text variant="body" style={styles.switcherLabel}>
        {HOME_WORKSPACE_LABEL}
      </Text>
    </View>
  );
  const noteCount = Object.keys(local.notes).length;

  return (
    <View style={styles.ground}>
      <AppFrame
        lead={switcher}
        accountSlot={<NotesPill open={notesOpen} onToggle={() => setNotesOpen((open) => !open)} />}
        topTrailing={trailing}
        onSearch={() => setPaletteOpen(true)}
        tabs={
          tabs.tabs.length === 0 ? undefined : (
            <TabStrip
              state={{ ...tabs, activePath }}
              onActivate={openPath}
              onClose={(path) => {
                dispatch({ type: "closed", path });
                if (path === activePath) {
                  const rest = tabs.tabs.filter((tab) => tab.path !== path);
                  const next = rest[rest.length - 1]?.path;
                  if (next !== undefined) openPath(next);
                }
              }}
              onCloseOthers={(path) => dispatch({ type: "closedOthers", path })}
              onCloseToRight={(path) => dispatch({ type: "closedToRight", path })}
              onReopen={() => dispatch({ type: "reopened" })}
            />
          )
        }
        explorer={explorer}
        status={
          <StatusBar
            segments={[
              { id: "notes", text: `${noteCount} ${noteCount === 1 ? "note" : "notes"}`, tone: "quiet" },
              {
                id: "storage",
                text: source.kind === "live" ? "Live from website/" : "Plain Markdown",
                tone: "ok",
                pip: true,
              },
            ]}
            testID="home-status"
          />
        }
      >
        {compact && notesOpen ? (
          <View style={styles.notes} testID="home-notes-page">
            {explorer}
          </View>
        ) : activePath !== null ? (
          // Keyed by note, so a new one opens at its top rather than at the
          // last one's scroll position.
          <HomeEditor key={activePath} files={browser} compact={compact} onOpenNote={openPath} />
        ) : (
          <HomePage key={routePath} markdown={emptyMarkdown} compact={compact} onLink={followLink} />
        )}
      </AppFrame>
      {paletteOpen ? (
        <Palette
          items={paletteItems}
          placeholder="Search @context"
          onChoose={(item) => {
            setPaletteOpen(false);
            openPath(item.id);
          }}
          onDismiss={() => setPaletteOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * The phone's way to the other pages: the workspace pill, as in the app. A
 * phone has no tree column (`frame.ts`: compact has no left panel), so the
 * pill swaps the note for the tree, and picking a page swaps it back.
 */
function NotesPill({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "Back to the page" : `Open the notes in ${HOME_WORKSPACE_LABEL}`}
      aria-expanded={open}
      onPress={onToggle}
      style={styles.pill}
      testID="home-notes"
    >
      <WorkspaceMark label={HOME_WORKSPACE_LABEL} tone="ok" />
      <Text variant="body" style={styles.switcherLabel}>
        {HOME_WORKSPACE_LABEL}
      </Text>
      <Text variant="body" style={styles.caret} aria-hidden>
        {open ? "▴" : "▾"}
      </Text>
    </Pressable>
  );
}

/** ⌘K / Ctrl+K, on the web, as in the app. */
function useSearchShortcut(open: () => void) {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.pageSurface },
    actions: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 8 },
    switcher: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 6 },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 12,
      borderRadius: 22,
      backgroundColor: colors.chromeSurface,
      borderWidth: 1,
      borderColor: colors.line,
    },
    notes: { flex: 1, paddingTop: 72, backgroundColor: colors.pageSurface },
    caret: { color: colors.muted, fontSize: t.meta },
    switcherLabel: { color: colors.text, fontSize: t.ui, fontWeight: "500" },
  });

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Platform, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { AppFrame } from "../app/AppFrame";
import { ScreenScroll } from "../app/Screen";
import { densityFor } from "../app/frame";
import { landingCtaHref, landingCtaLabel } from "../auth/redirect";
import { WorkspaceMark } from "../console/WorkspaceMark";
import { Explorer } from "../console/files/Explorer";
import { TabStrip } from "../console/files/TabStrip";
import { emptyTabs, tabsReducer } from "../console/files/tabs";
import { useStaticFileBrowser } from "../console/files/useDemoFileBrowser";
import type { PaletteItem } from "../console/files/palette";
import { Button } from "../design/components/Button";
import { TextLink } from "../design/components/TextLink";
import { Palette } from "../design/components/Palette";
import { StatusBar } from "../design/components/StatusBar";
import { Text } from "../design/components/Text";
import { leading, pointerType as t } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { noteTitle, parseNote } from "../share/markdown";
import { NoteBody } from "../share/NoteBody";
import {
  HOME_WORKSPACE_LABEL,
  homeLink,
  homeTree,
  pageParam,
  routeFromParam,
} from "./homeSite";
import { useHomeSite } from "./useHomeSite";

/**
 * The homepage, as the app itself: the real frame, tree, tabs, ⌘K and status
 * bar, on a read-only `@context` workspace whose notes are the website.
 *
 * The pages are the `website/` folder of `HOME_SITE_HANDLE`, read live, so the
 * homepage is edited like any note. Until that site is on, the built-in copy
 * is drawn instead (`useHomeSite`). The open page is `?page=` in the address,
 * so a link to `/?page=pricing` opens Pricing and back works.
 *
 * Nothing here can write. The browser is the static one the demo console uses,
 * whose `canEdit` is false, so no editing control is ever drawn; the one hint
 * that this is not a workspace you can type in is the status bar's first
 * segment, and the line under the title if somebody tries.
 */
export function HomeShell() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const auth = useConvexAuth();
  const params = useLocalSearchParams<{ page?: string | string[] }>();
  const routePath = routeFromParam(params.page);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const { site, markdown, live } = useHomeSite(routePath);

  // The tree changes when the list of pages does, not when one of them loads:
  // a new tree resets what is expanded, as switching workspace does.
  const shape = site.map((page) => `${page.routePath}\u0001${page.title}`).join("\u0002");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const home = useMemo(() => homeTree(site), [shape]);
  const browser = useStaticFileBrowser(home.tree, "home");

  const [tabs, dispatch] = useReducer(tabsReducer, emptyTabs);
  const activePath = home.paths.get(routePath) ?? null;
  useEffect(() => {
    if (activePath !== null) dispatch({ type: "opened", path: activePath, mode: "pinned" });
  }, [activePath]);

  // A push, not `setParams`: that replaces the entry, and Back then left the
  // site instead of going to the page before.
  const [notesOpen, setNotesOpen] = useState(false);
  const openRoute = useCallback(
    (next: string) => {
      setNotesOpen(false);
      const page = pageParam(next);
      router.push(page === undefined ? "/" : { pathname: "/", params: { page } });
    },
    [router],
  );
  const openPath = useCallback(
    (path: string) => {
      const page = home.pages.get(path);
      if (page !== undefined) openRoute(page.routePath);
    },
    [home, openRoute],
  );

  const files = useMemo(
    () => ({
      ...browser,
      selectedPath: activePath,
      select: (path: string) => {
        if (home.pages.has(path)) openPath(path);
        else browser.toggleFolder(path);
        return true;
      },
    }),
    [browser, activePath, home, openPath],
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
      [...home.pages].map(([path, page]) => ({
        id: path,
        label: page.title,
        detail: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined,
        kind: "note" as const,
      })),
    [home],
  );

  const explorer = <Explorer files={files} contextLabel={HOME_WORKSPACE_LABEL} />;
  const cta = landingCtaLabel(auth);
  const trailing = (
    <View style={styles.actions}>
      {auth.isAuthenticated || compact ? null : (
        <TextLink label="Sign in" onPress={() => router.push("/login")} testID="home-sign-in" />
      )}
      <Button
        variant="accent"
        style={styles.cta}
        label={compact ? (auth.isAuthenticated ? "Open" : "Start") : cta}
        accessibilityLabel={cta}
        onPress={() => router.push(landingCtaHref(auth) as never)}
        testID="home-cta"
      />
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

  return (
    <View style={styles.ground}>
      <AppFrame
        switcher={switcher}
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
              { id: "mode", text: "Read only", tone: "quiet" },
              { id: "notes", text: `${home.pages.size} notes`, tone: "quiet" },
              {
                id: "storage",
                text: live ? "Live from website/" : "Plain Markdown",
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
        ) : (
          // Keyed by page, so a new page opens at its top rather than at the
          // last one's scroll position.
          <Page key={routePath} markdown={markdown} compact={compact} onLink={followLink} />
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

/** The open note: its title where the editor draws one, and the body beneath. */
function Page({
  markdown,
  compact,
  onLink,
}: {
  markdown: string | null;
  compact: boolean;
  onLink: (href: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [typed, setTyped] = useState(false);
  const { title, blocks } = useMemo(() => {
    if (markdown === null) return { title: null, blocks: [] };
    const parsed = parseNote(markdown).blocks;
    const own = noteTitle(parsed);
    return own === null ? { title: null, blocks: parsed } : { title: own, blocks: parsed.slice(1) };
  }, [markdown]);
  useEffect(() => setTyped(false), [markdown]);
  const onType = useCallback(() => setTyped(true), []);
  useTypingHint(onType);

  return (
    <ScreenScroll style={styles.page} contentContainerStyle={[styles.pageContent, compact && styles.pageContentCompact]} testID="home-page">
      <View style={styles.column}>
        {title === null ? null : (
          <Text variant="body" role="heading" aria-level={1} style={styles.title}>
            {title}
          </Text>
        )}
        {typed ? (
          <Text variant="body" style={styles.hint} testID="home-read-only">
            This workspace is read only. Make your own to start writing.
          </Text>
        ) : null}
        <NoteBody blocks={blocks} onSiteLink={onLink} />
      </View>
    </ScreenScroll>
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

/**
 * A printable key pressed outside any field: somebody tried to type into the
 * note. Answered with one quiet line rather than silence, which reads as broken.
 */
function useTypingHint(onType: () => void) {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      onType();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onType]);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.pageSurface },
    actions: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 8 },
    // The accent button at the top bar's scale rather than the hero's.
    cta: { paddingVertical: 7, paddingHorizontal: 16 },
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
    page: { flex: 1, backgroundColor: colors.pageSurface },
    pageContent: { paddingHorizontal: 24, paddingTop: 48, paddingBottom: 96 },
    // Below the phone's floating top row, which the page scrolls behind.
    pageContentCompact: { paddingTop: 80 },
    column: { width: "100%", maxWidth: 680, alignSelf: "center", gap: 16 },
    title: {
      fontSize: t.title,
      lineHeight: leading(t.title, 1.2),
      fontWeight: "600",
      color: colors.text,
      letterSpacing: -0.4,
    },
    hint: { fontSize: t.ui, color: colors.muted },
  });

import { useCallback, useMemo, useState } from "react";
import { Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import type { CastStep } from "@context/shared";
import { densityFor } from "../app/frame";
import { ConsoleFrame } from "../console/ConsoleFrame";
import type { NoteRename } from "../console/files/browser/contract";
import type { VisitorMeetings } from "../console/types";
import type { ToastSpec } from "../design/components/Toast";
import { meetings } from "../meetings/controller";
import type { ConsoleRouter } from "../console/layout/types";
import type { ConsoleRoute } from "../console/nav";
import { BrowsePane } from "../console/panes/BrowsePane";
import { CustomEmojiContext } from "../console/emoji/context";
import { usePublishedEmoji } from "../console/emoji/published";
import { writeClipboard } from "../design/clipboard";
import { useThemedStyles, type Colors } from "../design/theme";
import type { EmojiPictures } from "../share/emojiPictures";
import { NO_PUBLISHED_IMAGES } from "../share/publishedImages";
import {
  BUILT_IN_SITE,
  MISSING_PAGE_MARKDOWN,
  homeLink,
  homeTree,
  liveHomeTree,
  noteLinkHref,
  pageHref,
  pageParam,
  routeFromParam,
} from "./homeSite";
import { HomePage } from "./HomePage";
import { castSite } from "./cast/castSite";
import { useHomeCast } from "./cast/useHomeCast";
import { castPeople, withDemoPeople } from "./cast/demoPeople";
import { HOME_MEETING_STOPPED, homeMeetingDestination } from "./meeting/homeMeetings";
import { HomeMeetingHost } from "./meeting/HomeMeetingHost";
import { useHomeMeetings } from "./meeting/useHomeMeetings";
import { useHomeSite } from "./useHomeSite";
import { useLocalFileBrowser } from "./useLocalFileBrowser";
import { HOME_CONTEXT, useVisitorConsoleData } from "./useVisitorConsoleData";

const NO_EMOJI: EmojiPictures = {};
const NO_COLORS: ReadonlyMap<string, string> = new Map();

/**
 * The homepage, as the app itself: the console's own frame (`ConsoleFrame`)
 * over an `@context` workspace whose notes are the website.
 *
 * **It is the same frame, not a copy of it.** The tree, tabs, `‹ ›`, the
 * note's breadcrumb with its eye and Share, the status bar, the `+` and the
 * account button at the foot of the tree are all the console's, drawn from
 * `ConsoleData` this file assembles (`useVisitorConsoleData`). The homepage
 * used to compose `AppFrame` itself and every piece it did not copy was
 * missing (the owner's report, 2026-09-26), so a change to the console's shell
 * now reaches this page in the same commit, which is the point.
 *
 * The notes are `@context-lc`'s `website/` folder, and the tree is that folder
 * exactly, so the front page is edited like any note. The router puts the site
 * in the page's HTML, so the first paint is the site and nothing is swapped in
 * after it (`useHomeSite`); when the site is off or unreachable the built-in
 * copy (`builtInPages.ts`) is drawn for the whole visit instead. The open page
 * is `?page=` in the address, so a link to `/?page=pricing` opens Pricing and
 * back works. A page's shared address is the clean one, `/pricing`, which
 * `app/[handle]` hands to this page as `?page=pricing` (`homePagePath`).
 *
 * A visitor can write in it the way they would in their own workspace: every
 * note opens in the editor, and notes, drawings and folders can be made,
 * renamed, moved and deleted. All of it happens in this tab only
 * (`useLocalFileBrowser`), and a reload is the site again. A note they made has
 * no address, so opening one leaves the address where it was.
 */
/** The built-in tree: the same every visit, so it is built once. */
const BUILT_IN = homeTree(BUILT_IN_SITE);
const NOTHING = liveHomeTree([]);

/** Always the one workspace's Browse: the homepage has no other console page. */
const HOME_ROUTE: ConsoleRoute = { kind: "context", slug: HOME_CONTEXT.slug, view: "browse" };
const NO_PARAMS = { openSettingsSection: null, checkoutReturn: null, connectAgent: null };

export function HomeShell() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const auth = useConvexAuth();
  // Global: this is drawn by `(home)/_layout`, whose own params are not the page.
  const params = useGlobalSearchParams<{ page?: string | string[] }>();
  const routePath = routeFromParam(params.page);
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const source = useHomeSite();
  const live = source.kind === "live" ? source.snapshot.pages : null;
  const emoji = usePublishedEmoji(source.kind === "live" ? source.snapshot.emoji : NO_EMOJI);
  // The pages without their cast blocks, and what each one's cast does.
  const cast = useMemo(() => (live === null ? null : castSite(live)), [live]);
  const site = cast === null ? null : cast.pages;

  const home = useMemo(
    () => (source.kind === "builtIn" ? BUILT_IN : site === null ? NOTHING : liveHomeTree(site)),
    [source.kind, site],
  );
  // Each page's cast, by the note it is in the tree.
  const scripts = useMemo(() => {
    const byPath = new Map<string, readonly CastStep[]>();
    for (const [route, steps] of cast?.scripts ?? []) {
      const path = home.paths.get(route);
      if (path !== undefined) byPath.set(path, steps);
    }
    return byPath;
  }, [cast, home]);

  /*
    A note the visitor renamed, for the console's tabs to follow — the live
    browser's `renamed`, which `useTabs` reads. The last move of a batch is the
    one a tab could be open on; a tab whose note moved with a folder closes the
    way it does in the console, when the listing stops holding it.
  */
  const [renamed, setRenamed] = useState<NoteRename | null>(null);
  const local = useLocalFileBrowser(home, HOME_CONTEXT.id, routePath, {
    onMoved: (moves) => {
      const last = moves[moves.length - 1];
      if (last !== undefined) setRenamed({ id: Date.now(), from: last[0], to: last[1] });
    },
  }, source.kind === "live" ? source.snapshot.images : NO_PUBLISHED_IMAGES);
  const browser = local.files;
  const { routeOf, pathOf, notes } = local;

  /*
    The people and agents the owner scripted into the site's pages, drawn by
    the console's own presence: carets and the chip in the note, squares in
    the tree, the agents line at its foot. Web only, where the editor that
    binds a shared document is.
  */
  // The people on the bar at the sidebar's foot: the cast's own, and a crowd.
  const demoPeople = useMemo(
    () => castPeople([...(cast?.scripts.values() ?? [])].flat(), cast?.colors ?? NO_COLORS),
    [cast],
  );
  const castRoom = useHomeCast({
    enabled: Platform.OS === "web" && cast !== null,
    scripts,
    colors: cast?.colors ?? NO_COLORS,
    selectedPath: browser.selectedPath,
    notes,
    pages: home.pages,
    addNote: local.addNote,
  });

  // A push, not `setParams`: that replaces the entry, and Back then left the
  // site instead of going to the page before.
  const openRoute = useCallback(
    (next: string) => {
      const path = pathOf(next);
      if (path !== undefined) browser.select(path);
      if (next === routePath) return;
      const page = pageParam(next);
      router.push(page === undefined ? "/" : { pathname: "/", params: { page } });
    },
    [browser, pathOf, routePath, router],
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

  /*
    Every way the console opens something ends here — the tree, a tab, ⌘K,
    `‹ ›`, a link in a note (`tabs.follow`) — so this is where the homepage's
    address is kept. A page of the site pushes `?page=`; a note the visitor
    made has no page and opens where it is; a folder opens as the console's
    folder page. Anything else was a link to somewhere that is not a note
    here, and goes to the address it was written as (`noteLinkHref`), never
    to a new empty note to type into.
  */
  const files = useMemo(
    () => ({
      ...browser,
      select: (path: string) => {
        if (notes[path] !== undefined) {
          const route = routeOf(path);
          if (route !== undefined) openRoute(route);
          else browser.select(path);
          return true;
        }
        if (browser.listings[path] !== undefined) return browser.select(path);
        followLink(noteLinkHref(path));
        return false;
      },
    }),
    [browser, notes, routeOf, openRoute, followLink],
  );

  /*
    Recording a meeting, into this tab (`features/home/meeting`). The console's
    own + and panel start and show it; the first one writes `inbox/meetings`.
    A phone has no panel, so the meeting's own screen is drawn over the page,
    and the note opens in the tree once it has been written.
  */
  const [notice, setNotice] = useState<ToastSpec | null>(null);
  useHomeMeetings(local.putNote);
  const [phoneMeeting, setPhoneMeeting] = useState<string | null>(null);
  const stoppedAtLimit = useCallback(
    () => setNotice({ id: `home-meeting-${Date.now()}`, message: HOME_MEETING_STOPPED }),
    [],
  );
  const openMeetingNote = useCallback((path: string) => browser.select(path), [browser]);
  const visitorMeetings = useMemo<VisitorMeetings | undefined>(
    () =>
      Platform.OS !== "web"
        ? undefined
        : {
            destination: homeMeetingDestination(HOME_CONTEXT.slug),
            openNote: (path) => browser.select(path),
            showOnPhone: (id) => {
              const record = meetings.getSnapshot().records.find((candidate) => candidate.session.id === id);
              const path = record?.session.notePath ?? null;
              if (path !== null) browser.select(path);
              else setPhoneMeeting(id);
            },
          },
    [browser],
  );

  const data = useVisitorConsoleData(
    files,
    {
      signedIn: auth.isAuthenticated,
      signIn: () => router.push("/login"),
      openApp: () => router.push("/console"),
      createAccount: () => router.push("/login"),
      linkFor: (path) => {
        const route = routeOf(path);
        if (route === undefined) return null;
        const origin = Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "";
        // `/pricing`, the address a person would type (`app/[handle]` opens it).
        return `${origin}${pageHref(route)}`;
      },
      copy: writeClipboard,
      meetings: visitorMeetings,
    },
    renamed,
    withDemoPeople(castRoom.agents, demoPeople),
    notice === null ? null : { toast: notice, dismiss: () => setNotice(null) },
  );

  /*
    The console's navigation, for a page with no console routes behind it.
    The frame's pieces address `/console/…` (a context's page, Settings, the
    search page) and a visitor has none of them, so those are dropped here
    rather than sent to a sign-in wall mid-click; every other address is the
    router's own. `setParams` is the settings overlay's and a quick note's,
    and there is no query of the console's on this page to set.
  */
  const visitorRouter = useMemo<ConsoleRouter>(() => {
    const isConsole = (href: unknown) => typeof href === "string" && href.startsWith("/console");
    return {
      ...router,
      push: (href, options) => (isConsole(href) ? undefined : router.push(href, options)),
      replace: (href, options) => (isConsole(href) ? undefined : router.replace(href, options)),
      setParams: () => {},
    };
  }, [router]);

  // With nothing open: nothing while the site is on its way, and the shell's
  // own page for an address the site does not have.
  const missing = source.kind === "waiting" || (!local.touched && pathOf(routePath) === undefined);

  return (
    <View style={styles.ground}>
      <ConsoleFrame
        data={data}
        route={HOME_ROUTE}
        pathname="/"
        router={visitorRouter}
        params={NO_PARAMS}
      >
        {browser.selectedPath === null && missing ? (
          <HomePage
            key={routePath}
            markdown={source.kind === "waiting" ? "" : MISSING_PAGE_MARKDOWN}
            compact={compact}
            onLink={followLink}
          />
        ) : (
          // The site's own emoji, over the console's library (which a visitor
          // has none of), so a published page draws what its author typed.
          <CustomEmojiContext.Provider value={emoji}>
            <BrowsePane data={data} presence={castRoom.presence} />
          </CustomEmojiContext.Provider>
        )}
      </ConsoleFrame>
      {visitorMeetings === undefined ? null : (
        <HomeMeetingHost
          phone={compact}
          shown={phoneMeeting}
          show={setPhoneMeeting}
          openNote={openMeetingNote}
          onStoppedAtLimit={stoppedAtLimit}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.pageSurface },
  });

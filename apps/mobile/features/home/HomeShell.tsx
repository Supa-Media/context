import { useCallback, useMemo, useRef, useState } from "react";
import { JoinCard, useHomeJoin } from "../auth/JoinCard";
import { JoinSlotPortal } from "./JoinSlotPortal";
import { useJoinSlot } from "./useJoinSlot";
import { Platform, StyleSheet, View, useWindowDimensions } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { hasWebsiteJoin, type CastStep } from "@context/shared";
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
import { useThemedStyles, type Colors, type Shadows } from "../design/theme";
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
import { useStudioStage } from "./cast/useStudioStage";
import { castPeople, withDemoPeople } from "./cast/demoPeople";
import { HOME_MEETING_STOPPED, homeMeetingDestination } from "./meeting/homeMeetings";
import { HomeMeetingHost } from "./meeting/HomeMeetingHost";
import { useHomeMeetings } from "./meeting/useHomeMeetings";
import { useHomeSite } from "./useHomeSite";
import { useLocalFileBrowser } from "./useLocalFileBrowser";
import { useLocalFolderLists } from "./useLocalFolderLists";
import { CastChat, CastWorkspaceBar } from "./cast/CastChat";
import { CastPhoneComments } from "./cast/CastPhoneComments";
import { followWorkspace, scenePage, useCastPeek } from "./cast/castCamera";
import { PANE_SCALE, paneMotion, paneZoom, phoneBoxes, phoneView, usePhoneSwitch } from "./cast/PhoneDesk";
import { useReducedMotion } from "../design/useReducedMotion";
import { FrameBare, FrameFillsParent } from "../app/appFrame/fillParent";
import { viewportHeight } from "../design/css";
import { radii, space } from "../design/tokens";
import { findPath } from "./castWorkspace";
import { HOME_CONTEXT, useVisitorConsoleData } from "./useVisitorConsoleData";

const NO_EMOJI: EmojiPictures = {};
/** Links that mean "let me in": the page's own email field answers them. */
const JOIN_ROUTES: ReadonlySet<string> = new Set(["/login", "/workspace/new"]);
const NO_COLORS: ReadonlyMap<string, string> = new Map();

/** A route-keyed map of the site's scenes, keyed by where each page is in the tree. */
function byTreePath<T>(byRoute: ReadonlyMap<string, T> | undefined, paths: ReadonlyMap<string, string>): Map<string, T> {
  const byPath = new Map<string, T>();
  for (const [route, value] of byRoute ?? []) {
    const path = paths.get(route);
    if (path !== undefined) byPath.set(path, value);
  }
  return byPath;
}

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
  const windowWidth = useWindowDimensions().width;
  const compact = densityFor(windowWidth) === "compact";
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
  const paces = useMemo(() => byTreePath(cast?.paces, home.paths), [cast, home]);
  const chatSetups = useMemo(() => byTreePath(cast?.chats, home.paths), [cast, home]);

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
  // The console's folder pages and list blocks, reading the visitor's copy of the site.
  const folderLists = useLocalFolderLists(notes, local.writeText);

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
  // Inside the cast studio: the show waits for it, and plays on its clock.
  const stage = useStudioStage();

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

  // On a phone Context shows each change's folder for a moment, since a note
  // filling it would hide the folders being made.
  const phoneDesk = useRef(false);
  const { peek, peeking } = useCastPeek({ enabled: () => phoneDesk.current, selected: browser.selectedPath, select: browser.select });
  const workspace = useMemo(() => followWorkspace(local.cast, peek), [local.cast, peek]);
  const castRoom = useHomeCast({
    stage,
    enabled: Platform.OS === "web" && cast !== null,
    scripts,
    paces,
    colors: cast?.colors ?? NO_COLORS,
    // A folder up for a moment is not the scene leaving its page.
    selectedPath: scenePage(browser.selectedPath, peeking),
    notes,
    pages: home.pages,
    addNote: local.addNote,
    addNoteIn: workspace.addNoteIn,
    workspace,
    folderNamed: (name) => findPath({ listings: browser.listings, notes }, name, "folder"),
    chatSetups,
    // A scene's `opens:` goes where a click on that page would.
    open: (path) => {
      const route = routeOf(path);
      if (route !== undefined) openRoute(route);
      else browser.select(path);
    },
  });

  /*
    Invite-only (Dev2, 2026-09-28): signing in and joining the waitlist are one
    email field, and it lives in the page (`JoinCard`), where the page's
    ```join fence is (`websiteJoin.ts`) and nowhere else. A page without one
    has no field: it used to get one above the note, which on a pointer
    layout sat at the pane's corner beside the page rather than in it
    (Dev2's devlog and connect screenshots, 2026-10-03). The page's own field
    is drawn for everyone, signed in or not (Dev2, 2026-09-29): it is part of
    the page, and the page should look the same to whoever reads it. The
    account button's "Sign in or join" and every link to sign-in or a new
    workspace bring that field into view and focus it, opening the page that
    has one first (the home page before any other), instead of taking the
    visitor to another screen. Only a site with no field anywhere sends them
    to /login. Somebody already signed in follows the link.
  */
  const [joinAsk, setJoinAsk] = useState(0);
  const joinAnswered = useRef(0);
  const join = useHomeJoin(router as { replace: (href: string) => void });
  // A stage is a recording of the app, with no email field in it.
  const joinSlot = useJoinSlot();
  const showJoin = stage === null;
  const joinCard = <JoinCard flow={join} ask={joinAsk} answered={joinAnswered} />;
  const askToJoin = useCallback(() => {
    if (joinSlot === null) {
      const route = joinPage(notes, routeOf, pathOf("/"));
      if (route === undefined) {
        router.push("/login");
        return;
      }
      openRoute(route);
    }
    setJoinAsk((n) => n + 1);
  }, [joinSlot, notes, routeOf, pathOf, openRoute, router]);
  const followLink = useCallback(
    (href: string) => {
      const link = homeLink(href);
      if (link === null) return;
      if (link.kind === "app" && !auth.isAuthenticated && JOIN_ROUTES.has(link.href)) askToJoin();
      else if (link.kind === "app") router.push(link.href as never);
      else openRoute(link.routePath);
    },
    [openRoute, router, auth.isAuthenticated, askToJoin],
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

  const visitorData = useVisitorConsoleData(
    files,
    {
      signedIn: auth.isAuthenticated,
      signIn: askToJoin,
      openApp: () => router.push("/console"),
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
  const data = useMemo(() => ({ ...visitorData, folderLists }), [visitorData, folderLists]);

  /*
    A scene's chats (Dev2, 2026-09-30): beside the workspace, or over it
    until the scene cuts to it. On a phone "beside" is above, so the chat and
    the tree it is changing are both in view.
  */
  const chat = castRoom.chat;
  const chatShown = chat !== null && chat.windows.length > 0 && !chat.hidden;
  const chatPanel = !chatShown ? null : (
    <CastChat view={chat} one={compact} colors={cast?.colors ?? NO_COLORS} onClose={stage === null ? castRoom.closeChat : undefined} />
  );
  const cut = chat?.setup.layout === "cut";
  // Beside: two apps on a desk, each its own window (the approved artboard),
  // never a chat panel inside Context's frame.
  const desk = chatPanel !== null && !cut;
  // A phone shows both apps, or one at a time (`PhoneDesk.ts`); recorded for
  // Reels on the studio's stage, inside Instagram's safe zone.
  const phone = desk && compact;
  const view = phoneView(chat?.shows);
  const phoneSwitch = usePhoneSwitch(phone ? view : "both", useReducedMotion());
  const boxes = phoneBoxes(view, stage !== null);
  // Each change's folder comes up while Context is on screen.
  phoneDesk.current = phone && view !== "chat";

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
      {joinSlot !== null && showJoin ? (
        <JoinSlotPortal slot={joinSlot}>{joinCard}</JoinSlotPortal>
      ) : null}
      <View
        style={[
          compact ? styles.stacked : styles.beside,
          desk ? [viewportHeight(), compact ? styles.deskCompact : styles.desk] : null,
          phone && phoneSwitch.phase !== "rest" ? styles.switching : null,
        ]}
      >
        {desk && !compact ? <View style={styles.chatBeside}>{chatPanel}</View> : null}
        <View
          style={[
            styles.workspace,
            desk ? styles.window : null,
            phone ? [styles.pane, boxes.context, paneMotion("context", view, phoneSwitch, windowWidth)] : null,
          ]}
          testID={phone ? "cast-phone-context" : undefined}
        >
          {desk ? <CastWorkspaceBar /> : null}
          {/* Always these two boxes, so the frame is never remounted when a chat appears. */}
          <View style={phone ? styles.zoomBox : styles.plainBox}>
          <View style={paneZoom(phone ? PANE_SCALE.context : 1)}>
          <FrameFillsParent.Provider value={desk}>
            {/* A phone's floating buttons would cover the scene in a small window. */}
            <FrameBare.Provider value={phone}>
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
            </FrameBare.Provider>
          </FrameFillsParent.Provider>
          </View>
          {compact ? (
            <CastPhoneComments
              comments={castRoom.comments}
              keyboard={castRoom.keyboard}
              colors={cast?.colors}
              overBar={!phone}
              scale={phone ? PANE_SCALE.context : 1}
            />
          ) : null}
          </View>
        </View>
        {phone ? (
          <View style={[styles.pane, boxes.chat, paneMotion("chat", view, phoneSwitch, windowWidth)]} testID="cast-phone-chat">
            <View style={styles.plainBox}>
              <View style={paneZoom(PANE_SCALE.chat)}>{chatPanel}</View>
            </View>
          </View>
        ) : null}
      </View>
      {chatPanel !== null && cut ? (
        <View style={styles.chatOver}>
          <View style={styles.chatOverColumn}>{chatPanel}</View>
        </View>
      ) : null}
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

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.pageSurface },
    beside: { flex: 1, flexDirection: "row", minHeight: 0 },
    stacked: { flex: 1, flexDirection: "column", minHeight: 0 },
    workspace: { flex: 1, minWidth: 0, minHeight: 0 },
    desk: { padding: space.x6, gap: space.x6, backgroundColor: colors.castDesk },
    deskCompact: { position: "relative", overflow: "hidden", backgroundColor: colors.castDesk },
    switching: { backgroundColor: colors.castSwitcher },
    pane: { position: "absolute" },
    zoomBox: { flex: 1, minHeight: 0, position: "relative", overflow: "hidden" },
    plainBox: { flex: 1, minHeight: 0 },
    window: { borderRadius: radii.console, overflow: "hidden", boxShadow: shadows.window, backgroundColor: colors.pageSurface },
    chatBeside: { width: "36%", minWidth: 320, maxWidth: 468 },
    chatOver: { ...StyleSheet.absoluteFillObject, alignItems: "center", padding: space.x6, backgroundColor: colors.castDesk },
    // A reading column, the width a chat app gives its words, however wide the frame.
    chatOverColumn: { flex: 1, width: "100%", maxWidth: 760 },
  });

/** The page with the site's email field, the home page first, or `undefined` when none has one. */
function joinPage(
  notes: Readonly<Record<string, string>>,
  routeOf: (path: string) => string | undefined,
  home: string | undefined,
): string | undefined {
  const paths = Object.keys(notes).filter((path) => hasWebsiteJoin(notes[path]!) && routeOf(path) !== undefined);
  const path = home !== undefined && paths.includes(home) ? home : paths.sort()[0];
  return path === undefined ? undefined : routeOf(path);
}

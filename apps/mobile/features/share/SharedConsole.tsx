import { useCallback, useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { ConsoleFrame } from "../console/ConsoleFrame";
import type { FileBrowser } from "../console/files/browser/contract";
import { useStaticFileBrowser } from "../console/files/useDemoFileBrowser";
import type { ConsoleRouter } from "../console/layout/types";
import type { ConsoleRoute } from "../console/nav";
import { BrowsePane } from "../console/panes/BrowsePane";
import type { ConsoleContext } from "../console/types";
import { writeClipboard } from "../design/clipboard";
import { useThemedStyles, type Colors } from "../design/theme";
import { useVisitorConsoleData } from "../home/useVisitorConsoleData";
import type { SharedNote } from "./share";
import { isLoaded, sharedTree } from "./sharedTree";

/**
 * The page a shared link opens, drawn as the console itself.
 *
 * Dev2 (2026-10-09): a shared note "should look like the actual editor". So
 * this is the homepage's arrangement (`HomeShell`) over a link's reach rather
 * than the website's pages: the console's own `ConsoleFrame` and `BrowsePane`,
 * fed by the same visitor `ConsoleData`, with a read-only file browser over a
 * tree built from what the server returned (`sharedTree`). Checkboxes, people,
 * headings and code read the way they do in the editor because they are drawn
 * by it.
 *
 * ## Nothing here can write
 *
 * The file browser is `useStaticFileBrowser`, the landing page's: `canEdit` is
 * false and every mutating method is a no-op the UI renders no control for.
 * That keeps `shareReadOnly.test.ts`'s rule (a share page reaches no write)
 * true of this page as it was of the old one.
 *
 * ## What the reader learns about the workspace
 *
 * Its paths, which the server already returns, and nothing else. The
 * workspace's name is not in what `readSharedNote` answers, deliberately, so
 * the workspace here is called "Shared with you" rather than named.
 *
 * ## Opening another note
 *
 * Only the note on screen has a body. Choosing any other row (the entry note,
 * a note it links to, something inside a shared folder) asks the share page to
 * navigate there, which asks the server, exactly as following a link on the
 * old page did.
 */

export const SHARED_CONTEXT: ConsoleContext = {
  id: "shared-link",
  slug: "shared",
  displayName: "Shared with you",
  /*
    `owner` for the homepage's reason (`HOME_CONTEXT`): it is the role the
    console draws no tier chip and no "team access" band for. Neither is
    news to somebody holding a link, and the band's "notes marked private are
    not shown" would be the page describing a workspace it does not name.
    Nothing an owner can do is reachable: the browser cannot edit and the
    demo flag keeps every server-backed control out.
  */
  role: "owner",
  kind: "shared",
  status: "ok",
};

const SHARED_ROUTE: ConsoleRoute = { kind: "context", slug: SHARED_CONTEXT.slug, view: "browse" };
const NO_PARAMS = { openSettingsSection: null, checkoutReturn: null, connectAgent: null };

export function readOnlyReasonFor(note: SharedNote): string {
  return note.openToAnyone
    ? "You're reading a shared link. Only people in this workspace can change it."
    : "This was shared with you to read.";
}

export function SharedConsole({
  note,
  signedIn,
  onOpen,
  onSignIn,
}: {
  note: SharedNote;
  signedIn: boolean;
  /** Go to another note or folder the link reaches. */
  onOpen: (path: string) => void;
  /** Sign in, and come back to this address. */
  onSignIn: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const tree = useMemo(() => sharedTree(note, readOnlyReasonFor(note)), [note]);
  const base = useStaticFileBrowser(tree, SHARED_CONTEXT.id);

  const files = useMemo<FileBrowser>(
    () => ({
      ...base,
      select: (path: string) => {
        if (isLoaded(note, path)) return base.select(path);
        onOpen(path);
        return true;
      },
    }),
    [base, note, onOpen],
  );

  const linkFor = useCallback(
    () => (Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : null),
    [],
  );

  const data = useVisitorConsoleData(
    files,
    {
      signedIn,
      signIn: onSignIn,
      openApp: () => router.push("/console"),
      linkFor,
      copy: writeClipboard,
    },
    null,
    undefined,
    null,
    SHARED_CONTEXT,
  );

  /*
    The console's own links point at `/console/…` pages this reader has none
    of; they are dropped rather than sent to a sign-in wall mid-click, as the
    homepage does.
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

  return (
    <View style={styles.ground} testID="share-console">
      <ConsoleFrame data={data} route={SHARED_ROUTE} router={visitorRouter} params={NO_PARAMS}>
        <BrowsePane data={data} />
      </ConsoleFrame>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.pageSurface },
  });

import { useEffect, useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { ResolvedWebsitePage, WebsiteNavigationItem } from "@context/shared";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { leading, siteType } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { parseNote, noteTitle } from "../../share/markdown";
import { NoteBody } from "../../share/NoteBody";
import { UNDERLINE } from "../../share/siteLook";
import { PLATFORM_ORIGIN } from "../host";
import { ensureSiteSerifLoaded, siteSerif } from "../siteFonts";
import { SiteFrame, useSiteSize } from "./SiteFrame";

/**
 * What a visitor sees at a website address, for every answer the server can
 * give: the page, the members gate, or one "Nothing here".
 *
 * `off` is not a resolver answer; it is the host saying this workspace has no
 * site turned on. It draws the same "Nothing here" with no menu and no link
 * home, since there is no home to go to.
 *
 * Nothing here decides who may read what. `authentication_required` carries a
 * sign-in path the server built and validated; it is followed, never
 * assembled. `unavailable` has no reason on purpose, so there is one screen
 * for missing, draft, clashing and refused pages alike.
 */
export type WebsiteView = ResolvedWebsitePage | { kind: "off" };

export function WebsitePage({
  name,
  view,
  menu = [],
  navigate,
  signIn,
}: {
  /** The workspace's display name, which is the site's name. */
  name: string;
  view: WebsiteView;
  /**
   * The site's menu for answers that carry none (the gate, "Nothing here"):
   * the last one a page returned. Never shown when the site is off.
   */
  menu?: readonly WebsiteNavigationItem[];
  navigate: (routePath: string) => void;
  /** Follow the server's sign-in path. */
  signIn: (signInPath: string) => void;
}) {
  useEffect(ensureSiteSerifLoaded, []);
  const title = view.kind === "page" ? view.title : view.kind === "authentication_required" ? "Members only" : "Nothing here";
  useDocumentTitle(view.kind === "page" && view.routePath === "/" ? name : `${title} · ${name}`);

  const navigation = view.kind === "page" ? view.navigation : view.kind === "off" ? [] : menu;
  const current = view.kind === "page" ? view.routePath : null;
  return (
    <SiteFrame name={name} navigation={navigation} current={current} navigate={navigate} madeWith={PLATFORM_ORIGIN}>
      {view.kind === "page" ? (
        <Page title={view.title} markdown={view.markdown} home={view.routePath === "/"} />
      ) : view.kind === "authentication_required" ? (
        <Notice title="Members only" line="Sign in to read this page.">
          <Button
            variant="accent"
            label="Sign in with Context"
            onPress={() => signIn(view.signInPath)}
            testID="site-sign-in"
          />
        </Notice>
      ) : (
        <Notice title="Nothing here" line="This page doesn't exist or isn't available.">
          {view.kind === "off" ? null : <HomeLink navigate={navigate} />}
        </Notice>
      )}
    </SiteFrame>
  );
}

function Page({ title, markdown, home }: { title: string; markdown: string; home: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const size = useSiteSize();
  const { heading, blocks } = useMemo(() => {
    const parsed = parseNote(markdown).blocks;
    // A note that opens with an H1 has chosen its heading, and it is drawn in
    // the title's place; the frontmatter title then only names the tab. A
    // homepage without one draws none — the header already names the site,
    // and "Home" is a label, not copy. Any other page falls back to its title.
    const own = noteTitle(parsed);
    if (own !== null) return { heading: own, blocks: parsed.slice(1) };
    return { heading: home ? null : title, blocks: parsed };
  }, [markdown, title, home]);
  return (
    <View testID="site-page" style={[styles.stack, size === "desktop" && styles.stackDesktop]}>
      {heading === null ? null : (
        <Text variant="body" role="heading" aria-level={1} style={[styles.title, size === "phone" && styles.titlePhone, size === "desktop" && styles.titleDesktop]}>
          {heading}
        </Text>
      )}
      <NoteBody blocks={blocks} look={size === "desktop" ? "siteWide" : "site"} />
    </View>
  );
}

function Notice({ title, line, children }: { title: string; line: string; children?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice} testID="site-notice">
      <Text variant="body" role="heading" aria-level={1} style={[styles.title, styles.centred]}>
        {title}
      </Text>
      <Text variant="body" style={[styles.line, styles.centred]}>
        {line}
      </Text>
      {children}
    </View>
  );
}

function HomeLink({ navigate }: { navigate: (routePath: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="link" onPress={() => navigate("/")} testID="site-home">
      <Text variant="body" style={styles.home}>
        Go to the homepage
      </Text>
    </Pressable>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    if (typeof document !== "undefined") document.title = title;
  }, [title]);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    title: {
      fontFamily: siteSerif,
      fontWeight: "400",
      fontSize: siteType.h1,
      lineHeight: leading(siteType.h1, 1.1),
      letterSpacing: -0.6,
      color: colors.text,
      // Web only: balanced lines, so a title never ends on one stranded word.
      ...({ textWrap: "balance" } as object),
    },
    titlePhone: { fontSize: siteType.h1Phone, lineHeight: leading(siteType.h1Phone, 1.1) },
    titleDesktop: { fontSize: siteType.h1Desktop, lineHeight: leading(siteType.h1Desktop, 1.05), letterSpacing: -1.2 },
    stack: { gap: 24 },
    stackDesktop: { gap: 32 },
    notice: { alignItems: "center", alignSelf: "center", maxWidth: 360, paddingTop: 64, gap: 6 },
    centred: { textAlign: "center" },
    line: { marginTop: 14, fontSize: siteType.body, lineHeight: leading(siteType.body, 1.55), color: colors.text2, marginBottom: 22 },
    home: {
      fontSize: siteType.body,
      color: colors.text,
      textDecorationLine: "underline",
      textDecorationColor: colors.muted,
      ...UNDERLINE,
    },
  });

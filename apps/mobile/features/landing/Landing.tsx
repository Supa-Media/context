import { useEffect, useState } from "react";
import { Linking, StyleSheet, View, useWindowDimensions } from "react-native";
import { Link, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { Button, PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { clamp, fonts, layout, leading, pointerType as t, radii, tracking } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { ScreenScroll } from "../app/Screen";
import { landingCtaHref, landingCtaLabel } from "../auth/redirect";
import { ConsoleShell } from "../console/ConsoleShell";
import { BrowsePane } from "../console/panes/BrowsePane";
import { ConnectionsPane } from "../console/panes/ConnectionsPane";
import { MapPane } from "../console/panes/MapPane";
import { SettingsPane } from "../console/panes/SettingsPane";
import {
  closeSettings,
  openSettings,
  resolveContextRoute,
  MAP_ROUTE,
  type ConsoleRoute,
} from "../console/nav";
import { useDemoConsoleData } from "../console/useDemoConsoleData";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { ContinuityDemo } from "./ContinuityDemo";
import { HERO_ALSO, HERO_LINE_ONE, HERO_LINE_TWO, HERO_SUB } from "./copy";
import { heroHeadingWidth } from "./hero";

/** github.com/Supa-Media/context — the repo this page is built from. */
const REPO_URL = "https://github.com/Supa-Media/context";
const ARCHITECTURE_URL = "https://github.com/Supa-Media/context#how-it-works";

/**
 * The public landing page, from `docs/design/console-mockup.html`.
 *
 * The console below the hero is the real console components running on demo
 * data — the rail navigates, contexts switch, the tree selects — rather than a
 * screenshot. It has no ability to act: `useDemoConsoleData` supplies no
 * `revoke` callback, no storage actions, and no ingestion `save`.
 *
 * It holds a `ConsoleRoute` in state where the signed-in console reads one
 * from the URL. Same type, same transitions, same resolver — so the demo
 * cannot drift into behaving differently from the thing it is advertising.
 */
export function Landing() {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const router = useRouter();
  const auth = useConvexAuth();
  const demo = useDemoConsoleData();
  const [route, setRoute] = useState<ConsoleRoute>(MAP_ROUTE);

  // The route names a context by slug; the demo data selects one by id. Same
  // resolution the console layout runs against the URL.
  const resolution = resolveContextRoute({
    route,
    contexts: demo.contexts,
    selectedContextId: demo.selectedContextId,
    loading: demo.loading,
  });
  const { selectContext } = demo;
  useEffect(() => {
    if (resolution.action === "select") selectContext(resolution.contextId);
  }, [
    resolution.action,
    resolution.action === "select" ? resolution.contextId : null,
    selectContext,
  ]);

  const heroSize = clamp(46, 7.6, 98, width);
  const subSize = clamp(16, 1.5, 19, width);
  const heroType = {
    fontSize: heroSize,
    lineHeight: leading(heroSize, 0.98),
    letterSpacing: tracking(heroSize, -0.035),
  };
  // `max-width: 14ch`, resolved against the display face's measured "0"
  // advance rather than a guessed one — see `hero.ts`. A flat pixel value
  // cannot be right at both ends of a `clamp(46px, 7.6vw, 98px)` type scale.
  const heroWidth = { maxWidth: heroHeadingWidth(heroSize) };

  return (
    <ScreenScroll
      style={styles.ground}
      contentContainerStyle={styles.scroll}
      // The stage's grid and halo are painted behind everything, so the scroll
      // view must not clip them at the fold.
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.stage}>
        <StageBackdrop />

        <View style={styles.wrap}>
          <View style={styles.top}>
            <Text variant="mark">
              Context
              <Text variant="mark" style={styles.markSuffix}>
                .lc
              </Text>
            </Text>
            <PressRow
              accessibilityLabel="Context is MIT licensed open source on GitHub"
              role="link"
              radius={radii.pill}
              style={styles.badge}
              hoverStyle={styles.badgeHover}
              onPress={() => {
                void Linking.openURL(REPO_URL);
              }}
            >
              <Text variant="badge" style={styles.badgeStar} aria-hidden>
                ★
              </Text>
              <Text variant="badge" style={styles.badgeStrong}>
                MIT
              </Text>
              <Text variant="badge"> open source</Text>
            </PressRow>
          </View>

          <View style={styles.hero}>
            {/*
              Two `Text` elements rather than one with a `\n` and a nested span:
              RN-Web lays a nested `<Text>` out as an inline box that does not
              inherit the parent's explicit `lineHeight`, so the dimmed second
              line collapsed on top of the first.
            */}
            <View role="heading" aria-level={1} style={[styles.heroHeading, heroWidth]}>
              <Text style={[styles.heroTitle, heroType]}>{HERO_LINE_ONE}</Text>
              <Text style={[styles.heroTitle, styles.heroDim, heroType]}>
                {HERO_LINE_TWO}
              </Text>
            </View>

            <Text
              variant="heroSub"
              style={[
                styles.heroSub,
                { fontSize: subSize, lineHeight: leading(subSize, 1.55) },
              ]}
            >
              {HERO_SUB}
            </Text>

            <View style={styles.actions}>
              <View style={styles.actionRow}>
              <Button
                label={landingCtaLabel(auth)}
                variant="white"
                onPress={() => router.push(landingCtaHref(auth))}
                testID="landing-cta"
                style={styles.actionItem}
              />
              <Button
                label="Read the architecture"
                variant="ghost"
                style={styles.actionItem}
                onPress={() => {
                  void Linking.openURL(ARCHITECTURE_URL);
                }}
                trailing={
                  <Text variant="ghost" style={styles.arrow} aria-hidden>
                    ↗
                  </Text>
                }
              />
              </View>
              {/*
                The mockup links these to the stores. There are no listings yet,
                so they read as the same line without pretending to navigate —
                see the build report.
              */}
              <Text variant="alsoLine">
                Also on your phone:{" "}
                <Text variant="alsoLine" style={styles.alsoTarget}>
                  iOS
                </Text>{" "}
                ·{" "}
                <Text variant="alsoLine" style={styles.alsoTarget}>
                  Android
                </Text>
                {"  "}
                <Text variant="alsoLine" style={styles.soon}>
                  (soon)
                </Text>
              </Text>
            </View>
          </View>

          <ContinuityDemo />

          <View style={styles.markdownBridge} testID="markdown-bridge">
            <View style={styles.markdownCopy}>
              <Text variant="eyebrow" style={styles.markdownEyebrow}>
                No magic layer
              </Text>
              <Text style={styles.markdownTitle}>Just Markdown. Yours to touch.</Text>
              <Text style={styles.markdownBody}>
                Context stores ordinary files and folders—the same building blocks you already
                know from Obsidian. Let an AI organize them, or open the editor yourself to write,
                rename, move, and shape it all by hand.
              </Text>
            </View>

            <View style={styles.markdownProof}>
              <View style={styles.markdownProofHead}>
                <View style={styles.markdownProofDot} />
                <Text style={styles.markdownProofLabel}>your-workspace/</Text>
                <Text variant="meta">plain files</Text>
              </View>
              <Text style={styles.fileLine}>├── 1-projects/</Text>
              <Text style={styles.fileLine}>├── 2-areas/</Text>
              <Text style={styles.fileLine}>├── 3-resources/</Text>
              <Text style={styles.fileLine}>│   └── product-direction.md</Text>
              <Text style={styles.fileLine}>└── inbox.md</Text>
              <View style={styles.proofRule} />
              <Text style={styles.proofCaption}>
                Edit here · open in Obsidian · sync or self-host
              </Text>
            </View>
          </View>

          <View style={styles.consoleStage}>
            <ConsoleShell data={demo} route={route} onNavigate={setRoute}>
              {route.kind === "app" && route.section === "map" ? <MapPane data={demo} /> : null}
              {route.kind === "app" && route.section === "connections" ? (
                <ConnectionsPane data={demo} />
              ) : null}
              {route.kind === "context" && route.view === "browse" ? (
                <BrowsePane
                  data={demo}
                  onOpenSettings={() => setRoute((current) => openSettings(current))}
                />
              ) : null}
              {route.kind === "context" && route.view === "settings" ? (
                <SettingsPane
                  data={demo}
                  onClose={() => setRoute((current) => closeSettings(current))}
                />
              ) : null}
            </ConsoleShell>
          </View>

          <View style={styles.foot}>
            <Text variant="foot">Demo — sign in for your own workspace</Text>
            <Text variant="foot">{HERO_ALSO}</Text>
            <Text variant="foot">MIT · self-hostable</Text>
            <Link href="/privacy" style={styles.legalLink}>
              Privacy
            </Link>
            <Link href="/terms" style={styles.legalLink}>
              Terms
            </Link>
          </View>
        </View>
      </View>
    </ScreenScroll>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  scroll: { minHeight: "100%" },
  stage: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: colors.ground,
  },
  /** `.wrap` */
  wrap: {
    width: "100%",
    maxWidth: layout.maxWidth,
    marginHorizontal: "auto",
    paddingHorizontal: layout.gutter,
  },
  /** `.top` */
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 26,
  },
  markSuffix: { color: colors.muted },
  /** `.badge` */
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 15,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: "rgba(255,255,255,.03)",
  },
  badgeHover: { backgroundColor: "rgba(255,255,255,.06)" },
  badgeStar: { color: colors.warn },
  badgeStrong: { color: colors.text, fontWeight: "600" },

  /** `.hero` */
  /*
    The hero reads left, not centre.

    It was centred over a field of rotated tiles with a coloured halo behind
    it — a composition that says "a website" before it says what the product
    is, and one the design canvas replaced. Ranged left, the headline, the
    sentence under it and the two buttons share one left edge, so the eye
    goes down a line rather than hunting a new centre for each block, and the
    page can put the product beside them instead of decoration around them.
  */
  hero: {
    alignItems: "flex-start",
    paddingTop: 88,
  },
  heroHeading: {
    alignItems: "flex-start",
    // `max-width` is computed per render from the clamped font size; see
    // `hero.ts` for why it cannot be a constant.
  },
  heroTitle: {
    fontFamily: fonts.display,
    fontWeight: "500",
    color: colors.text,
    textAlign: "left",
  },
  heroDim: { color: colors.heroDim },
  heroSub: {
    marginTop: 26,
    // The measure is the sentence's, not the headline's: 520 is about 62
    // characters at this size, inside the band prose stays readable in.
    maxWidth: 520,
    textAlign: "left",
    color: colors.text2,
  },
  /** `.actions` */
  actions: {
    marginTop: 36,
    alignItems: "flex-start",
    gap: 14,
  },
  /*
    The two buttons sit side by side; the store line is a caption under them.
    They are a row inside the column rather than the column itself, because a
    row that also holds the caption puts it beside the buttons — which is what
    happened on the first pass at this, and it read as a third action.
  */
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
  },
  /**
   * Each action is centred explicitly, because `alignItems: "center"` above is
   * not enough on its own.
   *
   * `Button`'s base style sets `alignSelf: "flex-start"` so a button never
   * stretches to fill its container. That is a fine default, and invisible in a
   * *row*, where `alignSelf` governs the vertical axis. This column is where it
   * bites: the same property now means "hug the left edge", and a child's
   * `alignSelf` beats the parent's `alignItems`. The column is only as wide as
   * its widest child, so the CTA looked correct and the narrower ghost link sat
   * 44px left of centre — at every screen size, not just on a phone.
   *
   * Centring here rather than deleting the default from every Button in the
   * app: a child should not decide how its parent aligns it, but the blast
   * radius of changing that default is the whole design system.
   */
  actionItem: { alignSelf: "flex-start" },
  arrow: { fontSize: t.meta, opacity: 0.65 },
  alsoTarget: {
    color: colors.text2,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineStrong,
  },
  soon: { opacity: 0.7 },

  markdownBridge: {
    marginTop: 68,
    paddingVertical: 34,
    paddingHorizontal: 36,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.panel,
    backgroundColor: "rgba(255,255,255,.025)",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 38,
  },
  markdownCopy: {
    flex: 1.3,
    minWidth: 260,
  },
  markdownEyebrow: { color: colors.accentText },
  markdownTitle: {
    marginTop: 11,
    fontFamily: fonts.display,
    fontSize: t.title,
    lineHeight: 37,
    letterSpacing: -0.7,
    fontWeight: "600",
    color: colors.text,
  },
  markdownBody: {
    marginTop: 14,
    maxWidth: 580,
    fontFamily: fonts.body,
    fontSize: t.lede,
    lineHeight: 24,
    color: colors.text2,
  },
  markdownProof: {
    flex: 0.85,
    minWidth: 260,
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  markdownProofHead: {
    marginBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  markdownProofDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.ok,
  },
  markdownProofLabel: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: t.meta,
    lineHeight: 18,
    color: colors.text,
  },
  fileLine: {
    fontFamily: fonts.mono,
    fontSize: t.meta,
    lineHeight: 22,
    color: colors.text2,
  },
  proofRule: {
    height: 1,
    marginTop: 14,
    marginBottom: 12,
    backgroundColor: colors.line,
  },
  proofCaption: {
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: 17,
    color: colors.muted,
  },

  /** `.consolestage` */
  consoleStage: {
    position: "relative",
    marginTop: 72,
    paddingBottom: 70,
  },
  /** `.foot` */
  foot: {
    paddingBottom: 64,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 20,
  },
  legalLink: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    color: colors.text2,
    textDecorationLine: "none",
  },
});

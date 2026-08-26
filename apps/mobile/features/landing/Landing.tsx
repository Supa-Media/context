import { useState } from "react";
import { Linking, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { Button, PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { clamp, colors, fonts, layout, leading, radii, tracking } from "../design/tokens";
import { landingCtaHref, landingCtaLabel } from "../auth/redirect";
import { ConsoleShell } from "../console/ConsoleShell";
import { BrowsePane } from "../console/panes/BrowsePane";
import { ConnectionsPane } from "../console/panes/ConnectionsPane";
import { MapPane } from "../console/panes/MapPane";
import { StoragePane } from "../console/panes/StoragePane";
import type { PaneKey } from "../console/panes";
import { useDemoConsoleData } from "../console/useDemoConsoleData";
import { ConsoleHalo, StageBackdrop } from "../design/components/StageBackdrop";
import { FloatingTiles } from "./FloatingTiles";
import { heroHeadingWidth } from "./hero";

/** github.com/Supa-Media/context — the repo this page is built from. */
const REPO_URL = "https://github.com/Supa-Media/context";
const ARCHITECTURE_URL = "https://github.com/Supa-Media/context#how-it-works";

/**
 * The public landing page, from `docs/design/console-mockup.html`.
 *
 * The console below the hero is the real console components running on demo
 * data — the panes switch, the tree selects — rather than a screenshot. It has
 * no ability to act: `useDemoConsoleData` supplies no `revoke` callback and the
 * storage actions are disabled.
 */
export function Landing() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const auth = useConvexAuth();
  const demo = useDemoConsoleData();
  const [pane, setPane] = useState<PaneKey>("map");

  const heroSize = clamp(46, 7.6, 98, width);
  const subSize = clamp(16, 1.5, 19, width);
  const showTiles = width >= layout.tileBreakpoint;
  const heroType = {
    fontSize: heroSize,
    lineHeight: leading(heroSize, 0.98),
    letterSpacing: tracking(heroSize, -0.035),
  };
  // `max-width: 14ch`, resolved against Onest's actual "0" advance rather than
  // guessed — see `hero.ts`. A flat pixel value cannot be right at both ends
  // of a `clamp(46px, 7.6vw, 98px)` type scale.
  const heroWidth = { maxWidth: heroHeadingWidth(heroSize) };

  return (
    <ScrollView
      style={styles.ground}
      contentContainerStyle={styles.scroll}
      // The stage's grid and halo are painted behind everything, so the scroll
      // view must not clip them at the fold.
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.stage}>
        <StageBackdrop />
        <FloatingTiles visible={showTiles} />

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
              <Text style={[styles.heroTitle, heroType]}>Free your context.</Text>
              <Text style={[styles.heroTitle, styles.heroDim, heroType]}>
                Share your context.
              </Text>
            </View>

            <Text
              variant="heroSub"
              style={[
                styles.heroSub,
                { fontSize: subSize, lineHeight: leading(subSize, 1.55) },
              ]}
            >
              One MCP endpoint for ChatGPT, Claude, Codex, Notion AI and whatever comes next
              — backed by plain markdown in a bucket you own. Revoke the key and we&apos;re
              gone.
            </Text>

            <View style={styles.actions}>
              <Button
                label={landingCtaLabel(auth)}
                variant="white"
                onPress={() => router.push(landingCtaHref(auth))}
                testID="landing-cta"
              />
              <Button
                label="Read the architecture"
                variant="ghost"
                onPress={() => {
                  void Linking.openURL(ARCHITECTURE_URL);
                }}
                trailing={
                  <Text variant="ghost" style={styles.arrow} aria-hidden>
                    ↗
                  </Text>
                }
              />
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

          <View style={styles.consoleStage}>
            <ConsoleHalo />
            <ConsoleShell data={demo} activePane={pane} onSelectPane={setPane}>
              {pane === "map" ? <MapPane data={demo} /> : null}
              {pane === "browse" ? <BrowsePane data={demo} /> : null}
              {pane === "connect" ? <ConnectionsPane data={demo} /> : null}
              {pane === "storage" ? <StoragePane data={demo} /> : null}
            </ConsoleShell>
          </View>

          <View style={styles.foot}>
            <Text variant="foot">Demo — sign in for your own context</Text>
            <Text variant="foot">Free. You bring the bucket.</Text>
            <Text variant="foot">MIT · self-hostable</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
  hero: {
    alignItems: "center",
    paddingTop: 96,
  },
  heroHeading: {
    alignItems: "center",
    // `max-width` is computed per render from the clamped font size; see
    // `hero.ts` for why it cannot be a constant.
  },
  heroTitle: {
    fontFamily: fonts.display,
    fontWeight: "500",
    color: colors.text,
    textAlign: "center",
  },
  heroDim: { color: colors.heroDim },
  heroSub: {
    marginTop: 30,
    // `max-width:53ch`
    maxWidth: 640,
    textAlign: "center",
    color: colors.text2,
  },
  /** `.actions` */
  actions: {
    marginTop: 40,
    alignItems: "center",
    gap: 18,
  },
  arrow: { fontSize: 12, opacity: 0.65 },
  alsoTarget: {
    color: colors.text2,
    borderBottomWidth: 1,
    borderBottomColor: colors.lineStrong,
  },
  soon: { opacity: 0.7 },

  /** `.consolestage` */
  consoleStage: {
    position: "relative",
    marginTop: 104,
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
});

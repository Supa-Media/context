import { useEffect, useState } from "react";
import { Linking, StyleSheet, View, useWindowDimensions } from "react-native";
import { Link, useRouter } from "expo-router";
import { useConvexAuth } from "convex/react";
import { Button, PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import {
  clamp,
  fonts,
  layout,
  leading,
  pointerType as t,
  radii,
  space,
  tracking,
} from "../design/tokens";
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
import { HeroWindow } from "./HeroWindow";
import { Sections } from "./Sections";
import {
  ALSO_ON_PHONE,
  ARCHITECTURE_CTA,
  NAV_ARCHITECTURE,
  NAV_GITHUB,
  NAV_SIGN_IN,
  NAV_START,
  DEMO_FOOT,
  FOOT_LICENCE,
  HERO_ALSO,
  HERO_LINE_ONE,
  HERO_LINE_TWO,
  HERO_SUB,
  LICENCE_BADGE,
  LICENCE_FOOT,
  PROOF_EYEBROW,
  PROOF_FOLDER,
  PROOF_BODY,
  PROOF_FOOT,
  PROOF_TITLE,
  PRIVACY_LINK,
  STORE_ANDROID,
  STORE_IOS,
  TERMS_LINK,
} from "./copy";
import { heroHeadingWidth } from "./hero";
import { densityFor } from "../app/frame";

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
  /*
    One column, at the density that owns the word. `Landing-Phone.dc.html` is
    the same page stacked, and `densityFor` is what the rest of the application
    asks — a landing page inventing its own breakpoint is a second answer to
    "what is a phone".
  */
  const phone = densityFor(width) === "compact";
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
          {/*
            A NAVIGATION BAR, WHERE THERE WAS A WORDMARK AND A BADGE.

            The canvas opens with one: a mark, a row of links, and the two
            actions at the trailing edge. What was here was the wordmark alone
            at the leading edge and the MIT badge at the trailing one — which
            reads as a title bar rather than as a way around a site, and left
            "sign in" reachable only by scrolling to a button in the middle of
            the hero.

            Two links, not the canvas's four. It draws Docs / Architecture /
            Pricing / GitHub and only two of those have anywhere to go; a nav
            with a `Docs` link and no docs is a worse page than one with two
            links. See `copy.ts`.

            The badge is not deleted — it moves into the hero as the eyebrow
            the canvas draws there, which is where a licence claim belongs:
            beside the sentence it qualifies rather than opposite the logo.
          */}
          <View style={styles.top}>
            <View style={styles.navLead}>
              <View style={styles.navMark} aria-hidden>
                <View style={styles.navMarkRule} />
                <View style={styles.navMarkRule} />
                <View style={[styles.navMarkRule, styles.navMarkRuleShort]} />
              </View>
              <Text variant="mark">
                Context
                <Text variant="mark" style={styles.markSuffix}>
                  .lc
                </Text>
              </Text>
            </View>

            <View style={styles.navLinks}>
              <PressRow
                accessibilityLabel={ARCHITECTURE_CTA}
                role="link"
                radius={radii.xs}
                style={styles.navLink}
                hoverStyle={styles.navLinkHover}
                onPress={() => {
                  void Linking.openURL(ARCHITECTURE_URL);
                }}
              >
                <Text variant="navLink">{NAV_ARCHITECTURE}</Text>
              </PressRow>
              <PressRow
                accessibilityLabel={LICENCE_BADGE}
                role="link"
                radius={radii.xs}
                style={styles.navLink}
                hoverStyle={styles.navLinkHover}
                onPress={() => {
                  void Linking.openURL(REPO_URL);
                }}
              >
                <Text variant="navLink">{NAV_GITHUB}</Text>
              </PressRow>
            </View>

            <View style={styles.navActions}>
              <PressRow
                accessibilityLabel={NAV_SIGN_IN}
                role="link"
                radius={radii.xs}
                style={styles.navLink}
                hoverStyle={styles.navLinkHover}
                onPress={() => router.push(landingCtaHref(auth))}
              >
                <Text variant="navAction">{NAV_SIGN_IN}</Text>
              </PressRow>
              <Button
                label={NAV_START}
                variant="accent"
                style={styles.navStart}
                onPress={() => router.push(landingCtaHref(auth))}
                testID="landing-nav-cta"
              />
            </View>
          </View>

          {/*
            TWO COLUMNS, AND THE PRODUCT IS THE SECOND ONE.

            `Landing-Hero.dc.html` puts the pitch on the left and an
            application window on the right, running off the page's edge. This
            page had the left column and empty space — so the hero asserted
            things about a product a visitor could not see, with the live
            console four screens down past a transcript.

            `heroRow` wraps rather than breaking at a width: the window has a
            `minWidth` and the text column has a measure, and below the sum of
            those the two stack with the window underneath. One fewer place
            that has to be told what a phone is.
          */}
          <View style={[styles.heroRow, phone && styles.heroRowPhone]}>
          <View style={[styles.hero, phone && styles.heroPhone]}>
            {/*
              THE LICENCE CLAIM, BESIDE THE SENTENCE IT QUALIFIES.

              It was a bordered badge opposite the wordmark, where it read as
              chrome. The canvas puts an eyebrow pill at the head of the text
              column — "MIT · self-hostable" with a live dot — because "you can
              take this and run it yourself" is part of the pitch rather than a
              fact about the header.

              The same target as before: it opens the repository, and its
              accessible name is still the whole sentence rather than the three
              words drawn in it.
            */}
            <PressRow
              accessibilityLabel={LICENCE_BADGE}
              role="link"
              radius={radii.pill}
              style={styles.badge}
              hoverStyle={styles.badgeHover}
              onPress={() => {
                void Linking.openURL(REPO_URL);
              }}
            >
              <View style={styles.badgeDot} aria-hidden />
              <Text variant="badge">{LICENCE_FOOT}</Text>
            </PressRow>

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
                variant="accent"
                onPress={() => router.push(landingCtaHref(auth))}
                testID="landing-cta"
                style={styles.actionItem}
              />
              <Button
                label={ARCHITECTURE_CTA}
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
                What the button above it needs answering: "connect a bucket" —
                with what? The canvas puts this line directly under the actions
                and it was in the page's foot, twenty screens away from the
                control it qualifies.
              */}
              <Text variant="alsoLine">{HERO_ALSO}</Text>
              {/*
                The mockup links these to the stores. There are no listings yet,
                so they read as the same line without pretending to navigate —
                see the build report.
              */}
              <Text variant="alsoLine">
                {ALSO_ON_PHONE}{" "}
                <Text variant="alsoLine" style={styles.alsoTarget}>
                  {STORE_IOS}
                </Text>{" "}
                ·{" "}
                <Text variant="alsoLine" style={styles.alsoTarget}>
                  {STORE_ANDROID}
                </Text>
                {"  "}
                <Text variant="alsoLine" style={styles.soon}>
                  (soon)
                </Text>
              </Text>
            </View>
          </View>

          {/*
            Off the right edge, deliberately: `heroWindow` has no right gutter
            and the stage clips it. A window fully inside the page is a card,
            and a card is a thing the page contains rather than a thing the
            page is showing you.
          */}
          <View style={[styles.heroWindow, phone && styles.heroWindowPhone]}>
            <HeroWindow compact={phone} />
          </View>
          </View>

          {/*
            The endpoint and the three assurances, between the hero and the
            continuity demo — which is where `Landing-Sections.dc.html` puts
            them, and the order is the argument: what you *do* (paste one URL),
            then what you keep (your bucket, your files, your exit), then the
            demo showing it happen. The page used to open on the demo, so a
            visitor met a transcript before learning what the product was.
          */}
          <Sections />

          <ContinuityDemo />

          <View style={styles.markdownBridge} testID="markdown-bridge">
            <View style={styles.markdownCopy}>
              <Text variant="eyebrow" style={styles.markdownEyebrow}>
                {PROOF_EYEBROW}
              </Text>
              <Text style={styles.markdownTitle}>{PROOF_TITLE}</Text>
              <Text style={styles.markdownBody}>
                {PROOF_BODY}
              </Text>
            </View>

            <View style={styles.markdownProof}>
              <View style={styles.markdownProofHead}>
                <View style={styles.markdownProofDot} />
                <Text style={styles.markdownProofLabel}>{PROOF_FOLDER}</Text>
                <Text variant="meta">plain files</Text>
              </View>
              <Text style={styles.fileLine}>├── 1-projects/</Text>
              <Text style={styles.fileLine}>├── 2-areas/</Text>
              <Text style={styles.fileLine}>├── 3-resources/</Text>
              <Text style={styles.fileLine}>│   └── product-direction.md</Text>
              <Text style={styles.fileLine}>└── inbox.md</Text>
              <View style={styles.proofRule} />
              <Text style={styles.proofCaption}>
                {PROOF_FOOT}
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
            <Text variant="foot" style={styles.demoFoot}>
              {DEMO_FOOT}
            </Text>
          </View>

          {/*
            A FOOTER, WHERE THERE WAS A CENTRED ROW OF FIVE UNRELATED PHRASES.

            "Demo — sign in for your own workspace", the storage line, the
            licence and two legal links, all the same size and all centred:
            five things with nothing to say to each other, arranged as though
            they were a list. The canvas draws a footer — the mark and the
            licence at the leading edge, the legal links at the trailing one —
            and the two sentences that were never footer material move to where
            they belong.

            `DEMO_FOOT` goes with the demo it is about, directly under the
            console it captions. `HERO_ALSO` goes under the hero's buttons,
            which is where the canvas puts it and what it answers: "connect a
            bucket" — with what?
          */}
          <View style={styles.foot}>
            <View style={styles.footLead}>
              <View style={styles.footMark} aria-hidden>
                <View style={styles.navMarkRule} />
                <View style={styles.navMarkRule} />
                <View style={[styles.navMarkRule, styles.navMarkRuleShort]} />
              </View>
              <Text variant="navAction">Context</Text>
              <Text variant="foot">{FOOT_LICENCE}</Text>
            </View>
            <View style={styles.footLinks}>
              <Link href="/privacy" style={styles.legalLink}>
                {PRIVACY_LINK}
              </Link>
              <Link href="/terms" style={styles.legalLink}>
                {TERMS_LINK}
              </Link>
            </View>
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
  /**
   * `.top` — a navigation bar rather than a title row.
   *
   * `gap` plus `marginLeft: "auto"` on the actions instead of
   * `justifyContent: "space-between"`: with three groups, `space-between`
   * pushes the links to the middle of a 1312pt page, where they read as a
   * third, unrelated thing. The canvas keeps the mark and the links together
   * at the leading edge and sends only the actions to the far side.
   *
   * 72pt tall, which is the canvas's, and taller than the 52 the old
   * `paddingVertical: 26` produced around a single line of text.
   */
  top: {
    flexDirection: "row",
    alignItems: "center",
    height: 72,
    gap: 40,
  },
  navLead: { flexDirection: "row", alignItems: "center", gap: 9 },
  /**
   * The mark: three rules in a rounded square, which is the canvas's glyph.
   *
   * Drawn as `View`s rather than an `Icon`, because `Icon`'s set is the
   * application's vocabulary — a gear, a lock, a chevron — and a logo is not a
   * member of it. Three stacked rules with the last one short is a page of
   * text, which is what the product holds.
   */
  navMark: {
    width: 22,
    height: 22,
    borderRadius: 7,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    gap: 2.5,
    paddingHorizontal: 5,
  },
  navMarkRule: {
    height: 1.5,
    alignSelf: "stretch",
    borderRadius: radii.pill,
    backgroundColor: colors.accent,
  },
  navMarkRuleShort: { alignSelf: "flex-start", width: 6 },
  navLinks: { flexDirection: "row", alignItems: "center", gap: 10 },
  navActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginLeft: "auto",
  },
  navLink: { paddingVertical: 8, paddingHorizontal: 8 },
  navLinkHover: { backgroundColor: colors.surface2 },
  /*
    The nav's button is smaller than the hero's, deliberately: they are the
    same action, and a second full-size CTA 80pt above the first is two
    primaries on one screen. `Button`'s own `accent` padding is the hero's, so
    this overrides it rather than adding a variant for one call site.
  */
  navStart: { paddingVertical: 8, paddingHorizontal: 16 },
  markSuffix: { color: colors.muted },
  /**
   * `.badge` — the hero's eyebrow now, not the header's trim.
   *
   * Filled rather than outlined, and the fill is a token. It was
   * `rgba(255,255,255,.03)` over a `lineStrong` border, which is two things
   * wrong at once: a literal white wash is invisible on paper, where the
   * ground is already near-white, and an outlined pill at the head of a text
   * column reads as a control somebody forgot to finish. `rowSelected` is the
   * canvas's `#E6E1D6` on paper and `#2B2825` on graphite — a step of ground,
   * which is what an eyebrow wants.
   */
  badge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 8,
    height: 28,
    paddingHorizontal: 12,
    marginBottom: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.rowSelected,
  },
  badgeHover: { backgroundColor: colors.surface3 },
  /** A live dot, in the tone that means "working" everywhere else here. */
  badgeDot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: colors.ok },

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
  heroRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: 48,
    /*
      The window bleeds past the page's gutter, so the row is allowed to draw
      outside it. `layout.gutter` back on the right is what "runs off the edge"
      means in a page that is otherwise inset.
    */
    marginRight: -layout.gutter,
  },
  /**
   * A PHONE IS ONE COLUMN, AND IT HAS TO BE SAID TWICE.
   *
   * `flexWrap` alone was not enough and the landing page shipped broken at
   * 390pt because of it: a wrapped row still gives each child its `minWidth`,
   * so a 420pt window on a 390pt screen overflowed by 30 — and `marginRight:
   * -28` pulled the whole row a further 28pt past the edge, which is why the
   * headline, the paragraph and the buttons all ran off the right edge rather
   * than just the window. Everything below the fold was fine, which is how it
   * survived a desktop review.
   *
   * So the negative margin is a pointer-layout thing (there is no page gutter
   * worth escaping on a phone) and the columns are told they may shrink —
   * `minWidth: 0`, which a flex child does not do by default and which is the
   * whole fix.
   */
  heroRowPhone: { flexDirection: "column", alignItems: "stretch", marginRight: 0, gap: 28 },
  /*
    `flexBasis: "auto"`, and this one is worth knowing: **in a column, flex-basis
    is the HEIGHT.** `hero`'s 560 is a width for the two-column layout, and the
    moment the row became a column it became a 560pt *height* — so the hero box
    ended 560 down while its content ran on to about 1300, and the window drew
    straight over the second button. On screen it looked like an overlap bug;
    in the stylesheet it is one property meaning two things.
  */
  heroPhone: { flexBasis: "auto" },
  heroWindow: {
    flexGrow: 1,
    flexBasis: 520,
    minWidth: 420,
    paddingTop: 84,
  },
  /*
    `Landing-Phone.dc.html` keeps the window, under the pitch rather than
    beside it and running off the bottom-right. `minWidth: 0` is what lets it
    be 390 wide instead of 420.
  */
  heroWindowPhone: { minWidth: 0, flexBasis: "auto", width: "100%", paddingTop: 8 },
  hero: {
    flexGrow: 1,
    flexBasis: 560,
    minWidth: 0,
    maxWidth: 660,
    /*
      `width: "100%"` with `maxWidth` rather than a basis alone: in the phone's
      column the basis is the *height* axis's business, and without a width the
      hero sized itself to its widest child — the H1, whose own `maxWidth` is
      `heroHeadingWidth(46)` = 434 on a 390 screen. That is how a headline ran
      off the edge of a page whose document reported no horizontal overflow at
      all: the stage clips, so `scrollWidth` stayed 390 while the text did not.
    */
    width: "100%",
    alignItems: "flex-start",
    // 72, not 88: the eyebrow pill now sits at the top of this column and
    // carries 28 of its own beneath it, so the old gap would compound.
    paddingTop: 72,
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
    marginTop: 40,
    paddingTop: 28,
    paddingBottom: 64,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 24,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  footLead: { flexDirection: "row", alignItems: "center", gap: 9 },
  /** The nav's mark at the size a footer wants — see `navMark`. */
  footMark: {
    width: 20,
    height: 20,
    borderRadius: 6,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
    gap: 2.5,
    paddingHorizontal: 4.5,
  },
  footLinks: { flexDirection: "row", alignItems: "center", gap: 22, marginLeft: "auto" },
  /** The demo's caption, under the demo rather than in the footer. */
  demoFoot: { marginTop: space.x4, textAlign: "center" },
  legalLink: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    color: colors.text2,
    textDecorationLine: "none",
  },
});

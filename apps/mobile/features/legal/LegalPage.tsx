import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Link } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { Text } from "../design/components/Text";
import { clamp, fonts, leading, radii, tracking } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

type LegalSection = {
  title: string;
  body: string[];
};

export type LegalPageContent = {
  eyebrow: string;
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
};

export function LegalPage({ content }: { content: LegalPageContent }) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(36, 6.4, 68, width);

  return (
    <ScreenScroll
      style={styles.ground}
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.wrap}>
        <View style={styles.nav}>
          <Link href="/" style={styles.brand} accessibilityLabel="Context home">
            Context.lc
          </Link>
          <View style={styles.links}>
            <Link href="/privacy" style={styles.navLink}>
              Privacy
            </Link>
            <Link href="/terms" style={styles.navLink}>
              Terms
            </Link>
          </View>
        </View>

        <View style={styles.head}>
          <Text variant="eyebrow" style={styles.eyebrow}>
            {content.eyebrow}
          </Text>
          <Text
            role="heading"
            aria-level={1}
            style={[styles.title, { fontSize: titleSize, lineHeight: leading(titleSize, 1.02) }]}
          >
            {content.title}
          </Text>
          <Text variant="body" style={styles.updated}>
            Last updated {content.updated}
          </Text>
          <Text variant="heroSub" style={styles.intro}>
            {content.intro}
          </Text>
        </View>

        <View style={styles.body}>
          {content.sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text role="heading" aria-level={2} style={styles.sectionTitle}>
                {section.title}
              </Text>
              {section.body.map((paragraph) => (
                <Text key={paragraph} variant="body" style={styles.paragraph}>
                  {paragraph}
                </Text>
              ))}
            </View>
          ))}
        </View>

        <View style={styles.foot}>
          <Text variant="foot">Context.lc is operated by Supa Media.</Text>
          <Text variant="foot">Questions: context@supa.media</Text>
        </View>
      </View>
    </ScreenScroll>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  scroll: { minHeight: "100%" },
  wrap: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 72,
  },
  nav: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 18,
    marginBottom: 78,
  },
  brand: {
    fontFamily: fonts.display,
    fontSize: 17,
    lineHeight: leading(17, 1.55),
    fontWeight: "600",
    color: colors.text,
    textDecorationLine: "none",
  },
  links: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 18,
  },
  navLink: {
    fontFamily: fonts.body,
    fontSize: 14.5,
    lineHeight: leading(14.5, 1.55),
    color: colors.text2,
    textDecorationLine: "none",
  },
  head: {
    maxWidth: 720,
    paddingBottom: 30,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  eyebrow: { marginBottom: 14 },
  title: {
    fontFamily: fonts.display,
    fontWeight: "600",
    letterSpacing: tracking(48, -0.035),
    color: colors.text,
    marginBottom: 18,
  },
  updated: {
    color: colors.muted,
    marginBottom: 28,
  },
  intro: {
    fontSize: 18,
    lineHeight: leading(18, 1.55),
    color: colors.text2,
  },
  body: {
    paddingTop: 28,
    gap: 28,
  },
  section: {
    gap: 11,
    paddingBottom: 26,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 21,
    lineHeight: leading(21, 1.35),
    fontWeight: "600",
    letterSpacing: tracking(21, -0.02),
    color: colors.text,
  },
  paragraph: {
    maxWidth: 760,
    color: colors.text2,
  },
  foot: {
    gap: 8,
    marginTop: 34,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
  },
});

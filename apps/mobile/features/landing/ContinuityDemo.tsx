import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, layout, pointerType as t, radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import {
  CONTINUITY_STEPS,
  DEMO_BOUNDARY_BODY,
  DEMO_BOUNDARY_TITLE,
  DEMO_EYEBROW,
  DEMO_SUB,
  DEMO_TITLE,
} from "./demoCopy";

/**
 * The product promise as a three-beat story.
 *
 * The console below proves the access model is real. This section earns the
 * visitor's attention first: one idea enters through ChatGPT, survives into a
 * Claude Code session, and reaches a teammate's Notion AI without dragging
 * private context with it. The words are intentionally concrete enough to be
 * read as a transcript, not as three feature cards wearing chat bubbles.
 */
export function ContinuityDemo() {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const wide = width >= layout.narrowBreakpoint;

  return (
    <View style={styles.section} testID="continuity-demo">
      <View style={styles.heading}>
        <Text variant="eyebrow" style={styles.eyebrow}>
          {DEMO_EYEBROW}
        </Text>
        <Text style={styles.title}>{DEMO_TITLE}</Text>
        <Text style={styles.subtitle}>{DEMO_SUB}</Text>
      </View>

      <View style={[styles.flow, wide ? styles.flowWide : styles.flowNarrow]}>
        {CONTINUITY_STEPS.map((step, index) => (
          <View key={step.id} style={[styles.beat, wide ? styles.beatWide : null]}>
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <View style={[styles.mark, step.id === "teammate" ? styles.teamMark : null]}>
                  <Text style={styles.markText}>{step.mark}</Text>
                </View>
                <View style={styles.identity}>
                  <Text style={styles.product}>{step.product}</Text>
                  <Text variant="meta">{step.moment}</Text>
                </View>
                <View style={[styles.access, step.id === "teammate" ? styles.teamAccess : null]}>
                  <Text
                    style={[
                      styles.accessText,
                      step.id === "teammate" ? styles.teamAccessText : null,
                    ]}
                  >
                    {step.access}
                  </Text>
                </View>
              </View>

              <View style={styles.userBubble}>
                <Text style={styles.speaker}>You</Text>
                <Text style={styles.message}>{step.prompt}</Text>
              </View>

              <View style={styles.contextBubble}>
                <Text style={[styles.speaker, styles.contextSpeaker]}>{step.product}</Text>
                <Text style={styles.message}>{step.reply}</Text>
              </View>

              <View style={styles.receipt}>
                <View style={styles.receiptDot} />
                <Text variant="meta" style={styles.receiptText}>
                  {step.receipt}
                </Text>
              </View>
            </View>

            {index < CONTINUITY_STEPS.length - 1 ? (
              <View style={[styles.connector, wide ? styles.connectorWide : styles.connectorNarrow]}>
                <View style={wide ? styles.connectorLineWide : styles.connectorLineNarrow} />
                <Text style={styles.connectorArrow} aria-hidden>
                  {wide ? "›" : "↓"}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
      </View>

      <View style={styles.boundary}>
        <Text style={styles.boundaryStrong}>{DEMO_BOUNDARY_TITLE}</Text>
        <Text style={styles.boundaryCopy}>{DEMO_BOUNDARY_BODY}</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  section: {
    marginTop: 116,
    paddingVertical: 42,
  },
  heading: {
    alignItems: "center",
    maxWidth: 720,
    marginHorizontal: "auto",
  },
  eyebrow: { color: colors.accentText },
  title: {
    marginTop: 13,
    fontFamily: fonts.display,
    fontSize: t.display,
    lineHeight: 44,
    letterSpacing: -1.15,
    fontWeight: "600",
    color: colors.text,
    textAlign: "center",
  },
  subtitle: {
    marginTop: 16,
    maxWidth: 640,
    fontFamily: fonts.body,
    fontSize: t.body,
    lineHeight: 25,
    color: colors.text2,
    textAlign: "center",
  },
  flow: {
    marginTop: 44,
    alignItems: "stretch",
  },
  flowWide: { flexDirection: "row" },
  flowNarrow: { flexDirection: "column", gap: 0 },
  beat: { minWidth: 0 },
  beatWide: { flex: 1, flexDirection: "row" },
  card: {
    flex: 1,
    minWidth: 0,
    minHeight: 398,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.panel,
    backgroundColor: colors.surface,
    boxShadow: "0 24px 70px -42px rgba(0,0,0,.95)",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginBottom: 20,
  },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accentDim,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  teamMark: {
    backgroundColor: colors.sharedWash,
    borderColor: colors.sharedBorder,
  },
  markText: {
    fontFamily: fonts.mono,
    color: colors.text,
    fontSize: t.body,
    fontWeight: "600",
  },
  identity: { flex: 1, minWidth: 0 },
  product: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: 20,
    fontWeight: "600",
    color: colors.text,
  },
  access: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: radii.pill,
    backgroundColor: colors.accentDim,
  },
  teamAccess: { backgroundColor: colors.sharedWash },
  accessText: {
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: 14,
    fontWeight: "600",
    color: colors.accentText,
  },
  teamAccessText: { color: colors.sharedText },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderBottomRightRadius: 4,
    backgroundColor: colors.surface3,
  },
  contextBubble: {
    alignSelf: "flex-start",
    maxWidth: "94%",
    marginTop: 13,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    backgroundColor: colors.hintWash,
  },
  speaker: {
    marginBottom: 4,
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: colors.muted,
  },
  contextSpeaker: { color: colors.accentText },
  message: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: 20.5,
    color: colors.text2,
  },
  receipt: {
    marginTop: "auto",
    paddingTop: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  receiptDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.ok,
  },
  receiptText: { flex: 1 },
  connector: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  connectorWide: { width: 34 },
  connectorNarrow: { height: 38 },
  connectorLineWide: {
    position: "absolute",
    width: 34,
    height: 1,
    backgroundColor: colors.lineStrong,
  },
  connectorLineNarrow: {
    position: "absolute",
    width: 1,
    height: 38,
    backgroundColor: colors.lineStrong,
  },
  connectorArrow: {
    paddingHorizontal: 4,
    backgroundColor: colors.ground,
    color: colors.muted,
    fontFamily: fonts.body,
    fontSize: t.h2,
    lineHeight: 24,
  },
  boundary: {
    marginTop: 24,
    paddingVertical: 15,
    paddingHorizontal: 18,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "rgba(255,255,255,.025)",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  boundaryStrong: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: 20,
    fontWeight: "600",
    color: colors.text,
  },
  boundaryCopy: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
  },
});

import { StyleSheet, View, useWindowDimensions } from "react-native";
import { Text } from "../design/components/Text";
import { colors, fonts, layout, radii } from "../design/tokens";

/** The one team-safe decision every card in the demo hands forward. */
export const TEAM_THOUGHT = "Show continuity, not storage.";

export const CONTINUITY_STEPS = [
  {
    id: "chatgpt",
    product: "ChatGPT",
    mark: "C",
    access: "Private access",
    moment: "You tell it once",
    prompt:
      "New thought: the demo should show continuity, not storage. Share that with the Context team.",
    reply:
      "Saved as a team note in the @context-lc workspace. Your brain stays private.",
    receipt: "Published to the team workspace · just now",
  },
  {
    id: "claude-code",
    product: "Claude Code",
    mark: ">_",
    access: "Private access",
    moment: "Your next AI picks it up",
    prompt: "Update the landing page with our newest product direction.",
    reply:
      "I found the thought you added in ChatGPT: “Show continuity, not storage.” I’m building the three-AI handoff now.",
    receipt: "Read from @context-lc · no re-explaining",
  },
  {
    id: "teammate",
    product: "Coworker’s Notion AI",
    mark: "N",
    access: "Team access",
    moment: "The right teammate knows too",
    prompt: "What changed in Context’s product direction?",
    reply:
      "Seyi added a team note: make cross-AI continuity the demo. I can use that decision; his private notes were never available to me.",
    receipt: "Workspace visible · your brain hidden",
  },
] as const;

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
  const { width } = useWindowDimensions();
  const wide = width >= layout.narrowBreakpoint;

  return (
    <View style={styles.section} testID="continuity-demo">
      <View style={styles.heading}>
        <Text variant="eyebrow" style={styles.eyebrow}>
          One thought · three AIs
        </Text>
        <Text style={styles.title}>Tell one AI. The others already know.</Text>
        <Text style={styles.subtitle}>
          Context carries the decision to every client and teammate you allowed—not the private
          notes you didn&apos;t.
        </Text>
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
        <Text style={styles.boundaryStrong}>The note moves. The boundary doesn&apos;t.</Text>
        <Text style={styles.boundaryCopy}>
          ChatGPT and Claude Code can use your full context. Your coworker&apos;s Notion AI receives
          only what you marked for the team.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    fontSize: 40,
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
    fontSize: 16,
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
    backgroundColor: "rgba(139,92,246,.13)",
    borderColor: "rgba(139,92,246,.26)",
  },
  markText: {
    fontFamily: fonts.mono,
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  identity: { flex: 1, minWidth: 0 },
  product: {
    fontFamily: fonts.body,
    fontSize: 14,
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
  teamAccess: { backgroundColor: "rgba(139,92,246,.13)" },
  accessText: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: "600",
    color: colors.accentText,
  },
  teamAccessText: { color: "#D8C9FF" },
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
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: colors.muted,
  },
  contextSpeaker: { color: colors.accentText },
  message: {
    fontFamily: fonts.body,
    fontSize: 13.5,
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
    fontSize: 22,
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
    fontSize: 13,
    lineHeight: 20,
    fontWeight: "600",
    color: colors.text,
  },
  boundaryCopy: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
  },
});

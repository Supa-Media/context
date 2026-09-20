import { useCallback, useRef } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, pointerType as t, radii } from "../design/tokens";
import { useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { AgentConversation } from "./AgentConversation";
import type { AgentEngine } from "./engine";
import type { AgentPage } from "./page";

/**
 * The conversation, as a surface.
 *
 * Draws what `conversation.ts` says and decides nothing itself — the send
 * control is live exactly when `canAsk` is true, rather than when this
 * component thinks it should be.
 *
 * ## Why it is a `Modal` and not a pane in the console
 *
 * The same reason `VoiceSheet` is one: it is raised from a floating control,
 * it is dismissed by pressing away from it, and it has to appear identically on
 * a surface that has no console around it at all. A pane would have to be
 * mounted by every layout that can reach the microphone, and two of those are
 * fixtures.
 *
 * It borrows that sheet's compact/pointer split wholesale: a phone's slides up
 * from the edge, a pointer layout's hangs off the button that was just pressed
 * without animating, because "a card that fades in beside the control you are
 * already looking at reads as a lag rather than as a transition".
 *
 * ## The header names the provider, always
 *
 * Which model is answering is not a detail somebody should have to open
 * Settings to recover — it decides what the answer costs them and whose
 * machine saw the question. In this build it says "No model yet", which is the
 * honest version of the same disclosure.
 */

export const PANEL_TITLE = "Ask your context";

/*
  Re-exported from where it now lives, rather than left as a second copy: the
  tests and the fixtures import it from here, and a constant defined twice is
  the kind that drifts by one word and fails a test about copy.
*/
export { PROMPT_PLACEHOLDER } from "./AgentConversation";

export function AgentPanel({
  engine,
  place,
  compact,
  onClose,
}: {
  engine: AgentEngine;
  /** Where the person is, rebuilt by the host on every render. See `page.ts`. */
  place: AgentPage;
  compact: boolean;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    The conversation's own "a turn in flight is abandoned" closer, handed up so
    this card's dismiss can run it. `AgentConversation` owns the flag — it is
    the thing with a promise in the air — and this owns the scrim that ends the
    card, so the two meet here rather than either reaching into the other.
  */
  const abandon = useRef<() => void>(() => {});

  const dismiss = useCallback(() => {
    abandon.current();
    onClose();
  }, [onClose]);

  return (
    <Modal transparent animationType={compact ? "slide" : "none"} onRequestClose={dismiss} visible>
      <Pressable
        style={[styles.scrim, compact ? styles.scrimCompact : styles.scrimPointer]}
        accessibilityLabel="Close"
        onPress={dismiss}
      >
        {/* Swallow presses inside the card, so only the scrim closes it. */}
        <Pressable
          style={[styles.card, compact ? styles.cardCompact : styles.cardPointer]}
          onPress={() => {}}
          accessibilityLabel={PANEL_TITLE}
          testID="agent-panel"
        >
          <View style={styles.head}>
            <Text variant="railHead" role="heading" aria-level={2}>
              {PANEL_TITLE}
            </Text>
            <Text variant="foot" style={styles.provider} testID="agent-provider">
              {engine.provider}
            </Text>
          </View>

          <AgentConversation
            engine={engine}
            place={place}
            /*
              The card caps its transcript; the console's column does not, and
              that is the one thing the two hosts genuinely disagree about. A
              modal that grew with the conversation would walk off the top of
              a phone, and a column that capped it would leave dead space under
              a composer pinned to the bottom of a 900pt panel.
            */
            style={{ transcript: styles.transcriptCap }}
            onDismissed={(close) => {
              abandon.current = close;
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.scrim },
    scrimCompact: { justifyContent: "flex-end" },
    scrimPointer: { justifyContent: "flex-end", alignItems: "flex-end" },
    card: {
      backgroundColor: colors.pageSurface,
      borderColor: colors.lineStrong,
      paddingVertical: 12,
      boxShadow: shadows.floating,
    },
    cardCompact: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      paddingBottom: 26,
      maxHeight: "80%",
    },
    cardPointer: {
      width: 404,
      maxHeight: 520,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radii.card,
      marginRight: 24,
      marginBottom: 116,
    },
    head: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 16,
      paddingBottom: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    provider: { color: colors.muted, fontFamily: fonts.mono, fontSize: t.meta },
    /**
     * The card's cap on the transcript, handed to `AgentConversation`.
     *
     * The one thing the two hosts disagree about, so it is a prop rather than
     * a constant inside the conversation: a modal that grew with the
     * conversation would walk off the top of a phone, and the console's column
     * would leave dead space under a composer pinned to the bottom of a 900pt
     * panel if it inherited this number.
     */
    transcriptCap: { maxHeight: 340 },
  });

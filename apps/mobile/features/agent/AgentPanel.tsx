import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, layout, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { EMPTY_CONVERSATION, answered, ask, canAsk, failed, type Conversation } from "./conversation";
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

/** The placeholder, which is also the only instruction this surface gives. */
export const PROMPT_PLACEHOLDER = "Ask about this note, or anything in your context";

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
  const colors = useColors();
  const [conversation, setConversation] = useState<Conversation>(EMPTY_CONVERSATION);
  const [draft, setDraft] = useState("");

  /*
    Whether the turn now in flight still belongs to this panel.

    Cleared when the panel closes, so an answer that arrives after somebody has
    walked away lands nowhere instead of reopening a transcript they dismissed.
    A ref rather than state because it is read inside a promise callback that
    must see the value as of *now*, not as of the render that created it.
  */
  const asking = useRef(false);

  const send = useCallback(() => {
    const question = draft;
    /*
      Computed from the state this render already holds, and not inside a
      `setConversation` updater. An updater does not run synchronously — React
      calls it while rendering the next commit — so a version that set a local
      flag inside one and read it on the next line always read the flag unset,
      and no question was ever sent. `ready` gates the button and `ask` guards
      itself, so the closure being one render old cannot let two through.
    */
    const next = ask(conversation, question);
    // `ask` answers by identity when it refuses, which is how a blank prompt
    // and a turn already in flight both become no-ops without a second check.
    if (next === conversation) return;

    setConversation(next);
    setDraft("");
    asking.current = true;

    engine
      .ask({ question: question.trim(), place })
      .then((text) => {
        if (!asking.current) return;
        asking.current = false;
        setConversation((current) => answered(current, text));
      })
      .catch((error: unknown) => {
        if (!asking.current) return;
        asking.current = false;
        setConversation((current) => failed(current, reasonFrom(error)));
      });
  }, [conversation, draft, engine, place]);

  const dismiss = useCallback(() => {
    // A turn in flight is abandoned rather than awaited: the person has left.
    asking.current = false;
    onClose();
  }, [onClose]);

  const ready = canAsk(conversation);

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

          <ScrollView style={styles.transcript} contentContainerStyle={styles.transcriptBody}>
            {conversation.turns.length === 0 ? (
              <Text variant="rowSub" style={styles.empty} testID="agent-empty">
                {place.note === null
                  ? "Nothing is open, so ask about anything in your context."
                  : `You are on ${place.note.path}.`}
              </Text>
            ) : null}

            {conversation.turns.map((turn, index) => (
              <View
                key={`${turn.who}-${index}`}
                style={[styles.turn, turn.who === "person" && styles.turnPerson]}
                testID={`agent-turn-${turn.who}`}
              >
                <Text variant="rowSub" style={styles.turnText}>
                  {turn.text}
                </Text>
              </View>
            ))}

            {conversation.name === "thinking" ? (
              <Text variant="rowSub" style={styles.thinking} testID="agent-thinking">
                Thinking…
              </Text>
            ) : null}

            {conversation.name === "failed" ? (
              <View style={styles.failure} testID="agent-failure">
                <Text variant="rowSub" style={styles.failureText}>
                  {conversation.reason}
                </Text>
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={PROMPT_PLACEHOLDER}
              placeholderTextColor={colors.muted}
              multiline
              accessibilityLabel={PROMPT_PLACEHOLDER}
              testID="agent-input"
            />
            <PressRow
              onPress={ready ? send : undefined}
              accessibilityLabel="Send"
              testID="agent-send"
              radius={radii.pill}
              style={[styles.send, ready && styles.sendReady]}
              hoverStyle={ready ? { backgroundColor: colors.accent } : undefined}
            >
              <Icon name="arrowRight" size={16} color={ready ? colors.ink : colors.muted} />
            </PressRow>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * What to show when `ask` rejects.
 *
 * Never the thrown value's own message: a provider's error text is written for
 * a developer reading a log and can carry a URL, a request id, or the shape of
 * a key. This surface says what happened and what was kept.
 */
function reasonFrom(_error: unknown): string {
  return "That question could not be answered just now. Nothing was sent to your notes, and what you asked is still above.";
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
    transcript: { maxHeight: 340 },
    transcriptBody: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
    empty: { color: colors.muted },
    turn: {
      padding: 10,
      borderRadius: radii.control,
      backgroundColor: colors.chrome,
    },
    /*
      The person's turn wears the accent wash and the agent's does not, which is
      the same direction `VoiceSheet` spends its one hue in: the thing you did
      is marked, the ambient state is not.
    */
    turnPerson: { backgroundColor: colors.accentDim },
    turnText: { color: colors.text },
    thinking: { color: colors.muted, paddingHorizontal: 2 },
    failure: {
      padding: 10,
      borderRadius: radii.control,
      backgroundColor: colors.critWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.critBorder,
    },
    failureText: { color: colors.critText },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    input: {
      flex: 1,
      minHeight: layout.minTouchTarget,
      maxHeight: 120,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: radii.control,
      backgroundColor: colors.chrome,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hintBorder,
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: t.ui,
    },
    send: {
      width: 38,
      height: 38,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.chrome,
    },
    sendReady: { backgroundColor: colors.accent },
  });

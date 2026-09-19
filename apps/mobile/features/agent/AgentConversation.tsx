import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, layout, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { EMPTY_CONVERSATION, answered, ask, canAsk, failed, type Conversation } from "./conversation";
import type { AgentEngine } from "./engine";
import type { AgentPage } from "./page";

/**
 * The conversation itself: a transcript and a composer, and no chrome at all.
 *
 * **Extracted from `AgentPanel`, which is now one of its two hosts.** The panel
 * is a `Modal` raised from a floating control on a phone; the console's right
 * panel is a column in the frame. Those are genuinely different containers —
 * one has a scrim and a dismiss, the other has a tab strip beside it — and
 * neither is the other one degraded. What must *not* be two things is the
 * conversation: one `ask`, one `thinking` state, one rule about when the send
 * control is live, one way a failure is worded.
 *
 * So the split is at the chrome. Everything above this line is the host's, and
 * everything below it is this file's, and the seam is exactly where the two
 * hosts stop agreeing.
 *
 * ## It decides nothing
 *
 * `conversation.ts` holds the state machine and this draws what it says — the
 * send control is live when `canAsk` is true rather than when this component
 * thinks it should be. That was true when this was inside `AgentPanel` and is
 * the property the extraction had to preserve, so it is stated here rather
 * than left in the file it moved out of.
 */

/** The placeholder, which is also the only instruction this surface gives. */
export const PROMPT_PLACEHOLDER = "Ask about this note, or anything in your context";

export function AgentConversation({
  engine,
  place,
  style,
  onDismissed,
}: {
  engine: AgentEngine;
  /** Where the person is, rebuilt by the host on every render. See `page.ts`. */
  place: AgentPage;
  /** The host's own sizing — a modal caps the transcript, a column fills. */
  style?: { transcript?: object };
  /**
   * Registered by a host that can go away with a turn in flight.
   *
   * The modal can: somebody presses the scrim and the card is gone. A column
   * can too — the toggle closes it. Either way the answer must land nowhere
   * rather than reopening a transcript somebody dismissed, and the host is
   * what knows it happened.
   */
  onDismissed?: (dismiss: () => void) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [conversation, setConversation] = useState<Conversation>(EMPTY_CONVERSATION);
  const [draft, setDraft] = useState("");

  /*
    Whether the turn now in flight still belongs to this surface.

    A ref rather than state because it is read inside a promise callback that
    must see the value as of *now*, not as of the render that created it.
  */
  const asking = useRef(false);

  const dismiss = useCallback(() => {
    // A turn in flight is abandoned rather than awaited: the person has left.
    asking.current = false;
  }, []);
  onDismissed?.(dismiss);

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

  const ready = canAsk(conversation);

  return (
    <>
      <ScrollView
        style={[styles.transcript, style?.transcript]}
        contentContainerStyle={styles.transcriptBody}
      >
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
    </>
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    transcript: { flexGrow: 0 },
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
    /*
      Carried over from `AgentPanel` verbatim, and that is the point of the
      move: an extraction that also restyled would make "did this change what
      anybody sees?" un-answerable from the diff.
    */
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

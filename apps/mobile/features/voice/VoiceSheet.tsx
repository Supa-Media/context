import { Modal, Pressable, StyleSheet, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import type { Audience } from "./audience";

/**
 * The question the microphone button asks, and the sentence it asks it beside.
 *
 * ## It opens every time, and that is the design rather than an oversight
 *
 * `useMeetingFlow` already holds this rule for meetings — "a remembered choice
 * preselects a row. It never skips the question. The sheet is where the
 * sentence about the audio lives" — and it applies here with one addition that
 * makes it stronger, not weaker: **this sheet is the only place a person is
 * told who can read what they are about to say.** Dictation has no destination
 * picker, because the destination is the note under the caret, so there is no
 * second surface where the audience could be disclosed instead. Skip this and
 * the disclosure does not move; it disappears.
 *
 * ## Two rows and a handoff, not two implementations
 *
 * Dictation starts here. **Recording a meeting does not** — the row opens
 * `DestinationSheet`, which is the meeting's own consent surface and carries
 * its own sentence about the audio and its own list of destinations. Putting a
 * destination picker on this sheet as well would fork the one surface
 * `docs/decisions/meetings.md` requires the record control to sit beside, and
 * two of them drift. So this sheet says what the next one will ask, and asks
 * nothing about meetings itself.
 */

export const SHEET_TITLE = "Voice capture";

/**
 * What happens to what you say, for the dictation half.
 *
 * Deliberately not `DestinationSheet`'s `AUDIO_SENTENCE`: that one is about a
 * recording this product makes — audio captured, transcribed by us, discarded.
 * Dictation captures no audio at all as far as Context is concerned, so
 * borrowing that sentence would describe a pipeline that does not exist here.
 *
 * **The first clause is the one that matters and it was wrong once.** An
 * earlier draft read "Your browser turns what you say into text", which is
 * true and, next to a promise about *our* handling of the audio, invites
 * somebody to read it as "so it never leaves this machine". Chrome's
 * `SpeechRecognition` sends audio to a service of Google's; Safari's may not.
 * Which one it is belongs to the browser and is not ours to claim either way,
 * so the sentence names the uncertainty rather than resolving it in the
 * direction that flatters us.
 */
export const DICTATION_SENTENCE =
  "Your browser does the listening — some browsers do it on the device, some send the sound to their own service. " +
  "Context never receives the audio, never stores it, and never puts it in your bucket. " +
  "Words appear at the caret as they settle; what is still being heard is grey and is not in the file yet.";

export const DICTATE_TITLE = "Dictate into this note";
export const MEETING_TITLE = "Record a meeting";
export const MEETING_SUB =
  "A new note you can type in while it runs. You will be asked where it goes.";

export const AGENT_TITLE = "Ask your context";
/**
 * Why the agent row says what it reads with rather than what it can do.
 *
 * "Ask questions about your notes" is the obvious sub, and it is the wrong
 * one: it describes a capability somebody already assumed and says nothing
 * about the thing they cannot see, which is *what reaches the model*. The two
 * rows above this one both spend their sub on exactly that — where the words
 * land, what happens to the audio — because this sheet is the one surface
 * where those facts are disclosed before anything opens.
 *
 * So this says the agent holds a grant of its own. That is the fact that makes
 * it revocable in the same place as every other client, makes its reads obey
 * `privacy.md`, and puts them in the audit trail under its own name.
 */
export const AGENT_SUB =
  "A conversation about what you have written. It reads through a grant of its own, so the same privacy rules apply and every read is in your audit trail.";

export function VoiceSheet({
  audience,
  refusal,
  notePath,
  compact,
  onDictate,
  onRecordMeeting,
  onAskAgent,
  onCancel,
}: {
  /** Who can read the open note, or `null` when dictation is not on offer. */
  audience: Audience | null;
  /** Why dictation is not on offer, or `null`. Exactly one of the two is set. */
  refusal: string | null;
  /** The open note, named on the dictate row so there is no doubt which. */
  notePath: string | null;
  compact: boolean;
  onDictate: () => void;
  onRecordMeeting: () => void;
  /**
   * Opens the conversation, or `null` where there is no context behind this
   * sheet to have a conversation about — the fixtures and the landing page's
   * demo console. The row is then not drawn at all.
   *
   * Not drawn rather than drawn-and-inert, which is the opposite of what the
   * dictate row does above, and deliberately: that row's refusal is a sentence
   * somebody can act on ("open a note first"). There is no equivalent sentence
   * here, because the surface simply is not part of the product — and a row
   * that is drawn and does nothing is a refusal wearing none of the words that
   * would explain it.
   */
  onAskAgent: (() => void) | null;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const canDictate = audience !== null;

  return (
    /*
      A phone's sheet slides up from the edge it is anchored to. A pointer
      layout's does not animate at all: it is a popover hanging off the button
      that was just pressed, and a card that fades in beside the control you are
      already looking at reads as a lag rather than as a transition.
    */
    <Modal transparent animationType={compact ? "slide" : "none"} onRequestClose={onCancel} visible>
      <Pressable
        style={[styles.scrim, compact ? styles.scrimCompact : styles.scrimPointer]}
        accessibilityLabel="Not now"
        onPress={onCancel}
      >
        {/* Swallow presses inside the card, so only the scrim closes it. */}
        <Pressable
          style={[styles.card, compact ? styles.cardCompact : styles.cardPointer]}
          onPress={() => {}}
          accessibilityLabel={SHEET_TITLE}
          testID="voice-sheet"
        >
          <Text variant="railHead" role="heading" aria-level={2} style={styles.head}>
            {SHEET_TITLE}
          </Text>

          <PressRow
            onPress={canDictate ? onDictate : undefined}
            accessibilityLabel={DICTATE_TITLE}
            testID="voice-sheet-dictate"
            radius={radii.control}
            style={[styles.row, canDictate && styles.rowOffered]}
            hoverStyle={canDictate ? styles.rowHovered : undefined}
          >
            <View style={[styles.glyph, canDictate && styles.glyphOffered]}>
              <Icon name="mic" size={17} color={canDictate ? colors.accent : colors.muted} />
            </View>
            <View style={styles.rowBody}>
              <Text variant="rowTitle" style={!canDictate && styles.dim}>
                {DICTATE_TITLE}
              </Text>
              {notePath === null ? null : (
                <Text variant="treeMetaMono" style={styles.path} numberOfLines={1}>
                  {notePath}
                </Text>
              )}
              {refusal === null ? null : (
                <Text variant="rowSub" testID="voice-sheet-refusal">
                  {refusal}
                </Text>
              )}
              {audience === null ? null : (
                <View
                  style={[styles.audience, audience.tone === "shared" && styles.audienceShared]}
                  testID="voice-sheet-audience"
                >
                  <Text
                    variant="rowSub"
                    style={audience.tone === "shared" ? styles.audienceSharedText : undefined}
                  >
                    {audience.line}
                  </Text>
                </View>
              )}
            </View>
          </PressRow>

          <PressRow
            onPress={onRecordMeeting}
            accessibilityLabel={MEETING_TITLE}
            testID="voice-sheet-meeting"
            radius={radii.control}
            style={styles.row}
            hoverStyle={styles.rowHovered}
          >
            <View style={styles.glyph}>
              <Icon name="clock" size={17} />
            </View>
            <View style={styles.rowBody}>
              <Text variant="rowTitle">{MEETING_TITLE}</Text>
              <Text variant="rowSub">{MEETING_SUB}</Text>
            </View>
          </PressRow>

          {/*
            Third, and offered unconditionally — unlike the dictate row above
            it, which needs a writable note for words to land in. A question has
            no destination, so "open a note first" would be a refusal with
            nothing behind it: somebody looking at a folder can perfectly well
            ask what is in it.
          */}
          {onAskAgent === null ? null : (
          <PressRow
            onPress={onAskAgent}
            accessibilityLabel={AGENT_TITLE}
            testID="voice-sheet-agent"
            radius={radii.control}
            style={styles.row}
            hoverStyle={styles.rowHovered}
          >
            <View style={styles.glyph}>
              <Icon name="chat" size={17} />
            </View>
            <View style={styles.rowBody}>
              <Text variant="rowTitle">{AGENT_TITLE}</Text>
              <Text variant="rowSub">{AGENT_SUB}</Text>
            </View>
          </PressRow>
          )}

          <Text variant="foot" style={styles.disclosure} testID="voice-sheet-disclosure">
            {DICTATION_SENTENCE}
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.scrim },
    scrimCompact: { justifyContent: "flex-end" },
    /*
      Bottom-right on a pointer layout, because that is where the button that
      opened it is: a card that appears in the middle of the screen makes
      somebody look away from the control they just pressed and back again.
    */
    scrimPointer: { justifyContent: "flex-end", alignItems: "flex-end" },
    card: {
      backgroundColor: colors.pageSurface,
      borderColor: colors.lineStrong,
      paddingVertical: 12,
      gap: 2,
      boxShadow: shadows.floating,
    },
    cardCompact: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      paddingBottom: 26,
    },
    cardPointer: {
      width: 404,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: radii.card,
      marginRight: 24,
      marginBottom: 116,
    },
    head: { paddingHorizontal: 16, paddingBottom: 8 },
    row: {
      flexDirection: "row",
      gap: 12,
      alignItems: "flex-start",
      marginHorizontal: 8,
      padding: 11,
      borderRadius: radii.control,
    },
    rowOffered: { backgroundColor: colors.accentDim },
    rowHovered: { backgroundColor: colors.chrome },
    rowBody: { flex: 1, gap: 3 },
    glyph: {
      width: 30,
      height: 30,
      borderRadius: radii.control,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.chipFill,
    },
    glyphOffered: { backgroundColor: colors.accentDim },
    dim: { color: colors.muted },
    path: { color: colors.text2 },
    audience: { paddingTop: 1 },
    /*
      The only hue on this sheet, and it is spent on the one fact somebody
      cannot see by looking at the note: a shared context looks exactly like
      your own. `iris` is already "somebody else's context" everywhere in this
      app (`design/tokens.ts`), so this borrows a meaning rather than inventing
      one.
    */
    audienceShared: {
      alignSelf: "flex-start",
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: radii.xs,
      backgroundColor: colors.sharedWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.sharedBorder,
    },
    audienceSharedText: { color: colors.sharedText },
    disclosure: {
      marginTop: 10,
      marginHorizontal: 16,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      fontFamily: fonts.body,
      fontSize: t.meta,
      color: colors.muted,
    },
  });

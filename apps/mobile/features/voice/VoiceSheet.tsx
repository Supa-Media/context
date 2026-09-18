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
 * recording — audio captured, transcribed, discarded. Dictation captures no
 * audio at all as far as this product is concerned. Claiming the recording
 * sentence here would be over-disclosing in a way that reads as evasive, and
 * claiming less would be worse.
 */
export const DICTATION_SENTENCE =
  "Your browser turns what you say into text. Context stores none of the audio and uploads none of it. " +
  "Words appear at the caret as they settle; what is still being heard is grey and is not in the file yet.";

export const DICTATE_TITLE = "Dictate into this note";
export const MEETING_TITLE = "Record a meeting";
export const MEETING_SUB =
  "A new note you can type in while it runs. You will be asked where it goes.";

export function VoiceSheet({
  audience,
  refusal,
  notePath,
  compact,
  onDictate,
  onRecordMeeting,
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
  onCancel: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const canDictate = audience !== null;

  return (
    <Modal transparent animationType={compact ? "slide" : "fade"} onRequestClose={onCancel} visible>
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

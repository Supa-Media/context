import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { describeDestination, type DestinationChoice } from "../destination";

/**
 * Where should this meeting go — asked before the microphone opens.
 *
 * ## This is a consent surface, and that is why it exists at all
 *
 * `docs/decisions/meetings.md` refuses a control that opens the microphone
 * without disclosure: the record button "lives on `/meetings`, beside the
 * sentence saying where the audio goes and what is kept — which is the
 * disclosure the decision requires, and it cannot be given by a row in a
 * navigation panel". A key in the phone's bottom row is one surface further
 * out than the row that was written about, and it has the same problem. This
 * sheet is the sentence, which is why the key opens it rather than the
 * microphone and why it opens **every time** — a remembered choice preselects
 * a row and never skips the question. See `useMeetingFlow`.
 *
 * ## It is the app's dialog, moved to the bottom edge
 *
 * A `Modal` with a scrim that closes on the scrim, a card that swallows its own
 * presses, `PressRow` for the rows and `Button` for the actions: the same parts
 * as `console/files/Dialogs.tsx`, which is where the shape is argued. What
 * differs is the edge it sits on — this one is reached with a thumb, from a key
 * in the bottom row, so the card is against the bottom of the screen and full
 * width rather than centred.
 *
 * ## It holds no rules
 *
 * Which destinations exist, which is selected, what each is called, who will
 * see it and why one is refused are all `destination.ts`'s, decided before this
 * renders. That is `console/capabilities.ts`'s measured lesson: every guard
 * expressed inside a component in this app was held by nothing.
 */

/** What the recording actually does with the audio. */
export const AUDIO_SENTENCE =
  "What you type and the transcript become one Markdown note in storage you own. " +
  "The audio is transcribed and then discarded — it is never written to your bucket.";

export function DestinationSheet({
  choice,
  selectedIndex,
  onSelect,
  onStart,
  onCancel,
  onClaimName,
  onOpenMeetings,
  blocked = null,
}: {
  choice: DestinationChoice;
  /** From `useMeetingFlow`, which folds presses through `chooseOffer`. */
  selectedIndex: number;
  onSelect: (index: number) => void;
  onStart: () => void;
  onCancel: () => void;
  /**
   * Why this device cannot start a recording at all, or `null`.
   *
   * Separate from an offer's `refusal`, which is about one destination. This
   * is about the app: the controller has not been pointed at a context yet, so
   * there is nothing to record into wherever you send it. Drawn the same way
   * for the same reason — dimmed with the sentence, never a control that
   * quietly does nothing.
   */
  blocked?: string | null;
  /** Absent when the caller has nowhere to send somebody to claim a name. */
  onClaimName?: () => void;
  /**
   * Go to the meetings already on this device. Absent draws no row.
   *
   * **This is a phone's only route to `/meetings`, which is why it is here and
   * not somewhere tidier.** A phone has no rail (`features/app/frame.ts`) and
   * the rail's entry was the app's only navigation to that list, so a finished
   * meeting was unreachable on the density that records them. The bottom row is
   * full at seven keys and cannot take an eighth (`bottomRowWidth.test.ts`), and
   * the account mark is the only sign-out a phone has — a menu in front of it
   * moves sign-out a press further away, which is the one control that must not
   * be missed. So it is a row on the sheet the meetings key already opens: the
   * same key, the same surface, both of the two things a person does with
   * meetings.
   */
  onOpenMeetings?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Modal transparent animationType="slide" onRequestClose={onCancel} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Not now" onPress={onCancel}>
        {/* Swallow presses inside the card so the scrim only closes on the scrim. */}
        <Pressable
          style={styles.card}
          onPress={() => {}}
          accessibilityLabel="Where should this meeting go?"
          testID="meeting-destination-sheet"
        >
          {/*
            The heading and the way to the meetings that already exist, on one
            line. Above the fork rather than inside the offers branch, because
            somebody who owns no brain to record into may still hold meetings
            recorded before they lost that membership — and the whole point of
            this row is that a finished meeting is never unreachable.
          */}
          <View style={styles.head}>
            <Text variant="paneTitle" role="heading" aria-level={2} style={styles.headTitle}>
              Where should this meeting go?
            </Text>
            {onOpenMeetings === undefined ? null : (
              <Button
                label="Past meetings"
                variant="ghost"
                onPress={onOpenMeetings}
                testID="meeting-destination-past"
              />
            )}
          </View>

          {choice.kind === "claimName" ? (
            <ClaimName onClaimName={onClaimName} onCancel={onCancel} />
          ) : (
            <>
              <View style={styles.rows}>
                {choice.offers.map((offer, index) => {
                  const chosen = index === selectedIndex;
                  const refused = offer.refusal !== null;
                  return (
                    <PressRow
                      key={describeDestination(offer.destination)}
                      accessibilityLabel={describeDestination(offer.destination)}
                      selected={chosen}
                      /*
                        A refused row keeps its handler rather than losing it.
                        `chooseOffer` is what declines the press, so the reason
                        is decided in one place instead of being half in a
                        prop; the row is dimmed and says why.
                      */
                      onPress={() => onSelect(index)}
                      radius={radii.lg}
                      style={[styles.row, refused && styles.rowRefused]}
                      hoverStyle={styles.rowHover}
                      selectedStyle={styles.rowOn}
                    >
                      {/*
                        `aria-checked` rather than a coloured border alone: this
                        is a single-choice list, and the selected row has to be
                        readable by something that cannot see the accent.
                      */}
                      <View
                        style={styles.rowBody}
                        role="radio"
                        aria-checked={chosen}
                        aria-disabled={refused}
                        testID={`meeting-destination-row-${index}`}
                      >
                        <Text variant="rowTitle" numberOfLines={1}>
                          {describeDestination(offer.destination)}
                        </Text>
                        <Text
                          variant="rowSub"
                          style={offer.tone === "warn" ? styles.warn : undefined}
                        >
                          {offer.audience}
                        </Text>
                        {offer.refusal !== null ? (
                          <Text variant="error">{offer.refusal}</Text>
                        ) : null}
                      </View>
                    </PressRow>
                  );
                })}
              </View>

              {/*
                The sentence and the control that starts the recording, in the
                same card. Separating them is what the decision refuses.
              */}
              <View style={styles.disclosure}>
                <Text variant="hint">{AUDIO_SENTENCE}</Text>
              </View>

              {blocked === null ? null : (
                <Text variant="error" testID="meeting-destination-blocked">
                  {blocked}
                </Text>
              )}

              <View style={styles.actions}>
                <Button
                  label="Not now"
                  onPress={onCancel}
                  testID="meeting-destination-cancel"
                />
                <Button
                  label="Start recording"
                  variant="white"
                  disabled={blocked !== null}
                  onPress={onStart}
                  testID="meeting-destination-start"
                />
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * The viewer owns no brain, so there is nowhere to record into yet.
 *
 * It offers the name rather than a recording, and it offers nothing at all when
 * the caller gave it nowhere to send them: a button whose only outcome is
 * nothing happening is worse than a sentence. An absent capability is reported,
 * never faked.
 */
function ClaimName({
  onClaimName,
  onCancel,
}: {
  onClaimName?: () => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      <Text variant="paneSub">
        You do not have a brain yet, so there is nowhere for a meeting to land.
        Claim your @name and it becomes your own context — meetings, notes and
        everything else, in storage you own.
      </Text>
      <View style={styles.actions}>
        <Button label="Not now" onPress={onCancel} testID="meeting-destination-cancel" />
        {onClaimName === undefined ? null : (
          <Button
            label="Claim your @name"
            variant="white"
            onPress={onClaimName}
            testID="meeting-destination-claim"
          />
        )}
      </View>
    </>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    justifyContent: "flex-end",
  },
  card: {
    borderTopWidth: 1,
    borderColor: colors.lineStrong,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    backgroundColor: colors.surface2,
    paddingTop: 22,
    /*
      The home indicator's worth of room below the last control. A sheet at the
      bottom edge of a phone is the one place in this app where a button can end
      up under the gesture bar.
    */
    paddingBottom: 34,
    paddingHorizontal: 24,
    gap: 14,
    boxShadow: "0 -40px 100px -30px rgba(0,0,0,1)",
  },
  /**
   * The title and the way out of the sheet, on one line.
   *
   * `flexWrap` rather than a fixed split: the title is a sentence and the
   * button's label is two words, and at 320pt they do not both fit on one line.
   * Wrapping puts the button under the title rather than squeezing either.
   */
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  headTitle: { flexShrink: 1 },
  rows: { gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
  },
  rowHover: { backgroundColor: colors.surface3 },
  rowOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  /** Dimmed rather than removed. See the offer's `refusal`. */
  rowRefused: { opacity: 0.55 },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  warn: { color: colors.crit },
  disclosure: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
});

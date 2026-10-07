import { describeForPerson, reportDevice } from "./device";
import { useState, type ReactNode } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { useFieldFont } from "../design/fieldFont";
import { fonts, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { MESSAGE_MAX, canSubmit } from "./model";
import type { Screenshot } from "./screenshot";

/**
 * The report itself: what happened, and the list of what goes with it.
 *
 * Every attachment is a row with a box. The message and the app version are
 * drawn ticked and cannot be unticked — they are the report — so nothing is
 * sent that is not on this list. Pressing "Send report" is agreeing to it.
 */

export type ShotState =
  | { kind: "taking" }
  | { kind: "none" }
  | { kind: "ready"; masked: Screenshot; shown: Screenshot | null; showingText: boolean };

/**
 * The fixed row's words. The versions themselves are the release Sentry
 * already tags every event with, so this names them rather than reading them.
 */
/** Exactly what goes, in words: the same values `transport.ts` sends. */
export function appAndDevice(): string {
  return describeForPerson(reportDevice());
}

export function FeedbackForm({
  title,
  message,
  onMessage,
  aboutError,
  activity,
  includeActivity,
  onIncludeActivity,
  shot,
  includeShot,
  onIncludeShot,
  onShowText,
  sending,
  onCancel,
  onSend,
}: {
  title: string;
  message: string;
  onMessage: (next: string) => void;
  aboutError: boolean;
  /** The log as it will be sent; empty when there is nothing in it. */
  activity: string;
  includeActivity: boolean;
  onIncludeActivity: (next: boolean) => void;
  shot: ShotState;
  includeShot: boolean;
  onIncludeShot: (next: boolean) => void;
  onShowText: (next: boolean) => void;
  sending: boolean;
  onCancel: () => void;
  onSend: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const [logOpen, setLogOpen] = useState(false);
  const ready = canSubmit(message) && !sending;

  return (
    <View style={styles.form}>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        {title}
      </Text>
      <Text variant="eyebrow">What happened?</Text>
      <TextInput
        style={[styles.message, fieldFont]}
        value={message}
        onChangeText={onMessage}
        placeholder="What happened?"
        placeholderTextColor={colors.muted}
        multiline
        maxLength={MESSAGE_MAX}
        autoFocus
        accessibilityLabel="What happened?"
        testID="feedback-message"
      />

      <Text variant="eyebrow">What we'll send</Text>
      <View style={styles.list}>
        <Item fixed first title="Your message" />
        <Item fixed title="App and device" sub={appAndDevice()} />
        {aboutError ? <Item fixed title="The error you just saw" /> : null}
        {activity === "" ? null : (
          <Item
            checked={includeActivity}
            onToggle={onIncludeActivity}
            title="The last 10 minutes in the app"
            sub="Screens opened and errors. No note text, titles or links."
            action={
              <TextLink
                label={logOpen ? "Hide" : "See it"}
                onPress={() => setLogOpen(!logOpen)}
                testID="feedback-activity-toggle"
              />
            }
            testID="feedback-activity"
          >
            {logOpen ? (
              <Text variant="mono" style={styles.log} selectable testID="feedback-activity-log">
                {activity}
              </Text>
            ) : null}
          </Item>
        )}
        {shot.kind === "taking" ? <Item fixed={false} checked={false} title="Taking a screenshot…" /> : null}
        {shot.kind === "ready" ? (
          <Item
            checked={includeShot}
            onToggle={onIncludeShot}
            title="Screenshot"
            sub={!includeShot ? "Not sent" : shot.showingText ? "Words shown" : "Words hidden"}
            lead={
              <Image
                source={{ uri: (shot.showingText && shot.shown ? shot.shown : shot.masked).previewUri }}
                style={[styles.thumb, includeShot ? null : styles.thumbOff]}
                resizeMode="cover"
                accessibilityLabel="Screenshot of the screen behind this report"
              />
            }
            action={
              includeShot ? (
                <View style={styles.shotActions}>
                  <TextLink
                    label={shot.showingText ? "Hide text" : "Show text"}
                    onPress={() => onShowText(!shot.showingText)}
                    testID="feedback-show-text"
                  />
                  <TextLink label="Remove" onPress={() => onIncludeShot(false)} testID="feedback-remove-shot" />
                </View>
              ) : undefined
            }
            testID="feedback-screenshot"
          />
        ) : null}
      </View>

      <View style={styles.foot}>
        <Text variant="hint" style={styles.consent}>
          Goes to the Context team only. We may reply by email.
        </Text>
        <View style={styles.buttons}>
          <Button label="Cancel" variant="dialog" onPress={onCancel} testID="feedback-cancel" />
          <Button
            label={sending ? "Sending…" : "Send report"}
            variant="dialogPrimary"
            onPress={onSend}
            disabled={!ready}
            testID="feedback-send"
          />
        </View>
      </View>
    </View>
  );
}

function Item({
  first = false,
  fixed = false,
  checked = true,
  onToggle,
  title,
  sub,
  lead,
  action,
  children,
  testID,
}: {
  fixed?: boolean;
  checked?: boolean;
  onToggle?: (next: boolean) => void;
  title: string;
  sub?: string;
  lead?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testID?: string;
  first?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const box = (
    <View style={[styles.box, checked ? styles.boxOn : null, fixed ? styles.boxFixed : null]}>
      {checked ? <Text style={[styles.tick, fixed ? styles.tickFixed : null]}>✓</Text> : null}
    </View>
  );
  return (
    <View style={[styles.item, first ? styles.itemFirst : null]} testID={testID}>
      <View style={styles.itemRow}>
        {fixed || onToggle === undefined ? (
          <View accessibilityLabel={`${title}, always sent`}>{box}</View>
        ) : (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
            accessibilityLabel={`Send ${title.toLowerCase()}`}
            onPress={() => onToggle(!checked)}
            hitSlop={8}
            testID={testID === undefined ? undefined : `${testID}-box`}
          >
            {box}
          </Pressable>
        )}
        {lead}
        <View style={styles.itemText}>
          <Text variant="rowTitle">{title}</Text>
          {sub === undefined ? null : <Text variant="rowSub">{sub}</Text>}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    form: { gap: 10 },
    message: {
      fontFamily: fonts.body,
      fontSize: t.ui,
      color: colors.text,
      minHeight: 88,
      maxHeight: 200,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
      textAlignVertical: "top",
    },
    list: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.lg,
      overflow: "hidden",
    },
    item: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      gap: 6,
    },
    itemFirst: { borderTopWidth: 0 },
    itemRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    itemText: { flex: 1, minWidth: 0, gap: 1 },
    box: {
      width: 16,
      height: 16,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.muted,
      alignItems: "center",
      justifyContent: "center",
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    boxFixed: { backgroundColor: colors.surface3, borderColor: colors.surface3 },
    tick: { fontSize: t.label, lineHeight: 13, color: colors.ink, fontWeight: "700" },
    tickFixed: { color: colors.muted },
    thumb: {
      width: 64,
      height: 40,
      borderRadius: 5,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface3,
    },
    shotActions: { flexDirection: "row", gap: 12 },
    thumbOff: { opacity: 0.4 },
    log: { fontSize: t.label, lineHeight: 17, color: colors.text2 },
    foot: { gap: 10, marginTop: 2 },
    consent: { color: colors.muted },
    buttons: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  });

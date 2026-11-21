import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useFieldFont } from "../../design/fieldFont";
import { pointerType, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * The face of a card Tex holds for the person's OK: one shell, drawn the same for a held email (`TexAskCard`) and for
 * a held call from an AI client (`TexApprovalCard`).
 *
 * Draws what it is given and decides nothing. The head says where the card is, the fields and the body say what would
 * go, and the actions are whatever the caller passes. A body with `onChangeText` is edited in place: the caller holds
 * the words, so a press of Send can send them.
 */

/** The head's tint: a card waiting for the person (`warn`), sent (`ok`), or held and gone (`muted`). */
export type FaceTone = "warn" | "ok" | "muted";

export interface FaceHead {
  tone: FaceTone;
  icon: "lock" | "check" | null;
  text: string;
  testID?: string;
}

export interface FaceField {
  label: string;
  value: string;
}

export interface FaceBody {
  /** The words, as they are drawn (and, when editable, as they are typed). */
  value: string;
  /** Present when the words can be changed in place. */
  onChangeText?: (text: string) => void;
  testID?: string;
  /** What a screen reader says the editable words are. */
  label: string;
}

/** Styles that could not be written in `StyleSheet` without a cast: the browser's word wrap, and no outline on a field. */
const WRAP_ANYWHERE = { overflowWrap: "anywhere" } as unknown as TextStyle;
const NO_OUTLINE = { outlineWidth: 0 } as unknown as TextStyle;

/** Fixed sizes from the mock: a reply button is 24 round, its arrow 14. */
const REPLY_SIZE = 24;
const ARROW_SIZE = 14;

export function AskFace({
  testID,
  head,
  onReply,
  replyTestID,
  fields,
  title,
  body,
  actions,
  footer,
}: {
  testID: string;
  head: FaceHead;
  /** The reply arrow at the head's right. Absent when the card has nothing to reply to, and on a sent card. */
  onReply?: () => void;
  replyTestID?: string;
  fields?: FaceField[];
  /** A line under the head, in the card's own words (an ask that is not one email). */
  title?: string;
  body?: FaceBody;
  /** The buttons or the sending line. `null` or absent leaves the row out. */
  actions?: ReactNode;
  /** Small words under the actions. */
  footer?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const ink = toneInk(colors, head.tone);
  return (
    <View style={styles.shell} testID={testID}>
      <View style={[styles.head, { backgroundColor: toneWash(colors, head.tone) }]}>
        {head.icon !== null ? <Icon name={head.icon} size={14} color={ink} /> : null}
        <Text style={[styles.headText, { color: ink }]} testID={head.testID}>
          {head.text}
        </Text>
        {onReply !== undefined ? (
          <Pressable
            onPress={onReply}
            accessibilityRole="button"
            accessibilityLabel="Reply to this"
            style={styles.reply}
            testID={replyTestID}
          >
            <Svg width={ARROW_SIZE} height={ARROW_SIZE} viewBox="0 0 24 24" fill="none">
              <Path d="M9 14 4 9l5-5" stroke={ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <Path d="M4 9h10a6 6 0 0 1 6 6v4" stroke={ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </Svg>
          </Pressable>
        ) : null}
      </View>

      {fields !== undefined && fields.length > 0 ? (
        <View style={styles.fields}>
          {fields.map((field) => (
            <View key={field.label} style={styles.field}>
              <Text variant="foot" style={styles.label}>
                {field.label}
              </Text>
              <Text variant="foot" style={styles.value} selectable>
                {field.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {title !== undefined && title.length > 0 ? (
        <Text style={styles.title} selectable>
          {title}
        </Text>
      ) : null}

      {body !== undefined ? <BodyBox body={body} /> : null}

      {actions !== undefined && actions !== null ? <View style={styles.actions}>{actions}</View> : null}

      {footer !== undefined && footer !== null ? (
        <View style={styles.footer}>
          {typeof footer === "string" ? (
            <Text variant="meta" style={styles.footerText}>
              {footer}
            </Text>
          ) : (
            footer
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The body box. Read-only words are a box of text; editable words are a field styled the same, with a 1px line ring on
 * hover and, on focus, the ground behind it and a 2px accent ring. The rings are drawn over the box, so nothing moves.
 */
function BodyBox({ body }: { body: FaceBody }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const fieldFont = useFieldFont(pointerType.ui);

  if (body.onChangeText === undefined) {
    return (
      <View style={styles.bodyBox} testID={body.testID}>
        <Text style={styles.bodyText} selectable>
          {body.value}
        </Text>
      </View>
    );
  }

  return (
    <Pressable onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={styles.bodyWrap}>
      {/* The box grows to its words, so the whole email shows (the mock). An invisible copy of the words, in the same
          box and type, gives the box its height, and the field fills it: nothing is measured or kept, so nothing can
          loop. The trailing line leaves room for the line being typed. */}
      <Text style={[styles.bodyBox, styles.bodyText, styles.bodyInput, fieldFont, styles.bodyMirror]} aria-hidden testID={`${body.testID}-mirror`}>
        {`${body.value}\n`}
      </Text>
      <TextInput
        value={body.value}
        onChangeText={body.onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        multiline
        scrollEnabled={false}
        textAlignVertical="top"
        accessibilityLabel={body.label}
        testID={body.testID}
        style={[styles.bodyBox, styles.bodyText, styles.bodyInput, styles.bodyField, fieldFont, focused && { backgroundColor: colors.ground }, NO_OUTLINE]}
      />
      <View
        pointerEvents="none"
        style={[
          styles.ring,
          focused ? { borderWidth: 2, borderColor: colors.accent } : hovered ? { borderWidth: 1, borderColor: colors.line } : null,
        ]}
      />
    </Pressable>
  );
}

/** The body box's padding. */
const BODY_PAD = 10;
/** The least height of an editable body; past it the box grows to its words. */
const MIN_BODY = 60;


/** One button of a card's row: `primary` is the accent fill, `ghost` plain muted words with no line and no fill (the mock). */
export function AskButton({
  label,
  variant,
  disabled,
  onPress,
  accessibilityLabel,
  testID,
}: {
  label: string;
  variant: "primary" | "ghost";
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const primary = variant === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled === true }}
      style={[styles.button, primary ? styles.buttonPrimary : styles.buttonGhost, disabled === true && styles.buttonDisabled]}
      testID={testID}
    >
      <Text style={[styles.buttonText, primary ? styles.buttonTextPrimary : styles.buttonTextGhost]}>{label}</Text>
    </Pressable>
  );
}

/** The row that stands in for the buttons while a card is being sent. */
export function SendingLine({ testID }: { testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.sending}>
      <ActivityIndicator size="small" />
      <Text style={styles.sendingText} testID={testID}>
        Sending…
      </Text>
    </View>
  );
}

/** A clock time as the head writes it: 9:05 AM. */
export function clockOf(at: number): string {
  const date = new Date(at);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

function toneInk(colors: Colors, tone: FaceTone): string {
  if (tone === "warn") return colors.warn;
  if (tone === "ok") return colors.ok;
  return colors.muted;
}

function toneWash(colors: Colors, tone: FaceTone): string {
  if (tone === "warn") return colors.warnWash;
  if (tone === "ok") return colors.okWash;
  return colors.surface3;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    shell: {
      alignSelf: "stretch",
      maxWidth: "100%",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 14,
      backgroundColor: colors.ground,
      overflow: "hidden",
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: 9,
      paddingHorizontal: space.x3,
    },
    headText: { flexShrink: 1, fontSize: pointerType.meta, lineHeight: 16, fontWeight: "600" },
    reply: {
      marginLeft: "auto",
      width: REPLY_SIZE,
      height: REPLY_SIZE,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      opacity: 0.7,
    },
    fields: { paddingTop: space.x2, paddingHorizontal: space.x3, gap: 2 },
    field: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    label: { width: 56, fontSize: pointerType.meta, lineHeight: 17, color: colors.chromeMuted },
    value: { flex: 1, minWidth: 0, fontSize: pointerType.meta, lineHeight: 17, color: colors.text2, ...WRAP_ANYWHERE },
    title: {
      paddingTop: space.x2,
      paddingHorizontal: space.x3,
      fontSize: pointerType.ui,
      lineHeight: 19,
      fontWeight: "500",
      color: colors.text,
    },
    bodyWrap: { marginVertical: space.x2, marginHorizontal: space.x3, position: "relative" },
    bodyBox: {
      marginVertical: space.x2,
      marginHorizontal: space.x3,
      padding: BODY_PAD,
      borderRadius: 9,
      backgroundColor: colors.surface2,
    },
    bodyText: { fontSize: pointerType.ui, lineHeight: 19, color: colors.text },
    bodyInput: { marginVertical: 0, marginHorizontal: 0, minHeight: MIN_BODY },
    bodyMirror: { opacity: 0 },
    bodyField: { ...StyleSheet.absoluteFillObject, minHeight: 0 },
    ring: { ...StyleSheet.absoluteFillObject, borderRadius: 9 },
    actions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: space.x3,
      paddingBottom: space.x3,
    },
    button: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1 },
    buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    buttonGhost: { backgroundColor: "transparent", borderColor: "transparent" },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600" },
    buttonTextPrimary: { color: colors.ink },
    buttonTextGhost: { color: colors.muted },
    sending: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingHorizontal: space.x3, paddingBottom: space.x3 },
    sendingText: { fontSize: pointerType.meta, color: colors.muted },
    footer: { paddingHorizontal: space.x3, paddingBottom: 10 },
    footerText: { color: colors.muted },
  });

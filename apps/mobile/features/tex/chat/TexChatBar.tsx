import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { radii, texChatType } from "../../design/tokens";
import type { Shadows } from "../../design/tokens";
import { TAPBACKS, type ReactionEmoji } from "./appChatGateway";

/** How long the bar takes to fade in and rise, in ms. */
const FADE_MS = 120;
/** How far the bar rises into place, in points. */
const RISE = 4;

export interface TexChatBarProps {
  /** The row's id, for the testIDs. */
  rowId: string;
  /** The row's plain text, which Copy writes to the clipboard. */
  text: string;
  mine: boolean;
  /** The person's own tapback on this row, drawn lit. */
  ownReaction: string | undefined;
  /** Edit is offered on the person's own rows that can still be edited. */
  canEdit: boolean;
  /** Unsend is offered on the person's own rows that can be unsent or edited. */
  canUnsend: boolean;
  /** Skips the fade and the rise. The parent resolves this once, so the bar never waits on it. */
  reduced: boolean;
  onReact: (emoji: ReactionEmoji) => void;
  onReply: () => void;
  onEdit: () => void;
  onUnsend: () => void;
  /** Called after Copy has written the text. */
  onCopied?: () => void;
  /** The pointer reaching and leaving the bar, which the row counts as its own hover (web). */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

/**
 * The hover bar on a Tex chat bubble: the six tapbacks, then Reply, Copy and
 * the person's own Edit and Unsend.
 *
 * It is absolutely placed above the bubble, so showing it moves nothing below
 * it. The parent mounts it only while the row is hovered, focused or pinned,
 * and that mount is what fades it in.
 */
export function TexChatBar(props: TexChatBarProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { rowId, mine, reduced } = props;
  const fade = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) return;
    Animated.timing(fade, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
  }, [fade, reduced]);

  const copy = () => {
    copyText(props.text);
    props.onCopied?.();
  };

  return (
    <Animated.View
      style={[
        styles.bar,
        mine ? styles.barMine : styles.barTheirs,
        {
          opacity: fade,
          transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [RISE, 0] }) }],
        },
      ]}
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      testID={`tex-bar-${rowId}`}
    >
      {TAPBACKS.map((emoji) => {
        const own = props.ownReaction === emoji;
        return (
          <Pressable
            key={emoji}
            onPress={() => props.onReact(emoji)}
            accessibilityRole="button"
            accessibilityLabel={`React ${emoji}`}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, own && styles.own, hovered === true && styles.hover]}
            testID={`tex-tapback-${rowId}-${emoji}`}
          >
            <Text style={styles.emoji}>{emoji}</Text>
          </Pressable>
        );
      })}

      <View style={styles.separator} />

      <IconButton
        icon="reply"
        label="Reply"
        testID={`tex-reply-${rowId}`}
        onPress={props.onReply}
        color={colors.muted}
        styles={styles}
      />
      <IconButton icon="copy" label="Copy" testID={`tex-copy-${rowId}`} onPress={copy} color={colors.muted} styles={styles} />
      {props.canEdit ? (
        <IconButton icon="pencil" label="Edit" testID={`tex-edit-${rowId}`} onPress={props.onEdit} color={colors.muted} styles={styles} />
      ) : null}
      {props.canUnsend ? (
        <IconButton icon="undo" label="Unsend" testID={`tex-unsend-${rowId}`} onPress={props.onUnsend} color={colors.muted} styles={styles} />
      ) : null}
    </Animated.View>
  );
}

function IconButton({
  icon,
  label,
  testID,
  onPress,
  color,
  styles,
}: {
  icon: "reply" | "copy" | "pencil" | "undo";
  label: string;
  testID: string;
  onPress: () => void;
  color: string;
  styles: Styles;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered === true && styles.hover]}
      testID={testID}
    >
      <Icon name={icon} size={15} color={color} />
    </Pressable>
  );
}

/**
 * Writes the text to the clipboard when the browser offers one. Refusal is
 * silent: the person sees the bar's Copy go, and nothing else is promised.
 */
function copyText(text: string): void {
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      Promise.resolve(clipboard.writeText(text)).catch(() => {});
    }
  } catch {
    // No usable clipboard on this surface.
  }
}

type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    bar: {
      position: "absolute",
      top: -38,
      zIndex: 5,
      flexDirection: "row",
      alignItems: "center",
      gap: 1,
      paddingVertical: 3,
      paddingHorizontal: 4,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.ground,
      boxShadow: shadows.floating,
    },
    barMine: { right: 0 },
    barTheirs: { left: 0 },
    button: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    hover: { backgroundColor: colors.surface3, transform: [{ scale: 1.18 }] },
    own: { backgroundColor: colors.accentDim },
    emoji: { fontSize: texChatType.tapback, lineHeight: 18 },
    separator: { width: 1, height: 18, marginHorizontal: 3, backgroundColor: colors.line },
  });

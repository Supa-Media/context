import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space, touchType } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import type { NoteActionId } from "./layout/noteActions";

/** What the note bar can offer: a note's own actions, and asking the AI. */
export type NoteQuickId = Extract<NoteActionId, "share" | "moveTo" | "copyLink"> | "ask";

export interface NoteQuick {
  id: NoteQuickId;
  label: string;
  icon: IconName;
}

const QUICK: Record<NoteQuickId, Omit<NoteQuick, "id">> = {
  share: { label: "Share", icon: "share" },
  copyLink: { label: "Copy link", icon: "link" },
  moveTo: { label: "Move", icon: "folder" },
  ask: { label: "Ask AI", icon: "sparkle" },
};

/**
 * Which quick actions a note gets, in order: the ones of its own actions this
 * person may use (`noteActionItems` decides, so the bar and the ••• sheet
 * cannot disagree), then Ask AI where there is an AI to ask.
 *
 * Share and Copy link are one slot: whoever can share gets Share, whose sheet
 * has Copy link in it; a visitor gets Copy link.
 */
export function noteQuickActions(available: readonly NoteActionId[], canAsk: boolean): NoteQuick[] {
  const ids: NoteQuickId[] = [];
  if (available.includes("share")) ids.push("share");
  else if (available.includes("copyLink")) ids.push("copyLink");
  if (available.includes("moveTo")) ids.push("moveTo");
  if (canAsk) ids.push("ask");
  return ids.map((id) => ({ id, ...QUICK[id] }));
}

/**
 * THE PHONE'S BOTTOM BAR, WHILE A NOTE IS OPEN: THE NOTE'S OWN ACTIONS.
 *
 * The owner's review (2026-10-01): *"we probably dont need the search bar when
 * we are in a note, we should fill the bottom with other useful quick
 * actions"*. Searching from inside a note means leaving it, and Home and every
 * folder page still have the field; what a note's bottom edge is for is doing
 * something *to the note*. Apple Notes' bar in a note is the same shape — a row
 * of the note's tools, and the compose button at the end.
 *
 * Formatting is not here: it is the keyboard's own accessory bar, which is up
 * whenever there is a caret to format at (`NoteAccessory`).
 */
export function NoteQuickBar({
  actions,
  onAction,
}: {
  actions: readonly NoteQuick[];
  onAction: (id: NoteQuickId) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.capsule} testID="note-quick-bar" role="toolbar" aria-label="Note actions">
      {actions.map((action) => (
        <Pressable
          key={action.id}
          onPress={() => onAction(action.id)}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => [styles.key, pressed ? styles.pressed : null]}
          testID={`note-quick-${action.id}`}
        >
          <Icon name={action.icon} size={20} color={colors.text} />
          <Text variant="meta" style={styles.caption} numberOfLines={1}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const FIELD_HEIGHT = 50;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    capsule: {
      flex: 1,
      flexDirection: "row",
      alignItems: "stretch",
      height: FIELD_HEIGHT,
      paddingHorizontal: space.x2,
      borderRadius: radii.pill,
      overflow: "hidden",
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    key: { flex: 1, alignItems: "center", justifyContent: "center", gap: 1, borderRadius: radii.pill },
    pressed: { backgroundColor: colors.surface2 },
    caption: { fontSize: touchType.label, color: colors.text2 },
  });

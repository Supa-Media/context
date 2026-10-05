import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../design/components/Icon";
import { radii, space } from "../design/tokens";
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
 *
 * **Icons only, in a capsule that fits them (owner, 2026-10-05: "the bottom
 * row looks so stupid right now").** It used to stretch the full width with a
 * caption under each icon, so two actions became a wide white slab with two
 * small words floating in it. The same short row of round keys Obsidian and
 * Notion keep at a phone's bottom edge (the owner's reference, 2026-09-27);
 * each key still says its name to a screen reader.
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
    <View style={styles.row}>
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
            <Icon name={action.icon} size={21} color={colors.text} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const FIELD_HEIGHT = 50;
/** A round key, inside the capsule's 3pt rim: the 44pt touch floor. */
const KEY = 44;

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    // Takes the bar's room so the compose button stays at the far end.
    row: { flex: 1, flexDirection: "row", alignItems: "center" },
    capsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: FIELD_HEIGHT,
      paddingHorizontal: (FIELD_HEIGHT - KEY) / 2,
      borderRadius: radii.pill,
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    key: { width: KEY, height: KEY, alignItems: "center", justifyContent: "center", borderRadius: KEY / 2 },
    pressed: { backgroundColor: colors.surface2 },
  });

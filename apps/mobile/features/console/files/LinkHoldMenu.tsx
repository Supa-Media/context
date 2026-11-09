import { useEffect } from "react";
import { Linking, Modal, Pressable, StyleSheet, View } from "react-native";
import { writeClipboard } from "../../design/clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../design/components/Icon";
import type { IconName } from "../../design/components/icons/names";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { HeldLink } from "./linkHold";
import { liftTap } from "./liftTap";
import type { EditorControls } from "./liveEditorWeb/contract";
import type { NoteLinkOpen } from "./noteLinks";
import { webUrl } from "./webUrl";

export type LinkHoldAction = "open" | "edit" | "copy" | "remove";

/** Which rows a held link's menu offers: editing only where the note can be changed. */
export function linkHoldActions(link: HeldLink, editable: boolean): LinkHoldAction[] {
  return [
    "open",
    ...(editable ? (["edit"] as const) : []),
    ...(link.url === undefined ? [] : (["copy"] as const)),
    ...(editable && link.removable ? (["remove"] as const) : []),
  ];
}

/**
 * What each row does. Open goes where a tap on the link goes; Edit link hands
 * the link's words to the Link sheet (`ask`), whose pick replaces the link.
 */
export function runLinkHold(
  action: LinkHoldAction,
  link: HeldLink,
  to: {
    controls: EditorControls | null;
    openNote?: (path: string, mode: NoteLinkOpen, anchor?: string) => void;
    ask: (text: string) => void;
  },
): void {
  switch (action) {
    case "open":
      if (link.path !== undefined) to.openNote?.(link.path, "foreground", link.anchor);
      else if (link.url !== undefined && webUrl(link.url) === link.url) void Linking.openURL(link.url).catch(() => {});
      return;
    case "edit":
      to.controls?.editLink(to.ask);
      return;
    case "copy":
      if (link.url !== undefined) void writeClipboard(link.url);
      return;
    case "remove":
      to.controls?.unlink();
      return;
  }
}

const ROWS: Record<LinkHoldAction, { label: string; icon: IconName }> = {
  open: { label: "Open", icon: "openTab" },
  edit: { label: "Edit link", icon: "pencil" },
  copy: { label: "Copy link", icon: "copy" },
  remove: { label: "Remove link", icon: "close" },
};

/**
 * Holding a link in a note (owner, 2026-11-09): the link's words and where it
 * goes, and a short menu under them, in the hold menu's look (`HoldMenu.tsx`).
 * Tapping the card opens the link, as a tap on the link itself does; tapping
 * anywhere else puts the menu away. See `linkHold.ts` for the gesture.
 */
export function LinkHoldMenu({
  link,
  editable,
  onRun,
  onDismiss,
}: {
  link: HeldLink;
  editable: boolean;
  onRun: (action: LinkHoldAction) => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  useEffect(liftTap, []);
  const run = (action: LinkHoldAction) => {
    onDismiss();
    onRun(action);
  };
  const where = link.url ?? link.path ?? "";

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        style={[StyleSheet.absoluteFill, styles.scrim]}
        accessibilityLabel="Close"
        onPress={onDismiss}
        testID="link-hold-scrim"
      >
        <View style={[styles.content, { paddingTop: insets.top + space.x6 }]}>
          <Pressable
            onPress={() => run("open")}
            accessibilityRole="button"
            accessibilityLabel={`Open ${link.label}`}
            style={styles.card}
            testID="link-hold-card"
          >
            <View style={styles.cardHead}>
              <Icon name="link" size={18} color={colors.accent} />
              <Text variant="rowTitle" numberOfLines={2} style={styles.label}>
                {link.label}
              </Text>
            </View>
            {where === "" || where === link.label ? null : (
              <Text variant="rowSub" numberOfLines={2} style={styles.where} testID="link-hold-where">
                {where}
              </Text>
            )}
          </Pressable>
          <View style={styles.menu} testID="link-hold-menu">
            {linkHoldActions(link, editable).map((action, index) => (
              <Pressable
                key={action}
                onPress={() => run(action)}
                accessibilityRole="button"
                accessibilityLabel={ROWS[action].label}
                style={({ pressed }) => [styles.line, index > 0 && styles.ruled, pressed && styles.pressed]}
                testID={`link-hold-${action}`}
              >
                <Icon name={ROWS[action].icon} size={18} color={action === "remove" ? colors.critText : colors.text} />
                <Text variant="body" style={[styles.lineLabel, action === "remove" && { color: colors.critText }]}>
                  {ROWS[action].label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { backgroundColor: colors.scrim },
    content: { paddingHorizontal: space.x5, gap: space.x3, alignItems: "center" },
    card: {
      alignSelf: "stretch",
      backgroundColor: colors.pageSurface,
      borderRadius: 22,
      padding: space.x4,
      boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    },
    cardHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    label: { flex: 1, color: colors.text },
    where: { color: colors.muted, marginTop: space.x1 },
    menu: {
      width: 260,
      backgroundColor: colors.surface3,
      borderRadius: radii.floating,
      overflow: "hidden",
      boxShadow: "0 16px 50px rgba(0,0,0,0.4)",
    },
    line: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingHorizontal: space.x4, minHeight: 46 },
    ruled: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    lineLabel: { flex: 1, color: colors.text },
    pressed: { backgroundColor: colors.chromePressed },
  });

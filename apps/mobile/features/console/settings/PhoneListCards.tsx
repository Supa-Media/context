import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Dot } from "../../design/components/Dot";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { atName } from "../format";
import { isOwnWorkspace } from "../rail";
import type { ConsoleContext, ConsoleData } from "../types";
import { useWorkspaceIcons } from "../useWorkspaceIcons";
import { WorkspaceMark } from "../WorkspaceMark";

/*
  The two cards a phone's settings list adds around its rows (Dev2,
  2026-11-06, board 2 of project files `settings-redesign-2026-11-06/`): you
  at the top, and the head of the workspace card. `SettingsList` draws the
  rows; these are in their own file so that list stays one responsibility.
*/

/**
 * A phone's first card: you, and the way into Profile (Dev2, 2026-11-06,
 * board 2). Your personal workspace's own picture where you have one, your
 * @name and email beside it, and a chevron because it pushes Profile.
 */
export function ProfileCard({ data, onPress }: { data: ConsoleData; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const iconFor = useWorkspaceIcons();
  const own = data.contexts.find(isOwnWorkspace);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Profile, ${data.viewer.name}`}
      onPress={onPress}
      style={[styles.card, styles.profile]}
      testID="settings-profile-card"
    >
      {own === undefined ? (
        <View style={[styles.tile, styles.profileTile]}>
          <Text style={styles.profileLetter}>{data.viewer.initial}</Text>
        </View>
      ) : (
        <WorkspaceMark label={atName(own.slug)} tone={own.status} icon={iconFor(own)} size={PROFILE_MARK} />
      )}
      <View style={styles.profileText}>
        <Text numberOfLines={1} style={styles.profileName}>
          {data.viewer.name}
        </Text>
        {data.viewer.detail === undefined || data.viewer.detail === "" ? null : (
          <Text numberOfLines={1} style={styles.profileDetail}>
            {data.viewer.detail}
          </Text>
        )}
      </View>
      <Icon name="chevronRight" size={13} color={colors.muted} />
    </Pressable>
  );
}

/**
 * The head of a phone's workspace card: which workspace every row under it is
 * about, in its own picture rather than a letter, and Switch at the right
 * (Dev2, 2026-11-06, board 2). Open, the other workspaces are listed inside
 * the same card, each with the health dot the old box carried.
 */
export function WorkspaceCardHead({
  contexts,
  current,
  onSwitchContext,
}: {
  contexts: readonly ConsoleContext[];
  current: ConsoleContext;
  onSwitchContext?: (slug: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const iconFor = useWorkspaceIcons();
  const [open, setOpen] = useState(false);
  const kind = (context: ConsoleContext) => (context.kind === "shared" ? "Shared" : "Personal");
  return (
    <View style={styles.wsHeadWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${atName(current.slug)}, ${kind(current)} workspace. Switch workspace`}
        aria-expanded={open}
        onPress={() => setOpen((was) => !was)}
        style={styles.wsHead}
        testID="settings-workspace-switcher"
      >
        <WorkspaceMark label={atName(current.slug)} tone={current.status} icon={iconFor(current)} size={WORKSPACE_MARK} />
        <View style={styles.profileText}>
          <Text numberOfLines={1} style={styles.wsName}>
            {atName(current.slug)}
          </Text>
          <Text numberOfLines={1} style={styles.wsKind}>
            {kind(current)}
          </Text>
        </View>
        {contexts.length > 1 ? (
          <View style={styles.wsSwitch}>
            <Text style={styles.wsSwitchLabel}>Switch</Text>
            <Icon name={open ? "chevronUp" : "chevronDown"} size={13} color={colors.accent} />
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <View testID="settings-workspace-menu">
          {contexts.map((context) => {
            const here = context.id === current.id;
            return (
              <Pressable
                key={context.id}
                accessibilityRole="button"
                accessibilityState={{ selected: here }}
                aria-current={here ? "true" : undefined}
                accessibilityLabel={atName(context.slug)}
                testID={`settings-context-${context.slug}`}
                onPress={() => {
                  setOpen(false);
                  if (!here) onSwitchContext?.(context.slug);
                }}
                style={styles.wsOption}
              >
                <WorkspaceMark label={atName(context.slug)} tone={context.status} icon={iconFor(context)} size={24} />
                <Text numberOfLines={1} style={[styles.label, styles.wsOptionLabel]}>
                  {atName(context.slug)}
                </Text>
                <View style={styles.spacer} />
                <Dot tone={context.status} />
                {here ? <Icon name="check" size={15} color={colors.accent} /> : <View style={styles.checkSpace} />}
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const PROFILE_MARK = 48;
const WORKSPACE_MARK = 34;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.sheet,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    tile: { alignItems: "center", justifyContent: "center", backgroundColor: colors.accentDim },
    label: { flexShrink: 1 },
    spacer: { flexGrow: 1, minWidth: space.x2 },
    profile: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      marginTop: space.x4,
      paddingVertical: space.x3,
      paddingHorizontal: space.x3,
    },
    profileTile: { width: PROFILE_MARK, height: PROFILE_MARK, borderRadius: 13 },
    profileLetter: { fontSize: touchType.h2, fontWeight: "700", color: colors.accentText },
    profileText: { flex: 1, minWidth: 0, gap: 2 },
    profileName: { fontSize: touchType.h3 - 1, fontWeight: "600", color: colors.text },
    profileDetail: { fontSize: touchType.meta + 2, color: colors.muted },
    wsHeadWrap: { borderBottomWidth: 1, borderBottomColor: colors.line },
    wsHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 56,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
    },
    wsName: { fontSize: touchType.body, fontWeight: "600", color: colors.text },
    wsKind: { fontSize: touchType.meta + 1, color: colors.muted },
    wsSwitch: { flexDirection: "row", alignItems: "center", gap: space.x1 },
    wsSwitchLabel: { fontSize: touchType.ui - 1, color: colors.accentText },
    wsOption: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: layout.minTouchTarget,
      paddingHorizontal: space.x3,
    },
    wsOptionLabel: { fontSize: touchType.ui, color: colors.text },
    checkSpace: { width: 15 },
  });

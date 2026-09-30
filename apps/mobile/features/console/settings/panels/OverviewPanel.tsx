import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { atName } from "../../format";
import { WorkspaceNameField } from "./WorkspaceNameField";
import { selectedContext, type ConsoleData } from "../../types";
import type { SettingsSectionKey } from "../sections";
import { useWorkspaceIcons } from "../../useWorkspaceIcons";
import { WorkspaceIconPicker, WorkspaceMonogram } from "./WorkspaceIconPicker";
import { YourPicture } from "./YourPicture";

/**
 * Settings › General: this workspace's name and picture.
 *
 * The approved settings artboard (2026-09-29) draws one card: the picture,
 * the name in large type, a line saying the address, the kind and your role,
 * a "Change picture" button, and under a hairline the Name field. The health
 * strip that used to follow ("Connected — R2 · bucket") is gone from here: the
 * settings list says "Healthy" beside Storage & search, and that section
 * leads with the same word, so a third copy was the page repeating itself.
 *
 * What an owner can change and what everybody else sees are the same card:
 * a member sees the name in a field that does not take typing and no button,
 * absent rather than disabled, the catalogue's own rule.
 */
export function OverviewPanel({
  data,
  onSelect,
}: {
  data: ConsoleData;
  /**
   * Open another section. Absent on the landing page's console and on the
   * `/settings` fallback, which render every block at once. Its presence is
   * also how this knows a backend is mounted, so the controls that write to
   * one are drawn only where they can.
   */
  onSelect?: (key: SettingsSectionKey) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  const shared = current?.kind === "shared";
  const [pickingIcon, setPickingIcon] = useState(false);
  // The shared cache, so a photo the rail already fetched is drawn here without
  // a second request.
  const iconFor = useWorkspaceIcons();
  const icon = current === null ? undefined : iconFor(current);
  /*
    Owner-only, and absent rather than disabled. The icon and the name show in
    every member's rail, so they belong with the workspace rather than with the
    notes an editor may write — the server refuses anybody else either way.
  */
  const canChooseIcon = current !== null && current.role === "owner" && onSelect !== undefined;
  // The name field writes through `useMutation`, which the demo console has no
  // client for; there it is drawn read-only, like a member's.
  const canRename = canChooseIcon && !data.demo;

  const role =
    current?.role === "owner"
      ? shared
        ? "you're an owner"
        : "you're the owner"
      : current?.role === undefined
        ? null
        : `you're ${current.role === "editor" ? "an editor" : "a member"}`;
  const name = current?.displayName?.trim() || atName(current?.slug ?? "—");

  return (
    <View>
      <View style={styles.card}>
        <View style={styles.identity} testID="overview-identity">
          {/*
            A chosen picture, falling back to the first letter — reversed from
            letters-only deliberately, by the owner: `@seyi` and `@supa` drew the
            same S in the switcher whose job is telling them apart.
          */}
          <WorkspaceMonogram slug={current?.slug ?? "?"} icon={icon} style={styles.picture} />
          <View style={styles.who}>
            <Text variant="noteTitle" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="rowSub" style={styles.whoSub}>
              {[atName(current?.slug ?? "—"), shared ? "shared workspace" : "personal workspace", role]
                .filter((part) => part !== null)
                .join(" · ")}
            </Text>
          </View>
          {canChooseIcon ? (
            <Button
              variant="mini"
              label={pickingIcon ? "Done" : "Change picture"}
              accessibilityLabel={
                pickingIcon ? "Close the picture picker" : "Change this workspace’s picture"
              }
              onPress={() => setPickingIcon((open) => !open)}
              testID="overview-icon-trigger"
            />
          ) : null}
        </View>

        {canChooseIcon && pickingIcon ? (
          <View style={styles.picker}>
            <WorkspaceIconPicker
              workspaceId={current.id}
              icon={icon}
              onClose={() => setPickingIcon(false)}
            />
          </View>
        ) : null}

        <View style={styles.nameRow}>
          {canRename ? (
            <WorkspaceNameField key={name} workspaceId={current.id} name={name} />
          ) : (
            <TextField
              label="Name"
              value={name}
              editable={false}
              containerStyle={styles.field}
              testID="overview-name"
            />
          )}
        </View>
      </View>

      {/*
        Your face, on your own workspace: it defaults to this workspace's icon,
        so the two are chosen side by side. Only where a backend is mounted,
        the rule the picture button above follows.
      */}
      {!shared && current?.role === "owner" && onSelect !== undefined ? <YourPicture /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      marginBottom: space.x4,
    },
    identity: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      padding: space.x4,
    },
    picture: { width: 56, height: 56, borderRadius: 12 },
    who: { flex: 1, minWidth: 0 },
    whoSub: { marginTop: 1 },
    picker: { paddingHorizontal: space.x4, paddingBottom: space.x4 },
    nameRow: {
      borderTopWidth: 1,
      borderTopColor: colors.line,
      padding: space.x4,
    },
    field: { maxWidth: 386 },
  });

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { TextLink } from "../../../design/components/TextLink";
import { space } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import { atName } from "../../format";
import { WorkspaceNameField } from "./WorkspaceNameField";
import { selectedContext, type ConsoleData } from "../../types";
import type { SettingsSectionKey } from "../sections";
import { useWorkspaceIcons } from "../../useWorkspaceIcons";
import { WorkspaceIconPicker, WorkspaceMonogram } from "./WorkspaceIconPicker";

/**
 * Settings › General: this workspace's name and picture, and the few facts
 * about it that are not a control.
 *
 * The name is shown once, in the field beside the picture. The address, the
 * kind and your role are quiet rows under it; custom emoji is a row whose
 * "Manage" link opens the emoji page. What an owner can change and what
 * everybody else sees are the same card: a member sees the name in a field
 * that does not take typing and no button, absent rather than disabled.
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
  const people = data.members.loading ? null : data.members.members.length;
  const kind = [
    shared ? "Shared workspace" : "Personal workspace",
    people === null ? null : `${people} ${people === 1 ? "person" : "people"}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <View>
      <Card style={styles.card}>
        <View style={styles.identity} testID="overview-identity">
          {/*
            A chosen picture, falling back to the first letter — reversed from
            letters-only deliberately, by the owner: `@seyi` and `@supa` drew the
            same S in the switcher whose job is telling them apart.
          */}
          <WorkspaceMonogram slug={current?.slug ?? "?"} icon={icon} style={styles.picture} />
          <View style={styles.nameCell}>
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
      </Card>

      <Card style={styles.facts} testID="overview-facts">
        <Row>
          <Grow>
            <Text variant="rowTitle">Address</Text>
            <Text variant="rowSub" style={styles.sub}>
              How people and AI apps find it
            </Text>
          </Grow>
          <Text variant="mono">{atName(current?.slug ?? "—")}</Text>
        </Row>
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Kind</Text>
          </Grow>
          <Text variant="rowSub">{kind}</Text>
        </Row>
        {role === null ? null : (
          <Row divided>
            <Grow>
              <Text variant="rowTitle">Your role</Text>
            </Grow>
            <Text variant="rowSub">{role.charAt(0).toUpperCase() + role.slice(1)}</Text>
          </Row>
        )}
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Custom emoji</Text>
          </Grow>
          {onSelect === undefined ? null : (
            <TextLink
              label="Manage"
              accessibilityLabel="Manage this workspace’s custom emoji"
              onPress={() => onSelect("emoji")}
              testID="overview-emoji-manage"
            />
          )}
        </Row>
      </Card>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    card: { padding: 0, marginBottom: space.x4 },
    identity: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      padding: space.x4,
    },
    picture: { width: 56, height: 56, borderRadius: 12 },
    nameCell: { flex: 1, minWidth: 0 },
    picker: { paddingHorizontal: space.x4, paddingBottom: space.x4 },
    facts: { marginBottom: space.x4 },
    sub: { marginTop: 2 },
    field: { width: "100%" },
  });

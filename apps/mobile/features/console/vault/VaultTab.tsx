import { useState } from "react";
import { ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { VaultList } from "./VaultList";
import { useVaultActions } from "./useVaultActions";

/**
 * The right panel's Vault tab: the open workspace's keys at the panel's width,
 * the list first and a picked key in its place with one row back. The rail is
 * the panel's only chrome, so there is no title here: the count line is the
 * head, as the Meetings tab's sections are.
 */
export function VaultTab({ workspaceId }: { workspaceId: string }) {
  const styles = useThemedStyles(makeStyles);
  const actions = useVaultActions(workspaceId);
  const [width, setWidth] = useState(0);
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.body} testID="aside-vault-scroll">
      <View onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
        {actions === null ? null : (
          <VaultList key={workspaceId} actions={actions} layoutWidth={width || 360} />
        )}
      </View>
    </ScrollView>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    scroll: { flex: 1 },
    body: { paddingHorizontal: space.x4, paddingTop: space.x2, paddingBottom: space.x4 },
  });

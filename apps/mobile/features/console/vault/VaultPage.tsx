import { useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { type Colors, useColors, useThemedStyles } from "../../design/theme";
import { space } from "../../design/tokens";
import { VaultList } from "./VaultList";
import { DocumentPage } from "../panes/browsePane/DocumentPage";
import { useVaultRoute } from "./route";
import { useVaultActions } from "./useVaultActions";

/**
 * The phone's Vault (`?vault=1`): a page where a note would be, headed the way
 * the Trash page is, with the list the right panel's Vault tab draws. The head
 * stays while a key is open, and the key's own back row sits under it.
 */
export function VaultPage({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const actions = useVaultActions(workspaceId);
  const [width, setWidth] = useState(0);
  return (
    <View style={styles.page} testID="vault-page" onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
      <View style={styles.head}>
        <Text variant="paneTitle" role="heading" aria-level={1} style={styles.title}>
          Vault
        </Text>
        <Pressable role="button" accessibilityLabel="Close the vault" onPress={onClose} style={styles.close} testID="vault-page-close">
          <Icon name="close" size={16} color={colors.chromeMuted} />
        </Pressable>
      </View>
      {actions === null ? null : (
        <VaultList key={workspaceId} actions={actions} layoutWidth={width || 360} />
      )}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    page: { paddingTop: space.x8, paddingBottom: space.x8, gap: space.x3 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x4 },
    title: { flex: 1, minWidth: 0 },
    close: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 8 },
  });

/** The phone's Vault page in the document slot while `?vault=1` is open, else `null` (a panel has it on the rail). */
export function useVaultPage() {
  const route = useVaultRoute();
  return route?.open ? (
    <DocumentPage>
      <VaultPage workspaceId={route.workspaceId} onClose={route.closeVault} />
    </DocumentPage>
  ) : null;
}

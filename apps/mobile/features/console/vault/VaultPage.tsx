import { useEffect, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Text } from "../../design/components/Text";
import { type Colors, useThemedStyles } from "../../design/theme";
import { fonts, leading, space, touchType, tracking } from "../../design/tokens";
import { DocumentPage } from "../panes/browsePane/DocumentPage";
import { PhoneBack } from "../home/PhoneBack";
import { VaultList } from "./VaultList";
import { setVaultDeep, useVaultDeep, useVaultRoute } from "./route";
import { useVaultActions } from "./useVaultActions";

/**
 * The phone's Vault (`?vault=1`), as the approved prototype drew it: "‹ Notes"
 * in the top bar, the page's 34pt title as Notes has it, and the list the
 * right panel's Vault tab draws. A picked key takes the page with its own back
 * row, and the title and "‹ Notes" stand aside so there is one back.
 */
export function VaultPage({ workspaceId }: { workspaceId: string }) {
  const styles = useThemedStyles(makeStyles);
  const actions = useVaultActions(workspaceId);
  const deep = useVaultDeep();
  const [width, setWidth] = useState(0);
  useEffect(() => () => setVaultDeep(false), []);
  return (
    <View style={styles.page} testID="vault-page" onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
      {deep ? null : (
        <Text role="heading" aria-level={1} style={styles.title} testID="vault-page-title">
          Vault
        </Text>
      )}
      {actions === null ? null : (
        <VaultList key={workspaceId} actions={actions} layoutWidth={width || 360} onDepth={setVaultDeep} />
      )}
    </View>
  );
}

/** The phone's Vault page in the document slot while `?vault=1` is open, else `null` (a panel has it on the rail). */
export function useVaultPage() {
  const route = useVaultRoute();
  return route?.open ? (
    <DocumentPage>
      <VaultPage workspaceId={route.workspaceId} />
    </DocumentPage>
  ) : null;
}

/**
 * The phone's top-left while the Vault page is open: "‹ Notes", which closes
 * it, and nothing while a key is open (its own back row is the back). Every
 * other page keeps what the console draws there.
 */
export function VaultTopLeft({ children }: { children: React.ReactNode }) {
  const route = useVaultRoute();
  const deep = useVaultDeep();
  if (route?.open !== true) return <>{children}</>;
  if (deep) return null;
  return <PhoneBack levels={[{ folder: null, label: "Notes", view: "inbox" }]} onGo={route.closeVault} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingTop: space.x2, paddingBottom: space.x8, gap: space.x3 },
    // 34pt, as the Notes page's title (`home/PhoneHome.tsx`).
    title: {
      fontFamily: fonts.display,
      fontSize: touchType.page,
      lineHeight: leading(touchType.page, 1.12),
      fontWeight: "700",
      letterSpacing: tracking(34, -0.02),
      color: colors.text,
    },
  });

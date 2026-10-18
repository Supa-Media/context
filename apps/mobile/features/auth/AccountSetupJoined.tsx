import { View } from "react-native";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { Text } from "../design/components/Text";
import { useThemedStyles } from "../design/theme";
import { JOINED_BODY, JOINED_TITLE } from "./phoneCheck";
import { useSwitchAccount } from "./useSwitchAccount";
import { makeAccountSetupStyles } from "./accountSetupStyles";

/**
 * What "Make your account" says when the phone it was given already belonged
 * to another account, which this one has closed into (`phoneCheck.ts`). The
 * person signs in again to land there, as on the phone check.
 */
export function AccountSetupJoined() {
  const styles = useThemedStyles(makeAccountSetupStyles);
  const switchAccount = useSwitchAccount();
  return (
    <CenteredScroll style={styles.screen} testID="account-setup">
      <View style={styles.form}>
        <Text role="heading" aria-level={1} style={styles.pitch}>
          {JOINED_TITLE}
        </Text>
        <Text variant="rowSub" style={styles.body}>
          {JOINED_BODY}
        </Text>
        <View style={styles.primaryRow}>
          <Button label="Sign in again" variant="accent" onPress={() => switchAccount("/")} testID="account-setup-sign-in" />
        </View>
      </View>
    </CenteredScroll>
  );
}

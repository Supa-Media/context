import { useState } from "react";
import { Linking, View } from "react-native";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Text } from "../design/components/Text";
import { enableNotifications } from "./device";
import type { RegistrationState } from "./register";

/** Optional device registration. No marketing consent or delivery subscription. */
export function NotificationSettings() {
  const [state, setState] = useState<RegistrationState | "idle" | "working">("idle");
  const [settingsFailed, setSettingsFailed] = useState(false);
  return (
    <Card>
      <Text variant="rowTitle">Notifications</Text>
      <Text variant="rowSub">
        Allow notifications on this device. You can keep using Context without them
        and change this permission in system settings at any time.
      </Text>
      <View>
        <Button
          label={state === "working" ? "Registering…" : "Enable notifications"}
          disabled={state === "working"}
          onPress={() => {
            if (state === "working") return;
            setState("working");
            void enableNotifications().then(setState);
          }}
          testID="notifications-enable"
        />
        <Button label="System settings" variant="ghost" onPress={() => {
          setSettingsFailed(false);
          void Linking.openSettings().catch(() => setSettingsFailed(true));
        }} />
      </View>
      {state === "registered" ? <Text variant="foot" role="status">This device is registered for notifications.</Text> : null}
      {state === "denied" ? <Text variant="foot" role="status">Notifications are off. You can allow them in system settings.</Text> : null}
      {state === "failed" ? <Text variant="foot" role="status">Registration did not finish. Check your connection and try again on a physical device.</Text> : null}
      {settingsFailed ? <Text variant="foot" role="status">Open Settings on your device and select Context.</Text> : null}
    </Card>
  );
}

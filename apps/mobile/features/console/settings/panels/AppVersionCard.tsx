import { useState } from "react";
import { StyleSheet, View } from "react-native";
import * as Application from "expo-application";
import * as Updates from "expo-updates";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { checkLine, versionLines, type CheckState } from "../../../updates/appVersion";

/**
 * Which copy of the app this phone runs, and a way to fetch the newest one
 * now rather than on the next two launches (Dev2, 2026-11-06). At the foot of
 * Profile, beside signing out. The phone app only: the web's half
 * (`AppVersionCard.web.tsx`) draws nothing.
 */
export function AppVersionCard() {
  const styles = useThemedStyles(makeStyles);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const lines = versionLines({
    version: Application.nativeApplicationVersion,
    build: Application.nativeBuildVersion,
    updatesEnabled: Updates.isEnabled,
    embedded: Updates.isEmbeddedLaunch,
    emergency: Updates.isEmergencyLaunch,
    emergencyReason: Updates.emergencyLaunchReason,
    updateId: Updates.updateId,
    createdAt: Updates.createdAt,
    channel: Updates.channel,
    runtimeVersion: Updates.runtimeVersion,
  });

  const checkNow = async () => {
    setCheck({ kind: "checking" });
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found.isAvailable) {
        setCheck({ kind: "newest" });
        return;
      }
      await Updates.fetchUpdateAsync();
      setCheck({ kind: "ready" });
    } catch (error) {
      setCheck({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const said = checkLine(check);

  return (
    <View style={styles.spaced}>
      <Text variant="eyebrow" style={styles.head}>
        This app
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Version</Text>
          </Grow>
          <Text variant="mono" testID="app-version">
            {lines.app}
          </Text>
        </Row>
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Update</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              {lines.detail}
            </Text>
          </Grow>
          <Text variant="mono" testID="app-update">
            {lines.update}
          </Text>
        </Row>
        {lines.warning ? (
          <Row divided>
            <Text variant="rowSub">{lines.warning}</Text>
          </Row>
        ) : null}
        <Row divided>
          <Grow>{said ? <Text variant="rowSub">{said}</Text> : null}</Grow>
          {check.kind === "ready" ? (
            <Button label="Restart" onPress={() => void Updates.reloadAsync()} testID="app-update-restart" />
          ) : (
            <Button
              label="Check for update"
              disabled={!Updates.isEnabled || check.kind === "checking"}
              onPress={() => void checkNow()}
              testID="app-update-check"
            />
          )}
        </Row>
      </Card>
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    spaced: { marginTop: space.x3 },
    head: { marginBottom: space.x2 },
    rowSub: { marginTop: 2 },
  });

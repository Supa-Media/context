import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { FormError, ToggleGroup } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import { GOOGLE_REDIRECT_ORIGINS, type GoogleSyncServices } from "./google";
import { useGoogleStart } from "./useGoogleStart";

export interface GoogleConnection {
  connectionId: string;
  email: string;
  syncServices: GoogleSyncServices;
  syncStatus: string;
  lastSyncStartedAt?: number;
  lastSyncCompletedAt?: number;
}

export interface GoogleActions {
  workspaceId: string;
  disconnect: (connectionId: string) => Promise<null>;
}

export function GoogleConnectionsCard({
  connections = [],
  actions,
  loading = false,
}: {
  connections?: GoogleConnection[];
  actions?: GoogleActions;
  loading?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <Card>
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowTitle">Google accounts</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            Connect each Google account this context should sync.
          </Text>
        </Grow>
        <Pill tone="neutral">{`${connections.length} connected`}</Pill>
      </Row>

      {connections.length === 0 ? (
        <Text variant="rowSub" style={styles.empty}>
          {loading ? "Loading Google accounts..." : "No Google accounts connected yet."}
        </Text>
      ) : null}

      {connections.map((connection) => (
        <ConnectedGoogleRow
          key={connection.connectionId}
          connection={connection}
          actions={actions}
        />
      ))}

      {actions ? (
        <GoogleConnectControls actions={actions} />
      ) : (
        <Text variant="foot" style={styles.note}>
          Only an owner can connect or remove Google accounts.
        </Text>
      )}
    </Card>
  );
}

function GoogleConnectControls({ actions }: { actions: GoogleActions }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [services, setServices] = useState<GoogleSyncServices>({
    gmail: true,
    calendar: true,
    chat: true,
  });
  const google = useGoogleStart(actions.workspaceId);
  const selected = Object.values(services).some(Boolean);
  const starting = google.state.kind === "starting";

  return (
    <View style={styles.connect}>
      <ToggleGroup
        label="Sync"
        options={[
          { value: "gmail", label: "Gmail", on: services.gmail },
          { value: "calendar", label: "Calendar", on: services.calendar },
          { value: "chat", label: "Chat", on: services.chat },
        ]}
        onToggle={(value, next) =>
          setServices((current) => ({ ...current, [value]: next }))
        }
      />
      <Button
        label={starting ? "Opening Google..." : "Connect Google account"}
        disabled={!selected || starting || google.redirectUri === null}
        onPress={() => google.start(services)}
        trailing={starting ? <ActivityIndicator color={colors.text} size="small" /> : null}
        testID="connect-google"
      />
      {google.redirectUri === null ? (
        <Text variant="foot" style={styles.note}>
          Google connect works in a browser at {GOOGLE_REDIRECT_ORIGINS.join(" or ")}.
        </Text>
      ) : null}
      {google.state.kind === "failed" ? (
        <FormError headline="Could not start Google" next={google.state.message} />
      ) : null}
    </View>
  );
}

function ConnectedGoogleRow({
  connection,
  actions,
}: {
  connection: GoogleConnection;
  actions?: GoogleActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const disconnect = useArming(() => {
    if (actions === undefined) return;
    void actions.disconnect(connection.connectionId);
  });
  const serviceNames = [
    connection.syncServices.gmail ? "Gmail" : null,
    connection.syncServices.calendar ? "Calendar" : null,
    connection.syncServices.chat ? "Chat" : null,
  ].filter(Boolean);

  return (
    <Row divided>
      <Grow>
        <Text variant="rowTitle">{connection.email}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {`${serviceNames.join(", ")} · ${connection.syncStatus}`}
        </Text>
      </Grow>
      <Button
        label={disconnect.stage === "armed" ? "Press again" : "Disconnect"}
        variant="danger"
        disabled={actions === undefined}
        onPress={disconnect.press}
      />
    </Row>
  );
}

const makeStyles = (_colors: Colors) => StyleSheet.create({
  head: { marginBottom: 12 },
  rowSub: { marginTop: 2 },
  empty: { marginTop: 4 },
  connect: { marginTop: 14, gap: 12 },
  note: { marginTop: 2 },
});

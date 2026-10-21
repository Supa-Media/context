import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { failureMessage } from "../../../connect/connectFlow";
import { useArming } from "../../useArming";

type ConnectionRow = {
  id: Id<"providerConnections">;
  provider: string;
  providerName: string;
  teamName: string;
  reconnectRequired: boolean;
  canDisconnect: boolean;
};

/**
 * "Apps Tex uses" (`docs/decisions/connectors.md`): the apps this personal
 * workspace is connected to, each as one person. Draws nothing when there are
 * none, and nothing while the list is loading, so an empty workspace shows no
 * row at all. The token never reaches this list; the server sends names only.
 */
export function ProviderConnectionsCard({ workspaceId }: { workspaceId: string }) {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(
    api.functions.connections.listConnections,
    isAuthenticated ? { workspaceId: workspaceId as Id<"workspaces"> } : "skip",
  );
  if (rows === undefined || rows.length === 0) return null;
  return (
    <View testID="provider-connections" style={styles.wrap}>
      <Text variant="rowTitle" style={styles.head}>
        Apps Tex uses
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        Tex reads and acts in these as you. Anything it posts or changes waits for your yes.
      </Text>
      <Card>
        {rows.map((row, index) => (
          <ProviderConnectionLine key={row.id} row={row} divided={index > 0} />
        ))}
      </Card>
    </View>
  );
}

function ProviderConnectionLine({ row, divided }: { row: ConnectionRow; divided: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const disconnect = useMutation(api.functions.connections.disconnectConnection);
  const [failure, setFailure] = useState<string | null>(null);
  const arming = useArming(async () => {
    setFailure(null);
    try {
      await disconnect({ connectionId: row.id });
    } catch (error) {
      setFailure(failureMessage(error));
    }
  });
  const label =
    arming.stage === "armed" ? "Confirm" : arming.stage === "working" ? "Disconnecting…" : "Disconnect";

  return (
    <Row divided={divided} testID={`provider-connection-${row.provider}`}>
      <Grow>
        <Text variant="rowTitle">{row.providerName}</Text>
        <Text variant="rowSub">{row.teamName}</Text>
        {failure === null ? null : (
          <Text variant="rowSub" role="status" style={styles.failure}>
            {failure}
          </Text>
        )}
      </Grow>
      {row.reconnectRequired ? <Pill tone="warn">Reconnect needed</Pill> : null}
      {row.canDisconnect ? (
        <Button
          label={label}
          variant="danger"
          disabled={arming.stage === "working"}
          accessibilityLabel={`Disconnect ${row.providerName} for ${row.teamName}`}
          onPress={arming.press}
          testID={`provider-connection-disconnect-${row.provider}`}
        />
      ) : null}
    </Row>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    wrap: { marginTop: space.x3 },
    head: { marginBottom: space.x2 },
    sub: { marginBottom: space.x2 },
    failure: { marginTop: space.x1 },
  });

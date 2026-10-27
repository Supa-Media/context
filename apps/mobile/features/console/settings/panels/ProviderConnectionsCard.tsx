import { useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { browserCompletionStore, connectHref, failureMessage, rememberCompletionSecret } from "../../../connect/connectFlow";
import { leaveForConsent } from "../../../connect/leaveForConsent";
import { consoleOrigin } from "../../files/shareOrigin";
import { useArming } from "../../useArming";

type AppRow = FunctionReturnType<typeof api.functions.connectionSettings.myApps>[number];

/**
 * "Apps Tex uses" (`docs/decisions/connectors.md`): every app Tex reaches
 * through its own connection, and where this person stands in each. Connect
 * mints the same one-use link Tex would text and goes straight on to the
 * app's consent screen, so connecting needs no text. It avoids `expo-router`
 * on purpose: this card mounts in render suites that mock no router.
 * Draws nothing while loading, or for a workspace that connects nothing (a
 * shared one, or one they don't own). The token never reaches this list.
 */
export function ProviderConnectionsCard({ workspaceId, bare = false }: { workspaceId: string; bare?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const rows = useQuery(
    api.functions.connectionSettings.myApps,
    isAuthenticated ? { workspaceId: workspaceId as Id<"workspaces"> } : "skip",
  );
  if (rows === undefined || rows.length === 0) return null;
  return (
    <View testID="provider-connections" style={bare ? undefined : styles.wrap}>
      {/* `bare` on the settings page of its own, whose title and line already say this. */}
      {bare ? null : (
        <>
          <Text variant="rowTitle" style={styles.head}>
            Apps Tex uses
          </Text>
          <Text variant="rowSub" style={styles.sub}>
            Tex reads and acts in these as you. Anything it posts or changes waits for your yes.
          </Text>
        </>
      )}
      <Card>
        {rows.map((row, index) => (
          <AppLine key={row.app} row={row} workspaceId={workspaceId} divided={index > 0} />
        ))}
      </Card>
    </View>
  );
}

function AppLine({ row, workspaceId, divided }: { row: AppRow; workspaceId: string; divided: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const mint = useAction(api.functions.connectionSettings.startAppConnect);
  const start = useAction(api.functions.connections.startProviderConnect);
  const disconnect = useMutation(api.functions.connections.disconnectConnection);
  const [failure, setFailure] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const arming = useArming(async () => {
    if (row.connectionId === undefined) return;
    setFailure(null);
    try {
      await disconnect({ connectionId: row.connectionId });
    } catch (error) {
      setFailure(failureMessage(error));
    }
  });
  const connect = async () => {
    setFailure(null);
    setOpening(true);
    try {
      // The same steps as the link Tex texts, without the stop on its page: this is already the person, signed in, pressing Connect.
      const { token } = await mint({ workspaceId: workspaceId as Id<"workspaces">, provider: row.app });
      const store = browserCompletionStore();
      if (store === null) {
        // The phone app has no browser tab for the app's callback to land in, so it opens the link Tex would text, in the browser.
        await Linking.openURL(`${consoleOrigin()}${connectHref(row.app, token)}`);
        return;
      }
      const { authorizeUrl, completionSecret } = await start({ token });
      if (!rememberCompletionSecret(row.app, completionSecret, store)) {
        setFailure("This browser could not keep the connection secret. Try again.");
        return;
      }
      leaveForConsent(authorizeUrl);
    } catch (error) {
      setFailure(failureMessage(error));
    } finally {
      setOpening(false);
    }
  };
  const connected = row.state === "connected" || row.state === "reconnect";

  return (
    // Words above, pill and buttons below: side by side, a phone squeezed the name into a one-letter column.
    <View style={divided ? styles.divided : undefined} testID={`provider-connection-${row.app}`}>
      <View>
        <Text variant="rowTitle">{row.name}</Text>
        <Text variant="rowSub">{connected && row.account ? row.account : row.about}</Text>
        {failure === null ? null : (
          <Text variant="rowSub" role="status" style={styles.failure}>
            {failure}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        {row.state === "reconnect" ? <Pill tone="warn">Reconnect needed</Pill> : null}
        {row.state === "connected" ? <Pill tone="ok">Connected</Pill> : null}
        {row.state === "not_connected" || row.state === "reconnect" ? (
          <Button
            label={opening ? "Opening…" : row.state === "reconnect" ? "Reconnect" : "Connect"}
            disabled={opening}
            accessibilityLabel={`${row.state === "reconnect" ? "Reconnect" : "Connect"} ${row.name}`}
            onPress={() => void connect()}
            testID={`provider-connection-connect-${row.app}`}
          />
        ) : null}
        {connected && row.connectionId !== undefined ? (
          <Button
            label={arming.stage === "armed" ? "Confirm" : arming.stage === "working" ? "Disconnecting…" : "Disconnect"}
            variant="danger"
            disabled={arming.stage === "working"}
            accessibilityLabel={`Disconnect ${row.name}`}
            onPress={arming.press}
            testID={`provider-connection-disconnect-${row.app}`}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { marginTop: space.x3 },
    head: { marginBottom: space.x2 },
    sub: { marginBottom: space.x2 },
    failure: { marginTop: space.x1 },
    divided: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginTop: space.x2 },
  });

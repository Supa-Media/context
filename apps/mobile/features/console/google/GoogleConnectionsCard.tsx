import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { ChoiceGroup, FormError, ToggleGroup } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import {
  GOOGLE_REDIRECT_ORIGINS,
  googleBackfillWindowLabel,
  type GoogleBackfillWindow,
  type GoogleSyncServices,
} from "./google";
import { useGoogleStart } from "./useGoogleStart";

export interface GoogleConnection {
  connectionId: string;
  email: string;
  syncServices: GoogleSyncServices;
  syncStatus: string;
  lastSyncStartedAt?: number;
  lastSyncCompletedAt?: number;
  errorCode?: string;
  lastError?: string;
  gmail?: {
    backfillDays: number;
    folders: Array<"inbox" | "sent">;
    destinationPath: string;
    historyCursorReady: boolean;
    lastSyncedAt?: number;
  };
  calendar?: {
    destinationPath: string;
    syncCursorReady: boolean;
    lastSyncedAt?: number;
  };
  chat?: {
    destinationPath: string;
    cursorCount: number;
    lastSyncedAt?: number;
  };
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
  const [backfillWindow, setBackfillWindow] = useState<GoogleBackfillWindow>("90");
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
      <ChoiceGroup
        label="Gmail Backfill"
        hint="Choose the mail history window before leaving for Google."
        options={[
          { value: "90", label: "90 days", detail: "Start with recent mail history." },
          { value: "365", label: "1 year", detail: "Bring in a fuller working archive." },
          { value: "all", label: "All mail", detail: "Use only when this account needs a complete archive." },
        ]}
        value={backfillWindow}
        onChange={setBackfillWindow}
        disabled={starting || !services.gmail}
        testID="google-backfill-window"
      />
      <Button
        label={starting ? "Opening Google..." : "Connect Google account"}
        disabled={!selected || starting || google.redirectUri === null}
        onPress={() => google.start(services, backfillWindow)}
        trailing={starting ? <ActivityIndicator color={colors.text} size="small" /> : null}
        testID="connect-google"
      />
      {google.redirectUri === null ? (
        <Text variant="foot" style={styles.note}>
          Google connect works in a browser at {GOOGLE_REDIRECT_ORIGINS.join(" or ")}.
        </Text>
      ) : null}
      {google.state.kind === "failed" ? (
        <FormError headline={google.state.headline} next={google.state.message} />
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
  const detailLines = googleConnectionDetailLines(connection);

  return (
    <Row divided style={styles.connectionRow}>
      <Grow style={styles.connectionBody}>
        <Text variant="rowTitle">{connection.email}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {`${serviceNames.join(", ")} · ${statusLabel(connection.syncStatus)}`}
        </Text>
        {detailLines.length > 0 ? (
          <View style={styles.details}>
            {detailLines.map((line) => (
              <Text key={line} variant="foot" style={styles.detailLine}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}
        {connection.lastError ? (
          <FormError
            headline={connection.errorCode ? statusLabel(connection.errorCode) : "Google needs attention"}
            next={connection.lastError}
            style={styles.inlineError}
          />
        ) : null}
      </Grow>
      <View style={styles.disconnectAction}>
        <Button
          label={disconnect.stage === "armed" ? "Press again" : "Disconnect"}
          variant="danger"
          disabled={actions === undefined}
          onPress={disconnect.press}
        />
      </View>
    </Row>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "backfilling":
      return "waiting for first sync";
    case "active":
      return "active";
    case "reconnect_required":
      return "reconnect required";
    default:
      return status.replace(/_/g, " ");
  }
}

function formatSyncTime(value: number | undefined): string | null {
  if (value === undefined) return null;
  const text = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
  return `last synced ${text}`;
}

function googleConnectionDetailLines(connection: GoogleConnection): string[] {
  const lines: string[] = [];
  if (connection.syncServices.gmail && connection.gmail) {
    const parts = [
      `${googleBackfillWindowLabel(connection.gmail.backfillDays)} backfill`,
      connection.gmail.folders.map((folder) => (folder === "inbox" ? "Inbox" : "Sent")).join(" + "),
      connection.gmail.historyCursorReady ? "Gmail cursor ready" : "waiting for first Gmail cursor",
      formatSyncTime(connection.gmail.lastSyncedAt),
    ].filter(Boolean);
    lines.push(`Gmail: ${parts.join(" · ")}`);
    lines.push(`Destination: ${connection.gmail.destinationPath}`);
  }
  if (connection.syncServices.calendar && connection.calendar) {
    const parts = [
      connection.calendar.syncCursorReady ? "Calendar cursor ready" : "waiting for first Calendar cursor",
      formatSyncTime(connection.calendar.lastSyncedAt),
    ].filter(Boolean);
    lines.push(`Calendar: ${parts.join(" · ")}`);
    lines.push(`Destination: ${connection.calendar.destinationPath}`);
  }
  if (connection.syncServices.chat && connection.chat) {
    const parts = [
      connection.chat.cursorCount === 0
        ? "waiting for first Chat space cursor"
        : `${connection.chat.cursorCount} Chat space cursor${connection.chat.cursorCount === 1 ? "" : "s"}`,
      formatSyncTime(connection.chat.lastSyncedAt),
    ].filter(Boolean);
    lines.push(`Chat: ${parts.join(" · ")}`);
    lines.push(`Destination: ${connection.chat.destinationPath}`);
  }
  return lines;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { marginBottom: 12 },
  rowSub: { marginTop: 2 },
  connectionRow: { alignItems: "flex-start", flexWrap: "wrap" },
  details: { marginTop: 8, gap: 3 },
  detailLine: { color: colors.text2 },
  inlineError: { marginTop: 10 },
  empty: { marginTop: 4 },
  connect: { marginTop: 14, gap: 12 },
  connectionBody: { flexBasis: 280 },
  disconnectAction: { marginLeft: "auto" },
  note: { marginTop: 2 },
});

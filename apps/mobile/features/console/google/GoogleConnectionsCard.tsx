import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { ChoiceGroup, FormError, TextField, ToggleGroup } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import {
  GOOGLE_REDIRECT_ORIGINS,
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
    destinationFolder: string;
    destinationPath: string;
    historyCursorReady: boolean;
    lastSyncedAt?: number;
  };
  calendar?: {
    destinationFolder: string;
    destinationPath: string;
    syncCursorReady: boolean;
    lastSyncedAt?: number;
  };
  chat?: {
    destinationFolder: string;
    destinationPath: string;
    cursorCount: number;
    lastSyncedAt?: number;
  };
  syncRun?: {
    runId: string;
    mode: "backfill";
    services: Array<"gmail" | "calendar" | "chat">;
    status: "queued" | "running" | "complete" | "failed";
    requestedBackfillDays: number;
    totalUnits: number;
    completedUnits: number;
    itemsFound?: number;
    daysWithMail?: number;
    bytesWritten?: number;
    currentService?: "gmail" | "calendar" | "chat";
    currentUnit?: string;
    startedAt?: number;
    completedAt?: number;
    errorCode?: string;
    lastError?: string;
  };
}

export interface GoogleActions {
  workspaceId: string;
  disconnect: (connectionId: string) => Promise<null>;
  startBackfill: (connectionId: string, backfillDays: number) => Promise<unknown>;
  saveDestination: (
    connectionId: string,
    service: "gmail" | "calendar" | "chat",
    destinationPath: string,
  ) => Promise<unknown>;
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
    connection.syncServices.gmail ? "Email" : null,
    connection.syncServices.calendar ? "Calendar" : null,
    connection.syncServices.chat ? "Chat" : null,
  ].filter(Boolean);
  const inlineError = connection.lastError ?? connection.syncRun?.lastError;
  const inlineErrorCode = connection.errorCode ?? connection.syncRun?.errorCode;
  const showAccountError = inlineError && connection.syncRun?.status !== "failed";

  return (
    <Row divided style={styles.connectionRow}>
      <Grow style={styles.connectionBody}>
        <Text variant="rowTitle">{connection.email}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {`${serviceNames.join(", ")} connected`}
        </Text>
        <View style={styles.serviceList}>
          {connection.syncServices.gmail && connection.gmail ? (
            <GoogleServiceBlock
              connectionId={connection.connectionId}
              service="gmail"
              title="Email"
              status={gmailRunDetail(connection) ?? (connection.gmail.historyCursorReady ? "Watching for new mail" : "Ready to backfill")}
              destinationPath={connection.gmail.destinationPath}
              destinationHint="Daily email files use YYYY-MM-DD.md; attachments stay beside the mailbox."
              error={connection.syncRun?.status === "failed" ? inlineError : undefined}
              actionLabel={gmailBackfillActionLabel(connection)}
              actionDisabled={
                actions === undefined ||
                connection.syncRun?.status === "queued" ||
                connection.syncRun?.status === "running"
              }
              onAction={() => {
                if (actions === undefined || !connection.gmail) return;
                void actions.startBackfill(connection.connectionId, connection.gmail.backfillDays);
              }}
              saveDestination={
                connection.syncRun?.status === "queued" || connection.syncRun?.status === "running"
                  ? undefined
                  : actions?.saveDestination
              }
              destinationReadOnly={connection.syncRun?.status === "queued" || connection.syncRun?.status === "running"}
            />
          ) : null}
          {connection.syncServices.calendar && connection.calendar ? (
            <GoogleServiceBlock
              connectionId={connection.connectionId}
              service="calendar"
              title="Calendar"
              status={
                connection.calendar.syncCursorReady
                  ? `Watching calendar changes${formatSyncTime(connection.calendar.lastSyncedAt) ? ` · ${formatSyncTime(connection.calendar.lastSyncedAt)}` : ""}`
                  : "Connected; calendar backfill control is next"
              }
              destinationPath={connection.calendar.destinationPath}
              destinationHint="Calendar events will land as daily context notes here."
              actionLabel="Start Calendar sync"
              actionDisabled
              saveDestination={actions?.saveDestination}
            />
          ) : null}
          {connection.syncServices.chat && connection.chat ? (
            <GoogleServiceBlock
              connectionId={connection.connectionId}
              service="chat"
              title="Chat"
              status={
                connection.chat.cursorCount > 0
                  ? `Tracking ${connection.chat.cursorCount} Chat space${connection.chat.cursorCount === 1 ? "" : "s"}${formatSyncTime(connection.chat.lastSyncedAt) ? ` · ${formatSyncTime(connection.chat.lastSyncedAt)}` : ""}`
                  : "Connected; Chat backfill control is next"
              }
              destinationPath={connection.chat.destinationPath}
              destinationHint="Google Chat spaces will land as daily channel notes here."
              actionLabel="Start Chat sync"
              actionDisabled
              saveDestination={actions?.saveDestination}
            />
          ) : null}
        </View>
        {showAccountError ? (
          <FormError
            headline={inlineErrorCode ? statusLabel(inlineErrorCode) : "Google needs attention"}
            next={inlineError}
            style={styles.inlineError}
          />
        ) : null}
      </Grow>
      <View style={styles.connectionActions}>
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

function GoogleServiceBlock({
  connectionId,
  service,
  title,
  status,
  destinationPath,
  destinationHint,
  actionLabel,
  actionDisabled = false,
  error,
  onAction,
  saveDestination,
  destinationReadOnly = false,
}: {
  connectionId: string;
  service: "gmail" | "calendar" | "chat";
  title: string;
  status: string;
  destinationPath: string;
  destinationHint: string;
  actionLabel: string;
  actionDisabled?: boolean;
  error?: string;
  onAction?: () => void;
  saveDestination?: GoogleActions["saveDestination"];
  destinationReadOnly?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(destinationPath);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(destinationPath);
    setSaveError(null);
  }, [destinationPath]);

  const dirty = draft.trim() !== destinationPath.trim();

  return (
    <View style={styles.serviceBlock}>
      <View style={styles.serviceHead}>
        <View style={styles.serviceText}>
          <Text variant="rowTitle">{title}</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {status}
          </Text>
        </View>
        <Button
          label={actionLabel}
          disabled={actionDisabled}
          onPress={onAction}
          testID={`start-google-${service}-${connectionId}`}
        />
      </View>
      <View style={styles.destinationRow}>
        <TextField
          label={`${title} destination`}
          value={draft}
          editable={!destinationReadOnly}
          onChangeText={(value) => {
            setDraft(value);
            setSaveError(null);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={destinationPath}
          hint={destinationHint}
          containerStyle={styles.destinationField}
          testID={`google-${service}-destination-${connectionId}`}
        />
        <Button
          label={saving ? "Saving..." : "Save path"}
          disabled={!dirty || saving || destinationReadOnly || saveDestination === undefined}
          onPress={() => {
            if (saveDestination === undefined) return;
            setSaving(true);
            setSaveError(null);
            void saveDestination(connectionId, service, draft)
              .catch((reason) => {
                setSaveError(reason instanceof Error ? reason.message : "That path did not save.");
              })
              .finally(() => setSaving(false));
          }}
          style={styles.destinationSave}
          testID={`save-google-${service}-destination-${connectionId}`}
        />
      </View>
      {saveError ? <FormError headline="Path was not saved" next={saveError} /> : null}
      {error ? <FormError headline="Sync stopped" next={error} /> : null}
    </View>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "connected":
      return "connected, not synced yet";
    case "backfilling":
      return "syncing";
    case "active":
      return "watching for new changes";
    case "error":
      return "sync failed";
    case "reconnect_required":
      return "needs reconnect";
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

function formatBytes(value: number | undefined): string | null {
  if (value === undefined || value <= 0) return null;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB saved`;
  return `${(value / 1024 / 1024).toFixed(1)} MB saved`;
}

function gmailBackfillActionLabel(connection: GoogleConnection): string {
  const status = connection.syncRun?.status;
  if (status === "queued") return "Email queued";
  if (status === "running") return "Email running";
  if (status === "failed") return "Retry Email";
  return "Start Email";
}

function gmailRunDetail(connection: GoogleConnection): string | null {
  const run = connection.syncRun;
  if (!run || !run.services.includes("gmail")) return null;
  const progress =
    run.totalUnits > 0
      ? `${Math.min(run.completedUnits, run.totalUnits)} of ${run.totalUnits} days scanned`
      : null;
  const daysWithMail =
    run.daysWithMail === undefined
      ? null
      : `${run.daysWithMail} day${run.daysWithMail === 1 ? "" : "s"} had mail`;
  const emailsFound =
    run.itemsFound === undefined
      ? null
      : `${run.itemsFound} email${run.itemsFound === 1 ? "" : "s"} found`;
  const bytes = formatBytes(run.bytesWritten);
  const facts = [progress, emailsFound, daysWithMail, bytes].filter(Boolean);
  switch (run.status) {
    case "queued":
      return "Backfill queued";
    case "running":
      return `Scanning Gmail${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
    case "complete":
      return `Backfill complete${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
    case "failed":
      return `Stopped${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
  }
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { marginBottom: 12 },
  rowSub: { marginTop: 2 },
  connectionRow: { alignItems: "flex-start", flexWrap: "wrap" },
  serviceList: { marginTop: 12, gap: 12 },
  serviceBlock: {
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 12,
    gap: 10,
  },
  serviceHead: { flexDirection: "row", gap: 12, alignItems: "flex-start", flexWrap: "wrap" },
  serviceText: { flexGrow: 1, flexShrink: 1, flexBasis: 240 },
  destinationRow: { flexDirection: "row", gap: 10, alignItems: "flex-end", flexWrap: "wrap" },
  destinationField: { flexGrow: 1, flexShrink: 1, flexBasis: 280 },
  destinationSave: { marginTop: 18 },
  inlineError: { marginTop: 10 },
  empty: { marginTop: 4 },
  connect: { marginTop: 14, gap: 12 },
  connectionBody: { flexBasis: 280 },
  connectionActions: { marginLeft: "auto", gap: 8 },
  note: { marginTop: 2 },
});

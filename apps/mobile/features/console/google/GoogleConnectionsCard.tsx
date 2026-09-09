import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { FormError, TextField, ToggleGroup } from "../../design/components/Input";
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
  saveDestination: (
    connectionId: string,
    service: "gmail" | "calendar" | "chat",
    destinationPath: string,
  ) => Promise<unknown>;
}

/**
 * Which of an account's three services this card is about, or all of them.
 *
 * Settings asks one question per panel — Email, Calendar, Chats — and this
 * card's unit is a Google **account**, which carries all three at once. Three
 * panels needing "the Google part of this question" is therefore a real
 * problem, and there were two ways out of it.
 *
 * ## Why a prop, and not three smaller components
 *
 * A shared per-service component would have had to be handed the account list,
 * the connect flow, the owner gate, the disconnect arming and the error
 * surface anyway — so the "small" component is the card minus its frame, and
 * what is left over is three copies of the frame with three copies of the
 * decisions in it. `features/console/capabilities.ts` records what happens to
 * a rule that gets copied into a component: *every guard expressed inside a
 * component in this app was held by nothing*. The owner gate here is one such
 * rule, and it is worth exactly one implementation.
 *
 * So: one card, one `service`, and narrowing is a filter rather than a fork.
 * `service === undefined` is the whole card, unchanged, which is what the
 * un-sectioned settings pane and this card's own tests still render.
 *
 * ## What narrowing changes, and what it must not
 *
 * It changes what is *listed* (accounts not syncing this service are not this
 * panel's business), what a row *shows* (one service block, not three), and
 * what connecting *asks Google for* (this scope alone — a Calendar panel that
 * silently requested Gmail would be the worst kind of consent bug).
 *
 * It must not change who may act. Disconnect still removes the **account**,
 * not the service, because that is what `disconnect` does — so a narrowed card
 * says so out loud rather than letting a per-service heading imply a
 * per-service button.
 */
export type GoogleService = "gmail" | "calendar" | "chat";

/** The reader's word for each service, which is not always Google's. */
const SERVICE_TITLES: Record<GoogleService, string> = {
  gmail: "Email",
  calendar: "Calendar",
  chat: "Chat",
};

/**
 * What the card is called, what it says when it is empty, and what connecting
 * one more account is called.
 *
 * `next` is there because a narrowed card with nothing connected is the state
 * most people meet first, and "No Google calendar connected yet" over a page
 * of nothing is a heading with no answer under it. It says what a connection
 * *would* put on this card — a claim about this screen, which is a claim this
 * screen can keep. It deliberately does **not** name the folder a new
 * connection files into: that default lives in the control plane
 * (`defaultGoogleDestinationFolder`), and a copy of it here would be a
 * plausible sentence about somebody's bucket with nothing behind it, which is
 * the shape of defect #25.
 */
const SERVICE_COPY: Record<
  GoogleService,
  { title: string; sub: string; empty: string; next: string; connect: string }
> = {
  gmail: {
    title: "Google accounts",
    sub: "Each Google account whose mailbox this context reads.",
    empty: "No Google mailbox connected yet.",
    next: "Connect one and it appears here with its sync state and the daily note it writes to, which you can change.",
    connect: "Connect a Gmail account",
  },
  calendar: {
    title: "Google accounts",
    sub: "Each Google account whose calendar this context reads.",
    empty: "No Google calendar connected yet.",
    next: "Connect one and it appears here with its sync state and the daily note it writes to, which you can change.",
    connect: "Connect a Google Calendar",
  },
  chat: {
    title: "Google accounts",
    sub: "Each Google account whose Chat spaces this context reads.",
    empty: "No Google Chat account connected yet.",
    next: "Connect one and it appears here with the number of spaces it follows and the daily note it writes to, which you can change.",
    connect: "Connect Google Chat",
  },
};

/** Every service on this account except the one a narrowed panel is about. */
function otherServices(connection: GoogleConnection, service: GoogleService): string[] {
  return (["gmail", "calendar", "chat"] as const)
    .filter((key) => key !== service && connection.syncServices[key])
    .map((key) => SERVICE_TITLES[key]);
}

/** "Calendar", "Calendar and Chat", "Email, Calendar and Chat". */
function listWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function GoogleConnectionsCard({
  connections = [],
  actions,
  loading = false,
  service,
}: {
  connections?: GoogleConnection[];
  actions?: GoogleActions;
  loading?: boolean;
  /** Narrow the card to one service. Absent is the whole account. */
  service?: GoogleService;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    An account that does not sync this service is not this panel's business.
    Listing it would put a row somebody cannot act on under a heading about
    something it does not do — and its Disconnect button would be the only
    control on it, aimed at the services they came here for.
  */
  const shown =
    service === undefined
      ? connections
      : connections.filter((connection) => connection.syncServices[service]);
  const copy = service === undefined ? null : SERVICE_COPY[service];

  return (
    <Card>
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowTitle">{copy?.title ?? "Google accounts"}</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {copy?.sub ?? "Connect each Google account this context should sync."}
          </Text>
        </Grow>
        <Pill tone="neutral">{`${shown.length} connected`}</Pill>
      </Row>

      {shown.length === 0 ? (
        <Text variant="rowSub" style={styles.empty}>
          {loading
            ? "Loading Google accounts..."
            : (copy?.empty ?? "No Google accounts connected yet.")}
        </Text>
      ) : null}
      {shown.length === 0 && !loading && copy ? (
        <Text variant="rowSub" style={styles.empty}>
          {copy.next}
        </Text>
      ) : null}

      {shown.map((connection) => (
        <ConnectedGoogleRow
          key={connection.connectionId}
          connection={connection}
          actions={actions}
          service={service}
        />
      ))}

      {actions ? (
        <GoogleConnectControls actions={actions} service={service} />
      ) : (
        <Text variant="foot" style={styles.note}>
          Only an owner can connect or remove Google accounts.
        </Text>
      )}
    </Card>
  );
}

function GoogleConnectControls({
  actions,
  service,
}: {
  actions: GoogleActions;
  service?: GoogleService;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [services, setServices] = useState<GoogleSyncServices>({
    gmail: true,
    calendar: true,
    chat: true,
  });
  const google = useGoogleStart(actions.workspaceId);
  /*
    A narrowed panel asks Google for its own scope and nothing else. The
    toggles are the *whole* card's control — three services chosen at once —
    and reproducing them under a heading that says "Calendar" would offer
    somebody a Gmail scope they did not come here for.
  */
  const requested: GoogleSyncServices =
    service === undefined
      ? services
      : { gmail: service === "gmail", calendar: service === "calendar", chat: service === "chat" };
  const selected = Object.values(requested).some(Boolean);
  const starting = google.state.kind === "starting";

  return (
    <View style={styles.connect}>
      {service === undefined ? (
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
      ) : null}
      <Button
        label={
          starting
            ? "Opening Google..."
            : service === undefined
              ? "Connect Google account"
              : SERVICE_COPY[service].connect
        }
        disabled={!selected || starting || google.redirectUri === null}
        onPress={() => google.start(requested)}
        trailing={starting ? <ActivityIndicator color={colors.text} size="small" /> : null}
        testID="connect-google"
      />
      {service === undefined ? null : (
        <Text variant="foot" style={styles.note}>
          Google asks for this one thing. Connecting the same account under another
          heading adds that service to it rather than starting again.
        </Text>
      )}
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
  service,
}: {
  connection: GoogleConnection;
  actions?: GoogleActions;
  service?: GoogleService;
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
  /*
    Disconnect removes the account, never one service — `GoogleActions` has no
    per-service call and inventing one here would be a button that acts on
    something else. Under a per-service heading that has to be said, or the
    heading itself implies the narrower thing.
  */
  const alsoRemoved = service === undefined ? [] : otherServices(connection, service);
  const showBlock = (key: GoogleService) => service === undefined || service === key;

  return (
    <Row divided style={styles.connectionRow}>
      <Grow style={styles.connectionBody}>
        <Text variant="rowTitle">{connection.email}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {`${serviceNames.join(", ")} connected`}
        </Text>
        <View style={styles.serviceList}>
          {showBlock("gmail") && connection.syncServices.gmail && connection.gmail ? (
            <GoogleServiceBlock
              connectionId={connection.connectionId}
              service="gmail"
              title="Email"
              status={
                gmailRunDetail(connection) ??
                (connection.gmail.historyCursorReady
                  ? "Ready for new mail"
                  : "Connected; forward sync setup is pending")
              }
              destinationPath={connection.gmail.destinationPath}
              destinationHint="Use a folder plus YYYY-MM-DD.md; custom filenames are not supported yet."
              error={connection.syncRun?.status === "failed" ? inlineError : undefined}
              saveDestination={actions?.saveDestination}
            />
          ) : null}
          {showBlock("calendar") && connection.syncServices.calendar && connection.calendar ? (
            <GoogleServiceBlock
              connectionId={connection.connectionId}
              service="calendar"
              title="Calendar"
              status={
                connection.calendar.syncCursorReady
                  ? `Ready for calendar changes${formatSyncTime(connection.calendar.lastSyncedAt) ? ` · ${formatSyncTime(connection.calendar.lastSyncedAt)}` : ""}`
                  : "Connected; upcoming event sync setup is pending"
              }
              destinationPath={connection.calendar.destinationPath}
              destinationHint="Use a folder plus YYYY-MM-DD.md for daily calendar notes."
              saveDestination={actions?.saveDestination}
            />
          ) : null}
          {showBlock("chat") && connection.syncServices.chat && connection.chat ? (
            <GoogleServiceBlock
              connectionId={connection.connectionId}
              service="chat"
              title="Chat"
              status={
                connection.chat.cursorCount > 0
                  ? `Ready for ${connection.chat.cursorCount} Chat space${connection.chat.cursorCount === 1 ? "" : "s"}${formatSyncTime(connection.chat.lastSyncedAt) ? ` · ${formatSyncTime(connection.chat.lastSyncedAt)}` : ""}`
                  : "Connected; Chat sync setup is pending"
              }
              destinationPath={connection.chat.destinationPath}
              destinationHint="Use a folder plus YYYY-MM-DD.md for daily Chat notes."
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
          accessibilityLabel={
            alsoRemoved.length === 0
              ? `Disconnect ${connection.email}`
              : `Disconnect ${connection.email}, which also stops ${listWords(alsoRemoved)}`
          }
          variant="danger"
          disabled={actions === undefined}
          onPress={disconnect.press}
        />
        {alsoRemoved.length === 0 ? null : (
          <Text variant="foot" style={styles.alsoRemoved}>
            {`Removes the whole account — ${listWords(alsoRemoved)} stop too.`}
          </Text>
        )}
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
  actionLabel?: string;
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
        {actionLabel ? (
          <Button
            label={actionLabel}
            disabled={actionDisabled}
            onPress={onAction}
            testID={`start-google-${service}-${connectionId}`}
          />
        ) : null}
      </View>
      <View style={styles.destinationRow}>
        <TextField
          label={`${title} daily file pattern`}
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
          label={saving ? "Saving..." : "Save pattern"}
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
      {saveError ? <FormError headline="Pattern was not saved" next={saveError} /> : null}
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
      return "Stopping historical import";
    case "running":
      if (run.errorCode === "GOOGLE_RATE_LIMITED") {
        return `Paused by Google; historical import is being stopped${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
      }
      if (run.lastError) {
        return `Stopping historical import${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
      }
      return `Stopping historical import${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}`;
    case "complete":
      return null;
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
  connectionActions: { marginLeft: "auto", gap: 8, maxWidth: 220 },
  alsoRemoved: { marginTop: 2 },
  note: { marginTop: 2 },
});

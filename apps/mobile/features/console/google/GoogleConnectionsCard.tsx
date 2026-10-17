import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Card } from "../../design/components/Card";
import { Dot, type DotTone } from "../../design/components/Dot";
import { Menu } from "../../design/components/Menu";
import type { MenuItem } from "../files/menuItem";
import { FormError } from "../../design/components/Input";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { GOOGLE_REDIRECT_ORIGINS, type GoogleSyncServices } from "./google";
import {
  SERVICE_TITLES,
  accountStatus,
  enabledServices,
  formatDay,
  formatWhen,
  lastDelivered,
  listWords,
  type GoogleService,
} from "./googleStatus";
import { useGoogleStart } from "./useGoogleStart";

export { accountStatus } from "./googleStatus";

export interface GoogleSyncSchedule {
  intervalMinutes: number;
  /** Has a pass ever actually read mail from this account? */
  everSynced: boolean;
  /**
   * A cursor exists, so the next pass will read whatever arrives.
   *
   * Separate from `everSynced` because forward-only makes them genuinely
   * different: the pass that establishes a cursor reads nothing, by design,
   * and a card that treated it as a sync would show a mailbox as current
   * before a single message had been read — the same confusion this block
   * exists to end, one state later.
   */
  cursorReady: boolean;
  /** The last pass ran out of history pages and there is more to drain. */
  catchingUp: boolean;
  /** When a pass last finished, successfully or not. */
  lastAttemptAt?: number;
  nextDueAt?: number;
  lastFailureAt?: number;
  lastFailureCode?: string;
  lastFailure?: string;
}

export interface GoogleConnection {
  connectionId: string;
  email: string;
  syncServices: GoogleSyncServices;
  syncStatus: string;
  /**
   * How often this account is polled, and how the last poll went.
   *
   * Required rather than optional on purpose: every site that builds one of
   * these has to say whether this connection has ever synced, because "it
   * looks connected" and "it is actually syncing" being the same screen is the
   * defect this card is being changed to fix.
   */
  sync: GoogleSyncSchedule;
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
    /** Why this service's last turn failed; absent once it syncs again. */
    lastFailure?: string;
  };
  calendar?: {
    destinationFolder: string;
    destinationPath: string;
    syncCursorReady: boolean;
    lastSyncedAt?: number;
    /** Why this service's last turn failed; absent once it syncs again. */
    lastFailure?: string;
  };
  chat?: {
    destinationFolder: string;
    destinationPath: string;
    cursorCount: number;
    lastSyncedAt?: number;
    /** Why this service's last turn failed; absent once it syncs again. */
    lastFailure?: string;
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

/**
 * What an owner can do to a connected account, which is now exactly two things.
 *
 * `saveDestination` and `saveSyncInterval` were here and are gone with the
 * controls that called them (2026-09-18). Where a day lands and how often an
 * account is polled are no longer settings: every account writes to the folder
 * `defaultGoogleDestinationFolder` names and is checked every five minutes.
 * The object is still absent in full for anybody who is not this context's
 * owner, which is how connect and disconnect end up *absent* rather than
 * disabled.
 */
export interface GoogleActions {
  workspaceId: string;
  disconnect: (connectionId: string) => Promise<null>;
}


/** The mark for each service, on the row and in its folders. */
const SERVICE_ICONS: Record<GoogleService, IconName> = {
  gmail: "mail",
  calendar: "calendar",
  chat: "chat",
};

/** Google is always asked for all three at once; see `GoogleAddRow`. */
const EVERYTHING: GoogleSyncServices = { gmail: true, calendar: true, chat: true };

type StartGoogle = ReturnType<typeof useGoogleStart>;

/**
 * Every Google account this context reads, one row each.
 *
 * ## The shape (owner's pick, board 2, 2026-10-17)
 *
 * A row is the address, one short sentence, and a mark per service with its
 * own health dot, so which of Email, Calendar or Chat is stuck shows at a
 * glance. Everything there is to do to an account — Reconnect, its folders and
 * times, Disconnect — is in one menu behind "…", so the page carries no
 * buttons for the action nobody came to take. The one exception is a broken
 * account: its Reconnect is also on the row itself, because "there is no way
 * to reconnect" is the complaint this layout answers.
 *
 * Where a day lands and how often an account is polled are facts, stated once
 * under the list, not settings.
 *
 * The owner gate is the object's: `actions` is absent for anybody who is not
 * this context's owner, so Add, Reconnect and Disconnect are absent rather than
 * disabled, and this component re-decides nothing.
 */
export function GoogleConnectionsCard({
  connections = [],
  actions,
  loading = false,
}: {
  connections?: GoogleConnection[];
  actions?: GoogleActions;
  loading?: boolean;
}) {
  // The Google hook needs a Convex client, so it is only mounted for an owner:
  // nobody else has anything to start.
  return actions ? (
    <OwnerGoogleCard connections={connections} actions={actions} loading={loading} />
  ) : (
    <GoogleCardBody connections={connections} loading={loading} />
  );
}

function OwnerGoogleCard(props: {
  connections: GoogleConnection[];
  actions: GoogleActions;
  loading: boolean;
}) {
  const google = useGoogleStart(props.actions.workspaceId);
  return <GoogleCardBody {...props} google={google} />;
}

function GoogleCardBody({
  connections,
  actions,
  loading,
  google,
}: {
  connections: GoogleConnection[];
  actions?: GoogleActions;
  loading: boolean;
  google?: StartGoogle;
}) {
  const styles = useThemedStyles(makeStyles);
  const empty = connections.length === 0;

  return (
    <View>
      <Card style={styles.card}>
        {empty && !(actions && !loading) ? (
          <View style={styles.row}>
            <Text variant="rowSub">
              {loading ? "Loading Google accounts…" : "No Google account connected yet."}
            </Text>
          </View>
        ) : null}
        {connections.map((connection, index) => (
          <GoogleAccountRow
            key={connection.connectionId}
            connection={connection}
            actions={actions}
            google={google}
            first={index === 0}
          />
        ))}
        {google ? <GoogleAddRow google={google} first={empty} /> : null}
      </Card>

      {google?.state.kind === "failed" ? (
        <View style={styles.failure}>
          <FormError headline={google.state.headline} next={google.state.message} />
        </View>
      ) : null}
      {google?.redirectUri === null ? (
        <Text variant="foot" style={styles.note}>
          Google connect works in a browser at {GOOGLE_REDIRECT_ORIGINS.join(" or ")}.
        </Text>
      ) : null}
      <Text variant="foot" style={styles.note}>
        {empty
          ? "Bring in Gmail, Calendar and Chat. New mail arrives after you connect; earlier mail is not imported."
          : "Email, calendar and chat land in your inbox folder, checked every five minutes."}
        {actions ? "" : " Only an owner can connect or remove Google accounts."}
      </Text>
    </View>
  );
}

type RowAction = "reconnect" | "folders" | "disconnect";

/** One connected account: the address, one sentence, its services, and "…". */
function GoogleAccountRow({
  connection,
  actions,
  google,
  first,
}: {
  connection: GoogleConnection;
  actions?: GoogleActions;
  google?: StartGoogle;
  first: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const triggerRef = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const status = accountStatus(connection);
  const services = enabledServices(connection);
  const words = listWords(services.map((service) => SERVICE_TITLES[service]));
  const delivered = lastDelivered(connection);
  const starting = google?.state.kind === "starting";
  const canReconnect = google !== undefined && google.redirectUri !== null;
  const broken = status.tone === "crit";

  const sentence =
    broken && delivered !== undefined
      ? `Stopped ${formatDay(delivered)}. ${status.text}`
      : status.tone === "ok" && !connection.sync.catchingUp && delivered !== undefined
        ? `Up to date · ${formatWhen(delivered)}`
        : status.text;
  const tint = broken ? styles.critText : status.tone === "warn" ? styles.warnText : null;

  const reconnect = () => google?.start(EVERYTHING, connection.email);
  const items: MenuItem<RowAction>[] = [
    ...(canReconnect
      ? [{ id: "reconnect" as const, label: "Reconnect with Google", testID: `menu-reconnect-${connection.connectionId}` }]
      : []),
    {
      id: "folders",
      label: showFolders ? "Hide folders and times" : "Show folders and times",
      testID: `menu-folders-${connection.connectionId}`,
    },
    ...(actions === undefined
      ? []
      : [{
          id: "disconnect" as const,
          label: "Disconnect",
          danger: true,
          separatorBefore: true,
          testID: `menu-disconnect-${connection.connectionId}`,
        }]),
  ];
  const choose = (id: RowAction) => {
    setMenu(null);
    if (id === "reconnect") reconnect();
    if (id === "folders") setShowFolders((shown) => !shown);
    if (id === "disconnect") setConfirming(true);
  };
  const openMenu = () => {
    const fallback = { x: 0, y: 0 };
    setMenu(fallback);
    triggerRef.current?.measureInWindow?.((x, y, width, height) => {
      setMenu({ x: x + width - 220, y: y + height + 4 });
    });
  };

  return (
    <View style={first ? null : styles.divided}>
      <View style={styles.row}>
        <View style={styles.rowText}>
          <Text variant="rowTitle" numberOfLines={1}>
            {connection.email}
          </Text>
          <Text
            variant="rowSub"
            style={[styles.rowSub, tint]}
            /*
              Announced when it changes rather than only drawn: a grant that
              expired while somebody had this screen open is the one line on
              it that has to reach a reader who is not looking at it.
            */
            role={broken ? "status" : undefined}
          >
            {sentence}
            {broken && canReconnect ? " " : ""}
            {broken && canReconnect ? (
              <Text
                variant="rowSub"
                role="button"
                onPress={starting ? undefined : reconnect}
                style={styles.reconnect}
                accessibilityLabel={`Reconnect ${connection.email} with Google`}
                testID={`reconnect-google-${connection.connectionId}`}
              >
                {starting ? "Opening Google…" : "Reconnect"}
              </Text>
            ) : null}
          </Text>
        </View>
        <View
          style={styles.services}
          accessibilityRole="text"
          accessibilityLabel={serviceLabel(connection, services)}
        >
          {services.map((service) => (
            <View key={service} style={styles.serviceMark}>
              <Icon name={SERVICE_ICONS[service]} size={13} color={colors.text2} />
              <Dot tone={serviceTone(connection, service)} size={9} style={styles.serviceDot} />
            </View>
          ))}
        </View>
        <View ref={triggerRef}>
          <Pressable
            onPress={openMenu}
            style={styles.more}
            accessibilityRole="button"
            aria-haspopup="menu"
            accessibilityLabel={`More for ${connection.email}`}
            testID={`google-account-${connection.connectionId}`}
          >
            <Icon name="more" size={16} color={colors.muted} />
          </Pressable>
        </View>
      </View>
      {menu !== null ? (
        <Menu<RowAction>
          items={items}
          title={connection.email}
          titleDetail={sentence}
          anchor={menu}
          onSelect={choose}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {showFolders ? <AccountDetail connection={connection} services={services} /> : null}
      {confirming && actions !== undefined ? (
        <View style={styles.confirm}>
          <Text variant="rowSub" role="status">
            {words === ""
              ? `Context stops reading ${connection.email}. Notes already saved stay where they are, and you can connect it again.`
              : `${words} stop for ${connection.email}. Notes already saved stay where they are, and you can connect it again.`}
          </Text>
          <View style={styles.confirmActions}>
            {/*
              Red text rather than a filled button: disconnecting is undone by
              connecting again and deletes nothing, so it is not a delete.
            */}
            <Text
              variant="rowTitle"
              role="button"
              onPress={() => {
                setConfirming(false);
                void actions.disconnect(connection.connectionId);
              }}
              style={styles.disconnect}
              accessibilityLabel={
                words === ""
                  ? `Disconnect ${connection.email}`
                  : `Disconnect ${connection.email}, which stops ${words}`
              }
              testID={`disconnect-google-${connection.connectionId}`}
            >
              Disconnect
            </Text>
            <Text
              variant="rowTitle"
              role="button"
              onPress={() => setConfirming(false)}
              style={styles.keep}
              testID={`keep-google-${connection.connectionId}`}
            >
              Keep it
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A service's own health, for its dot. */
function serviceTone(connection: GoogleConnection, service: GoogleService): DotTone {
  if (accountStatus(connection).tone === "crit") return "crit";
  const source = connection[service];
  if (source?.lastFailure !== undefined) return "warn";
  return source?.lastSyncedAt === undefined ? "neutral" : "ok";
}

/** The marks in words, with each one's health: an icon and a dot are not a label. */
function serviceLabel(connection: GoogleConnection, services: GoogleService[]): string {
  if (services.length === 0) return "No services granted";
  const said: Record<DotTone, string> = {
    ok: "up to date",
    warn: "paused",
    crit: "stopped",
    neutral: "waiting for its first sync",
  };
  return services
    .map((service) => `${SERVICE_TITLES[service]} ${said[serviceTone(connection, service)]}`)
    .join(", ");
}

/** An account's folders and each service's last delivery. */
function AccountDetail({
  connection,
  services,
}: {
  connection: GoogleConnection;
  services: GoogleService[];
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.detail}>
      {services.map((service, index) => {
        const source = connection[service];
        const line =
          source?.lastFailure !== undefined
            ? `${source.lastSyncedAt === undefined ? "Nothing yet" : `Last new ${service === "gmail" ? "mail" : "item"} ${formatWhen(source.lastSyncedAt)}`}. ${source.lastFailure}`
            : source?.lastSyncedAt === undefined
              ? "Waiting for the first sync."
              : `Up to date · ${formatWhen(source.lastSyncedAt)}`;
        return (
          <View key={service} style={[styles.service, index === 0 ? null : styles.serviceDivided]}>
            <View style={styles.serviceIcon}>
              <Icon name={SERVICE_ICONS[service]} size={14} color={colors.text2} />
            </View>
            <View style={styles.rowText}>
              <Text variant="rowTitle">{SERVICE_TITLES[service]}</Text>
              <Text variant="treeMetaMono" style={styles.path}>
                {source?.destinationFolder ?? "Waiting for setup"}
              </Text>
              <Text
                variant="rowSub"
                style={[styles.rowSub, source?.lastFailure === undefined ? null : styles.warnText]}
              >
                {line}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Adding an account, which asks Google for all three products at once.
 *
 * There is no product picker: Google's verification is project-wide and an
 * active OAuth request has to match the scopes submitted in Cloud Console, so
 * a toggle here would be a control that lies about what consent it asks for.
 */
function GoogleAddRow({ google, first }: { google: StartGoogle; first: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const starting = google.state.kind === "starting";
  return (
    <Pressable
      onPress={() => google.start(EVERYTHING)}
      disabled={starting || google.redirectUri === null}
      style={[styles.row, first ? null : styles.divided, google.redirectUri === null ? styles.busy : null]}
      accessibilityRole="button"
      testID="connect-google"
    >
      <View style={styles.plus}>
        {starting ? (
          <ActivityIndicator color={colors.accent} size="small" />
        ) : (
          <Icon name="plus" size={16} color={colors.accent} />
        )}
      </View>
      <Text variant="rowTitle" style={styles.addLabel}>
        {starting ? "Opening Google…" : first ? "Connect Google" : "Add a Google account"}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /*
      Longhands, not `padding`: RN-web lets `Card`'s own paddingVertical and
      paddingHorizontal win over a shorthand. The rows carry their own.
    */
    card: { paddingVertical: 0, paddingHorizontal: 0, overflow: "hidden" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      minHeight: 58,
    },
    divided: { borderTopWidth: 1, borderTopColor: colors.line },
    rowText: { flex: 1, minWidth: 0 },
    rowSub: { marginTop: 2 },
    critText: { color: colors.critText, fontWeight: "700" },
    warnText: { color: colors.warnText },
    reconnect: { color: colors.accent, fontWeight: "700", textDecorationLine: "underline" },
    services: { flexDirection: "row", gap: 6, alignItems: "center", flexShrink: 0 },
    serviceMark: {
      width: 26,
      height: 26,
      borderRadius: 7,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
    },
    serviceDot: {
      position: "absolute",
      right: -2,
      top: -2,
      borderWidth: 2,
      borderColor: colors.surface2,
      width: 11,
      height: 11,
      borderRadius: 6,
    },
    more: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: "center",
      justifyContent: "center",
    },
    confirm: { paddingHorizontal: 14, paddingBottom: 12, gap: 6 },
    confirmActions: { flexDirection: "row", gap: 20, alignItems: "center" },
    keep: { color: colors.text2, fontWeight: "600", paddingVertical: 4 },
    busy: { opacity: 0.6 },
    detail: { paddingLeft: 14, paddingRight: 14, paddingBottom: 8 },
    service: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 9 },
    serviceDivided: { borderTopWidth: 1, borderTopColor: colors.line },
    serviceIcon: { width: 20, alignItems: "center", paddingTop: 2 },
    path: { marginTop: 2 },
    disconnect: { color: colors.crit, fontWeight: "700", paddingVertical: 4, alignSelf: "flex-start" },
    plus: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1.5,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
    },
    addLabel: { color: colors.accent },
    failure: { marginTop: 8 },
    note: { marginTop: 8, paddingHorizontal: 4 },
  });

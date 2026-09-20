import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Hint } from "../../design/components/Field";
import { FormError } from "../../design/components/Input";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import { GOOGLE_REDIRECT_ORIGINS, type GoogleSyncServices } from "./google";
import { useGoogleStart } from "./useGoogleStart";

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

/** One of the three things a Google account carries into a context. */
export type GoogleService = "gmail" | "calendar" | "chat";

/** In the order Google's own consent screen lists them. */
const SERVICES: readonly GoogleService[] = ["gmail", "calendar", "chat"];

/** The reader's word for each service, which is not always Google's. */
const SERVICE_TITLES: Record<GoogleService, string> = {
  gmail: "Email",
  calendar: "Calendar",
  chat: "Chat",
};

/**
 * The mark beside each service on a resting account row.
 *
 * Three glyphs say what three headings and three copies of this card used to
 * say, in the width of one line — which is the whole reason the three panels
 * could become one. They are never the only statement of it: the row's
 * accessible name spells the services out in words, because every icon in this
 * set is drawn `aria-hidden` and an icon is not a label.
 */
const SERVICE_ICONS: Record<GoogleService, IconName> = {
  gmail: "mail",
  calendar: "calendar",
  chat: "chat",
};

/** "Calendar", "Calendar and Chat", "Email, Calendar and Chat". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The services this account actually carries, in a fixed order. */
function enabledServices(connection: GoogleConnection): GoogleService[] {
  return SERVICES.filter((service) => connection.syncServices[service]);
}

/**
 * The account at rest: one dot, one line.
 *
 * ## Bad news first, and the account's own before a service's
 *
 * This is the rule the three-panel layout could not keep. A stale grant
 * belongs to the *account*, the panels belonged to *services*, and so whether
 * a person saw "reconnect needed" depended on which of Email, Calendar or
 * Chats they happened to open — each of which answered the health question
 * from a different field. One row, one sentence, and it is the account's.
 *
 * `crit` is reserved for something a person has to act on. Everything else is
 * the same short line, because the schedule is no longer a setting and
 * "syncing" is the whole of what there is to say.
 */
export function accountStatus(connection: GoogleConnection): {
  tone: "ok" | "warn" | "crit";
  text: string;
} {
  const failed =
    connection.errorCode ??
    connection.syncRun?.errorCode ??
    (connection.syncStatus === "reconnect_required" || connection.syncStatus === "error"
      ? connection.syncStatus
      : undefined);
  if (failed !== undefined) {
    return {
      tone: "crit",
      /*
        The server's own sentence wherever there is one: it names the account
        and what to do. The fallback is written as a sentence here rather than
        dropped on the row as the fragment the status code is.
      */
      text:
        connection.lastError ??
        connection.syncRun?.lastError ??
        connection.sync.lastFailure ??
        (failed === "reconnect_required"
          ? "Reconnect this account before it can sync again."
          : "This account is not syncing."),
    };
  }
  // Connected and not yet proven, which is where every account lives between
  // the consent screen and its first pass. A real state, and not an error.
  if (!connection.sync.everSynced) {
    return { tone: "warn", text: "Connected; waiting for the first pass." };
  }
  if (connection.sync.catchingUp) return { tone: "ok", text: "Catching up on older mail." };
  return { tone: "ok", text: "Syncing." };
}

/**
 * Every Google account this context reads, as one row each.
 *
 * ## What this replaced
 *
 * Three copies of a much larger card — one under Email, one under Calendar,
 * one under Chats — each listing the same accounts, each with a destination
 * field per service, a six-button schedule picker, and its own Disconnect. Two
 * connected accounts drew six cards and eighteen interval buttons on one page,
 * for two values, and the owner called the result overwhelming (2026-09-18).
 *
 * What went is not just repetition, it is the settings themselves. Where a day
 * lands and how often an account is polled are facts now, stated once under
 * the list: every account writes to the folder the control plane names and is
 * checked every five minutes. A row is a thing that is connected, and its one
 * button does the one thing worth doing to it.
 *
 * The owner gate is unchanged and is still the object's: `actions` is absent
 * for anybody who is not this context's owner, so Add and Disconnect are
 * absent rather than disabled, and this component re-decides nothing —
 * `features/console/capabilities.ts` records what happens to a rule that gets
 * copied into a component.
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
  const styles = useThemedStyles(makeStyles);

  return (
    <Card>
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowTitle">Google</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            Gmail, Calendar and Chat. Google asks for all three at once, so an account
            carries whichever of them you granted.
          </Text>
        </Grow>
        {actions ? <GoogleConnectButton actions={actions} /> : null}
      </Row>

      {connections.length === 0 ? (
        <Row divided>
          <Grow>
            <Text variant="rowSub">
              {loading
                ? "Loading Google accounts…"
                : "No Google account connected yet. Adding one starts filling this context with your mail, calendar and chats."}
            </Text>
          </Grow>
        </Row>
      ) : (
        connections.map((connection) => (
          <GoogleAccountRow
            key={connection.connectionId}
            connection={connection}
            actions={actions}
          />
        ))
      )}

      {actions ? null : (
        <Text variant="foot" style={styles.note}>
          Only an owner can connect or remove Google accounts.
        </Text>
      )}
    </Card>
  );
}

/** One connected account: what it is, what it carries, and the way out. */
function GoogleAccountRow({
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
  const status = accountStatus(connection);
  const services = enabledServices(connection);
  const words = listWords(services.map((service) => SERVICE_TITLES[service]));

  return (
    <View>
      <Row divided style={styles.accountRow}>
        <Dot tone={status.tone} />
        <Grow style={styles.accountText}>
          <Text variant="rowTitle">{connection.email}</Text>
          <Text
            variant="rowSub"
            style={[styles.rowSub, status.tone === "crit" ? styles.critText : null]}
            /*
              Announced when it changes rather than only drawn: a grant that
              expired while somebody had this screen open is the one line on it
              that has to reach a reader who is not looking at it.
            */
            role={status.tone === "crit" ? "status" : undefined}
          >
            {status.text}
          </Text>
        </Grow>
        {/*
          The services, as marks. Labelled for assistive tech on the group
          rather than per glyph — "Email, Calendar and Chat" is the sentence,
          three separate labels would be three stops reading one fact.
        */}
        <View
          style={styles.services}
          accessibilityRole="text"
          accessibilityLabel={words === "" ? "No services granted" : `Syncing ${words}`}
        >
          {services.map((service) => (
            <View key={service} style={styles.serviceMark}>
              <Icon name={SERVICE_ICONS[service]} size={14} />
            </View>
          ))}
        </View>
        {/*
          Absent for anybody who is not the owner, rather than disabled. The
          old card drew it greyed out, which is a button inviting a press that
          can only refuse — and `sections.ts` records the rule this list
          follows everywhere else: a control that cannot act is not drawn.
        */}
        {actions === undefined ? null : (
          <Button
            label={disconnect.stage === "armed" ? "Press again" : "Disconnect"}
            accessibilityLabel={
              words === ""
                ? `Disconnect ${connection.email}`
                : `Disconnect ${connection.email}, which stops ${words}`
            }
            variant="danger"
            onPress={disconnect.press}
            testID={`disconnect-google-${connection.connectionId}`}
          />
        )}
      </Row>
      {/*
        The consequence at the moment of the press rather than beside the
        button always — `useArming`, the same shape as storage's Disconnect and
        a share's Revoke. It is the one place the account's three services have
        to be named in words: Disconnect is an *account* action, and a row
        showing three marks should not leave anybody guessing which of them
        stop.
      */}
      {disconnect.stage === "armed" ? (
        <Hint style={styles.armedHint}>
          <Text variant="hint" role="status">
            {words === ""
              ? `Context stops reading ${connection.email}. Nothing already written to your bucket is touched, and you can connect it again.`
              : `${words} stop for ${connection.email}. Nothing already written to your bucket is touched, and you can connect it again.`}
          </Text>
        </Hint>
      ) : null}
    </View>
  );
}

/**
 * Adding an account, which asks Google for all three products at once.
 *
 * The toggle group that used to sit here — Gmail, Calendar, Chat — is gone,
 * and it was already dead: every panel that rendered this card passed a
 * `service`, which forced the full scope set anyway, because Google's
 * verification is project-wide and an active OAuth request has to match the
 * scopes submitted in Cloud Console. A picker whose value was overridden on
 * every path is a control that lies about what consent it is about to ask for.
 */
function GoogleConnectButton({ actions }: { actions: GoogleActions }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const google = useGoogleStart(actions.workspaceId);
  const starting = google.state.kind === "starting";
  const everything: GoogleSyncServices = { gmail: true, calendar: true, chat: true };

  return (
    <View style={styles.connect}>
      <Button
        label={starting ? "Opening Google…" : "Add account"}
        disabled={starting || google.redirectUri === null}
        onPress={() => google.start(everything)}
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

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 2 },
    rowSub: { marginTop: 2 },
    note: { marginTop: 8 },
    connect: { alignItems: "flex-end" },
    accountRow: { flexWrap: "wrap", gap: 10 },
    /*
      A floor under the text column so the marks and the button wrap whole
      rather than squeezing the address into one word per line. The number is
      `PrivacyPanel`'s, for its reason: a growing column shrinks to zero before
      a sibling wraps, which at 390pt turned an address into five lines.
    */
    accountText: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 180 },
    services: { flexDirection: "row", gap: 5, alignItems: "center" },
    serviceMark: {
      width: 22,
      height: 22,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface3,
    },
    critText: { color: colors.critText },
    armedHint: { marginTop: 10 },
  });

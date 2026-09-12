import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Hint } from "../../design/components/Field";
import { FormError, TextField, ToggleGroup } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import { destinationDraft } from "./destination";
import { GOOGLE_REDIRECT_ORIGINS, type GoogleSyncServices } from "./google";
import { useGoogleStart } from "./useGoogleStart";

/**
 * The floor, and the choices offered for it.
 *
 * The floor is the server's (`functions/googleSync.ts`,
 * `MIN_SYNC_INTERVAL_MINUTES`) and is restated here only to build the picker —
 * a value typed past it is refused by the mutation, not by this list, which is
 * why the refusal is shown rather than prevented.
 */
export const SYNC_INTERVAL_CHOICES = [5, 15, 30, 60, 240, 1440] as const;

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

export interface GoogleActions {
  workspaceId: string;
  disconnect: (connectionId: string) => Promise<null>;
  saveDestination: (
    connectionId: string,
    service: "gmail" | "calendar" | "chat",
    destinationPath: string,
  ) => Promise<unknown>;
  /**
   * How often this account is polled. Owner-only like every other action on
   * this object — the whole object is absent for anybody else, which is how
   * the control ends up *absent* rather than disabled.
   */
  saveSyncInterval: (connectionId: string, syncIntervalMinutes: number) => Promise<unknown>;
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
  { empty: string; next: string; connect: string }
> = {
  gmail: {
    empty: "No Google mailbox connected yet.",
    next: "Connect one and it appears here with its sync state and the daily note it writes to, which you can change.",
    connect: "Connect a Gmail account",
  },
  calendar: {
    empty: "No Google calendar connected yet.",
    next: "Connect one and it appears here with its sync state and the daily note it writes to, which you can change.",
    connect: "Connect a Google Calendar",
  },
  chat: {
    empty: "No Google Chat account connected yet.",
    next: "Connect one and it appears here with the number of spaces it follows and the daily note it writes to, which you can change.",
    connect: "Connect Google Chat",
  },
};

/**
 * The card's title on a narrowed panel.
 *
 * Names the *account* and the service in one line, so the sub that used to
 * restate the panel's own heading underneath it can go. "Accounts we read
 * calendars from" rather than "Google accounts" over "Each Google account whose
 * calendar this context reads".
 */
const SERVICE_ACCOUNTS_TITLE: Record<GoogleService, string> = {
  gmail: "Accounts we read mail from",
  calendar: "Accounts we read calendars from",
  chat: "Accounts we read Chat from",
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
  folders = [],
}: {
  connections?: GoogleConnection[];
  actions?: GoogleActions;
  loading?: boolean;
  /** Narrow the card to one service. Absent is the whole account. */
  service?: GoogleService;
  /**
   * Folders the console has already loaded, offered as completions in the
   * destination editor. `loadedFolders(files.listings)` — the same source the
   * forwarding-address card's quick-picks read, rather than a second listing.
   *
   * Empty is a card that completes nothing, which is what a panel opened
   * before the tree landed should do: no suggestions is honest, an invented
   * folder list is not.
   */
  folders?: readonly string[];
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
      {/*
        The scope, once.

        This said it four times: a title ("Google accounts"), a sub ("Each
        Google account whose calendar this context reads"), a pill, and then
        every account row underneath repeating "Email, Calendar, Chat
        connected". On a two-account Calendar panel a reader was told about
        Email and Chat four times while trying to change one path.

        The title is still the *account* rather than the service, and that is
        not decoration: Disconnect removes the account, so a card titled
        "Google calendars" over a button that also stops mail would be the
        narrower name doing the misleading. What went is the second sentence
        restating the panel's own heading, and the per-row service list — which
        now appears once per account, as the sentence that qualifies
        Disconnect, where it is load-bearing rather than repetitive.
      */}
      <Row style={styles.head}>
        <Grow>
          <Text variant="rowTitle">
            {service === undefined ? "Google accounts" : SERVICE_ACCOUNTS_TITLE[service]}
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
          folders={folders}
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

/**
 * One connected account: what it is, where it writes, and the way out.
 *
 * ## What this replaced
 *
 * A `Row` inside the card, holding a bordered `serviceBlock` per service, each
 * holding a labelled field and its own Save button — three nested surfaces
 * before the one control, four with the schedule. Beside it, a fixed
 * right-hand column carrying a `danger` button and the standing sentence
 * "Removes the whole account — Calendar and Chat stop too", drawn once per
 * account and never not on screen. On a two-account panel the most visually
 * dominant thing was destructive text nobody had asked to read.
 *
 * Now: one card per account, the destination as a row you open, and the
 * consequence of Disconnect said **between the two presses** — which is where
 * every other irreversible control in this console says it (`useArming`, the
 * same shape as storage's Disconnect and a share's Revoke). The account still
 * arms; it just no longer shouts while resting.
 *
 * `alsoRemoved` stays, as the quiet line above the control rather than beside
 * it, because it is the one thing a narrowed panel must say: Disconnect is an
 * *account* action, `GoogleActions` has no per-service call, and a reader who
 * arrived from the Calendar heading would otherwise have no way to know their
 * mail stops too.
 */
function ConnectedGoogleRow({
  connection,
  actions,
  service,
  folders,
}: {
  connection: GoogleConnection;
  actions?: GoogleActions;
  service?: GoogleService;
  folders: readonly string[];
}) {
  const styles = useThemedStyles(makeStyles);
  const disconnect = useArming(() => {
    if (actions === undefined) return;
    void actions.disconnect(connection.connectionId);
  });
  const inlineError = connection.lastError ?? connection.syncRun?.lastError;
  const inlineErrorCode = connection.errorCode ?? connection.syncRun?.errorCode;
  const showAccountError = inlineError && connection.syncRun?.status !== "failed";
  const alsoRemoved = service === undefined ? [] : otherServices(connection, service);
  const showBlock = (key: GoogleService) => service === undefined || service === key;

  return (
    <View style={styles.account}>
      <Row style={styles.accountHead}>
        <Grow>
          <Text variant="rowTitle">{connection.email}</Text>
        </Grow>
      </Row>

      {showBlock("gmail") && connection.syncServices.gmail && connection.gmail ? (
        <GoogleServiceBlock
          connectionId={connection.connectionId}
          service="gmail"
          title={SERVICE_TITLES.gmail}
          status={
            gmailRunDetail(connection) ??
            (connection.gmail.historyCursorReady
              ? "Ready for new mail"
              : "Connected; forward sync setup is pending")
          }
          destinationPath={connection.gmail.destinationPath}
          destinationHint="A folder, or a pattern ending in /YYYY-MM-DD.md."
          error={connection.syncRun?.status === "failed" ? inlineError : undefined}
          saveDestination={actions?.saveDestination}
          folders={folders}
          named={service === undefined}
        />
      ) : null}
      {showBlock("calendar") && connection.syncServices.calendar && connection.calendar ? (
        <GoogleServiceBlock
          connectionId={connection.connectionId}
          service="calendar"
          title={SERVICE_TITLES.calendar}
          status={
            connection.calendar.syncCursorReady
              ? `Ready for calendar changes${formatSyncTime(connection.calendar.lastSyncedAt) ? ` · ${formatSyncTime(connection.calendar.lastSyncedAt)}` : ""}`
              : "Connected; upcoming event sync setup is pending"
          }
          destinationPath={connection.calendar.destinationPath}
          destinationHint="A folder, or a pattern ending in /YYYY-MM-DD.md."
          saveDestination={actions?.saveDestination}
          folders={folders}
          named={service === undefined}
        />
      ) : null}
      {showBlock("chat") && connection.syncServices.chat && connection.chat ? (
        <GoogleServiceBlock
          connectionId={connection.connectionId}
          service="chat"
          title={SERVICE_TITLES.chat}
          status={
            connection.chat.cursorCount > 0
              ? `Ready for ${connection.chat.cursorCount} Chat space${connection.chat.cursorCount === 1 ? "" : "s"}${formatSyncTime(connection.chat.lastSyncedAt) ? ` · ${formatSyncTime(connection.chat.lastSyncedAt)}` : ""}`
              : "Connected; Chat sync setup is pending"
          }
          destinationPath={connection.chat.destinationPath}
          destinationHint="A folder, or a pattern ending in /YYYY-MM-DD.md."
          saveDestination={actions?.saveDestination}
          folders={folders}
          named={service === undefined}
        />
      ) : null}

      {/*
        The schedule is the *account's* — one grant, one pass — but only Gmail
        is advanced by that pass today, so it is drawn only where Gmail is in
        view. A Calendar or Chat panel showing "every 15 minutes, next due at
        10:15" would be a promise this loop does not yet keep for those two;
        their own status lines already say their sync is pending. When they
        join the loop, this condition is what goes.
      */}
      {connection.syncServices.gmail && showBlock("gmail") ? (
        <GoogleSyncScheduleBlock
          connectionId={connection.connectionId}
          sync={connection.sync}
          saveSyncInterval={actions?.saveSyncInterval}
        />
      ) : null}

      {showAccountError ? (
        <FormError
          headline={inlineErrorCode ? statusLabel(inlineErrorCode) : "Google needs attention"}
          next={inlineError}
          style={styles.inlineError}
        />
      ) : null}

      <Row divided style={styles.accountFoot}>
        <Grow>
          {alsoRemoved.length === 0 ? null : (
            <Text variant="foot">{`This account also syncs ${listWords(alsoRemoved)}.`}</Text>
          )}
        </Grow>
        <Button
          label={disconnect.stage === "armed" ? "Press again to disconnect" : "Disconnect"}
          accessibilityLabel={
            alsoRemoved.length === 0
              ? `Disconnect ${connection.email}`
              : `Disconnect ${connection.email}, which also stops ${listWords(alsoRemoved)}`
          }
          variant="danger"
          disabled={actions === undefined}
          onPress={disconnect.press}
        />
      </Row>
      {/*
        The consequence, at the moment of the press rather than beside the
        button always. Announced when it appears, not only drawn: it is the
        warning, and a reader who cannot see it is the reader most likely to
        press again.
      */}
      {disconnect.stage === "armed" ? (
        <Hint style={styles.armedHint}>
          <Text variant="hint" role="status">
            {alsoRemoved.length === 0
              ? `Context stops reading ${connection.email}. Nothing already written to your bucket is touched, and you can connect it again.`
              : `This removes the whole account — ${listWords(alsoRemoved)} stop too. Nothing already written to your bucket is touched, and you can connect it again.`}
          </Text>
        </Hint>
      ) : null}
    </View>
  );
}

/**
 * HOW OFTEN THIS ACCOUNT IS POLLED, AND WHETHER IT EVER HAS BEEN.
 *
 * Per account rather than per service, because the loop is: one Google account
 * is one grant, and one pass advances whichever products it enables. Putting a
 * schedule inside each service block would offer three answers to a question
 * that has one.
 *
 * The picker is owner-only by being drawn only when `saveSyncInterval` was
 * passed — `GoogleActions` is absent in full for anybody else, which is this
 * repository's rule throughout: *absent* rather than disabled. The status
 * lines above it are shown to the owner either way, because a person who
 * cannot change the schedule can still need to know the last pass failed.
 *
 * The floor is not enforced here. `SYNC_INTERVAL_CHOICES` starts at it, and
 * anything lower is refused by the mutation — so a refusal is *rendered*
 * rather than made impossible to provoke, which is what makes the server-side
 * check the one that matters.
 */
function GoogleSyncScheduleBlock({
  connectionId,
  sync,
  saveSyncInterval,
}: {
  connectionId: string;
  sync: GoogleSyncSchedule;
  saveSyncInterval?: GoogleActions["saveSyncInterval"];
}) {
  const styles = useThemedStyles(makeStyles);
  const [saving, setSaving] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  return (
    <View style={styles.serviceBlock}>
      <Text variant="rowTitle">Sync schedule</Text>
      <Text variant="rowSub" style={styles.rowSub}>
        {describeSchedule(sync)}
      </Text>
      {saveSyncInterval ? (
        <View style={styles.intervalRow}>
          {SYNC_INTERVAL_CHOICES.map((minutes) => {
            const current = minutes === sync.intervalMinutes;
            return (
            <Button
              key={minutes}
              label={intervalLabel(minutes)}
              /*
                `mini` with a mark, never `white`.

                The current value was drawn as the hero CTA — the same button
                the landing page says "Get started" with — *and* disabled. So
                the loudest element on the card was a fact nobody could act on,
                and the five buttons that did something were the quiet ones.
                Marked twice, the way `AppearancePanel` marks its current
                choice: a leading check (so it reads without colour) and an
                accent tint (so it reads at a glance).
              */
              variant="mini"
              style={current ? styles.intervalOn : undefined}
              leading={current ? <Text style={styles.intervalCheck}>{"✓ "}</Text> : undefined}
              /*
                The state is in the spoken label rather than in
                `accessibilityState`: `Button` does not take one, and the
                current choice is a *disabled* control, which a screen reader
                already announces. "Syncing every 15 min" says which it is;
                `AppearancePanel` says "current appearance" the same way.
              */
              disabled={saving !== null || current}
              accessibilityLabel={
                current
                  ? `Syncing every ${intervalLabel(minutes)}`
                  : `Sync every ${intervalLabel(minutes)}`
              }
              testID={`google-sync-interval-${minutes}-${connectionId}`}
              onPress={() => {
                setSaving(minutes);
                setSaveError(null);
                void saveSyncInterval(connectionId, minutes)
                  .catch((reason) => {
                    setSaveError(
                      reason instanceof Error ? reason.message : "That schedule did not save.",
                    );
                  })
                  .finally(() => setSaving(null));
              }}
            />
            );
          })}
        </View>
      ) : null}
      {saveError ? <FormError headline="Schedule was not saved" next={saveError} /> : null}
      {sync.lastFailure ? (
        <Text variant="foot" style={styles.note}>
          {`Last failure${formatWhen(sync.lastFailureAt) ? ` ${formatWhen(sync.lastFailureAt)}` : ""}: ${sync.lastFailure}`}
        </Text>
      ) : null}
    </View>
  );
}

/** "5 min", "1 hour", "Daily" — the picker's own words. */
function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes === 1440) return "Daily";
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * One sentence that never lets "connected" pass for "syncing".
 *
 * A connection that has never read anything says exactly that, with what is
 * about to happen next — which is the state every connected mailbox in this
 * product was in, indistinguishable from a healthy one, until the loop
 * existed.
 */
function describeSchedule(sync: GoogleSyncSchedule): string {
  const every = `Every ${intervalLabel(sync.intervalMinutes)}`;
  const next = sync.nextDueAt === undefined ? "due now" : `next ${formatWhen(sync.nextDueAt)}`;
  // Still working through a backlog: the interval is not what happens next.
  if (sync.catchingUp) return `${every} · catching up on older mail · next pass shortly`;
  if (!sync.everSynced) {
    if (sync.lastFailureAt !== undefined && !sync.cursorReady) {
      return `${every} · has not synced successfully yet · ${next}`;
    }
    // A cursor and no mail read is its own state, and saying "never synced"
    // over it would be as wrong as saying nothing: this account is watching,
    // it has simply had nothing to read since it was connected.
    if (sync.cursorReady) return `${every} · watching for new mail; none read yet · ${next}`;
    return `${every} · never synced yet · ${next}`;
  }
  return `${every} · ${next}`;
}

function formatWhen(value: number | undefined): string | null {
  if (value === undefined) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * One service on one account: its state, and where it writes.
 *
 * ## The field is opened, not always open
 *
 * It used to be a `TextField` with an uppercase label, a hint sentence and a
 * Save button, drawn at rest inside a bordered block — three of them per
 * account. Nobody edits three paths at once; what they do is read one and
 * occasionally change it. So the resting state is a row that states the path,
 * and Change opens the editor.
 *
 * That is also what makes room for the three things the field never had, all
 * decided in `destination.ts` and pinned by `googleDestination.test.ts`:
 *
 *  - **completion**, from the folders the console has already loaded;
 *  - **validation**, in the server's own words, before the round trip — the
 *    same `normalizeDestinationFolder` the mutation calls;
 *  - **a preview** of the key today's sync would write, because a pattern
 *    carrying `YYYY-MM-DD` is a template and nothing ever showed its output.
 *
 * The path is `mono`, which it should always have been: every other path in
 * this console is, and a proportional face is what let a value scroll out of a
 * field narrower than itself without anybody noticing.
 */
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
  folders = [],
  named = true,
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
  folders?: readonly string[];
  /**
   * Whether to name the service above its row.
   *
   * On a narrowed panel the heading already said it and the card title says it
   * again; a third "Calendar" over the one calendar row is the repetition this
   * rework exists to remove. On the whole-account card the three rows need
   * telling apart, so there it stays.
   */
  named?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(destinationPath);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /*
    A destination that changed under us — another console, or the first load
    landing — closes the editor rather than silently rebasing a draft on top of
    it. The person can see the new value and decide again; a draft typed
    against the old one is an edit to something that is no longer there.
  */
  useEffect(() => {
    setDraft(destinationPath);
    setSaveError(null);
    setEditing(false);
  }, [destinationPath]);

  /*
    `new Date()` per render rather than a memo keyed on nothing: the preview
    says what *today* writes, and a settings panel left open across midnight
    should not keep claiming yesterday. The module takes the date rather than
    reading the clock precisely so this stays the component's business.
  */
  const view = useMemo(
    () => destinationDraft({ value: draft, saved: destinationPath, folders, now: new Date() }),
    [draft, destinationPath, folders],
  );

  const canEdit = !destinationReadOnly && saveDestination !== undefined;

  const save = () => {
    if (saveDestination === undefined) return;
    setSaving(true);
    setSaveError(null);
    void saveDestination(connectionId, service, draft)
      .then(() => setEditing(false))
      .catch((reason) => {
        setSaveError(reason instanceof Error ? reason.message : "That path did not save.");
      })
      .finally(() => setSaving(false));
  };

  return (
    <View style={styles.serviceBlock}>
      <Row divided style={styles.serviceRow}>
        <Grow style={styles.serviceText}>
          {named ? <Text variant="rowTitle">{title}</Text> : null}
          <Text variant="rowSub" style={named ? styles.rowSub : undefined}>
            {status}
          </Text>
        </Grow>
        {actionLabel ? (
          <Button
            label={actionLabel}
            disabled={actionDisabled}
            onPress={onAction}
            testID={`start-google-${service}-${connectionId}`}
          />
        ) : null}
      </Row>

      <Row divided style={styles.serviceRow}>
        <Grow style={styles.serviceText}>
          <Text variant="rowSub">Where it lands</Text>
          <Text variant="mono" numberOfLines={1} style={styles.destinationValue}>
            {destinationPath}
          </Text>
        </Grow>
        {canEdit && !editing ? (
          <Button
            label="Change"
            accessibilityLabel={`Change where ${title} lands`}
            onPress={() => setEditing(true)}
            testID={`edit-google-${service}-destination-${connectionId}`}
          />
        ) : null}
      </Row>

      {editing ? (
        <View style={styles.editor}>
          <TextField
            label={`Where ${title} lands`}
            value={draft}
            onChangeText={(value) => {
              setDraft(value);
              setSaveError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={destinationPath}
            hint={destinationHint}
            error={view.problem ?? undefined}
            style={styles.destinationInput}
            testID={`google-${service}-destination-${connectionId}`}
          />

          {/*
            The folders this console has already loaded, under the one being
            typed. Absent rather than empty when there is nothing to offer: a
            row of nothing under a field is a control that failed, and a panel
            opened before the tree landed has genuinely nothing to say.
          */}
          {view.suggestions.length === 0 ? null : (
            <View style={styles.suggestions}>
              {view.suggestions.map((folder) => (
                <Button
                  key={folder}
                  label={folder}
                  variant="mini"
                  accessibilityLabel={`Use ${folder}`}
                  onPress={() => setDraft(`${folder}/YYYY-MM-DD.md`)}
                  testID={`google-${service}-suggest-${connectionId}-${folder}`}
                />
              ))}
            </View>
          )}

          {/*
            What the pattern writes, today. The one thing that turns a template
            somebody is guessing at into a path they can read back.
          */}
          {view.preview === null ? null : (
            <Text variant="foot" testID={`google-${service}-preview-${connectionId}`}>
              {"Today this writes "}
              <Text variant="mono" style={styles.previewPath}>
                {view.preview}
              </Text>
            </Text>
          )}

          <Row style={styles.editorActions}>
            <Button
              label={saving ? "Saving..." : "Save"}
              disabled={!view.canSave || saving}
              onPress={save}
              testID={`save-google-${service}-destination-${connectionId}`}
            />
            <Button
              label="Cancel"
              variant="ghost"
              disabled={saving}
              onPress={() => {
                setDraft(destinationPath);
                setSaveError(null);
                setEditing(false);
              }}
              testID={`cancel-google-${service}-destination-${connectionId}`}
            />
          </Row>
        </View>
      ) : null}

      {/*
        The server's refusal, which is not the same thing as `view.problem`.
        That one is this console's reading of the rule, shown while typing;
        this one is what actually came back — a conflict with another account's
        folder, say, which no client-side check can see.
      */}
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
  /** One account. No border of its own — the card it sits in is the surface. */
  account: { marginTop: 4 },
  accountHead: { marginBottom: 2 },
  accountFoot: { marginTop: 2, flexWrap: "wrap", gap: 10 },
  armedHint: { marginTop: 10 },
  serviceBlock: { marginTop: 2 },
  /*
    A floor under the text column, so the action group wraps whole rather than
    squeezing the status line into one word per line. The number and the reason
    are `PrivacyPanel`'s: a growing column shrinks to zero before a sibling
    wraps, which at 390pt turned a folder name into five lines of one letter.
  */
  serviceRow: { flexWrap: "wrap", alignItems: "flex-start", gap: 10 },
  serviceText: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 180 },
  destinationValue: { marginTop: 2 },
  destinationInput: {
    fontFamily: "JetBrainsMono_400Regular",
    // A path is read character by character, so the face that shows a `l` and
    // a `1` apart is the one it belongs in — the same reason every other path
    // in this console is `mono`.
    fontSize: 12.5,
  },
  editor: { marginTop: 12, gap: 10 },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  previewPath: { color: colors.text2 },
  editorActions: { gap: 9, flexWrap: "wrap" },
  inlineError: { marginTop: 10 },
  empty: { marginTop: 4 },
  connect: { marginTop: 14, gap: 12 },
  intervalRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  intervalOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
  intervalCheck: { color: colors.accentText },
  note: { marginTop: 2 },
});

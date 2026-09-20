/**
 * `/admin` — the staff console.
 *
 * ## The screen is not the authorization
 *
 * `amIAdmin` decides what to *render*. It decides nothing else: `usageReport`,
 * `censusReport`, `listSecrets`, `setSecret` and `deleteSecret` each call
 * `requireAdmin` server-side, so a client that forces the boolean gets a page
 * whose every query throws. That is the arrangement to keep — a screen that is
 * the only thing standing between somebody and a credential store is not a
 * security boundary, it is a suggestion.
 *
 * The corollary is that the admin queries are **skipped**, not merely hidden,
 * for a non-admin: they throw for that caller, and `useQuery` re-throws a
 * failed query during render, so subscribing and ignoring the result would
 * crash the app rather than show an empty page.
 *
 * ## Why this page is shaped for ten customers rather than ten thousand
 *
 * It used to be eleven identical tiles and a credential form in one scroll.
 * Everything in it was a count of events, every tile had the same visual
 * weight, and the only comparison offered was day-over-day — which at this
 * size is noise, because one person opening the app twice is `+100%`. None of
 * the questions actually being asked ("is anybody new here", "how many of
 * these buckets are we paying for", "who is connected") could be answered from
 * it at all.
 *
 * Four things changed, and each is a claim about a product with single-digit
 * customers rather than a style preference:
 *
 *  1. **Absolute change, not percentages.** `+2 — 3 vs 1 before`. A ratio needs
 *     a denominator big enough to carry information; these do not have one yet.
 *  2. **Composition before count.** Managed against customer-owned storage,
 *     personal against shared, paying against free: at n=11 the interesting
 *     fact is nearly always *out of what*, and a stacked bar with the counts
 *     beside it says that where a row of tiles cannot.
 *  3. **A funnel and a roster, because at this size the answer is a person.**
 *     Five accounts, two of which never connected a bucket, is a morning's
 *     work to fix — and it is invisible on any page that only aggregates.
 *  4. **Four tabs, because there are four errands.** Growth, estate, activity,
 *     credentials. Rotating a Stripe key and reading a growth figure should
 *     not be the same scroll.
 *
 * The arithmetic is in `./report`, the shapes are in `./Charts`, and both are
 * tested without mounting anything — a figure that is quietly wrong is worse
 * than one that is missing, because nobody goes looking for it.
 */

import { useMemo, useState } from "react";
import { View, StyleSheet } from "react-native";
import { ScreenScroll } from "../app/Screen";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import {
  Button,
  Card,
  Notice,
  Pill,
  Text,
  TextField,
  space,
  useThemedStyles,
  type Colors,
} from "../design";
import {
  CompositionBar,
  FactRow,
  FunnelChart,
  GrowthCurve,
  StatTile,
  TrendBars,
} from "./Charts";
import {
  ADMIN_TABS,
  DEFAULT_WINDOW,
  KNOWN_SECRETS,
  WINDOW_CHOICES,
  bindingStatusLabel,
  bindingStatusTone,
  compositionOf,
  dayOverDay,
  formatCount,
  formatDelta,
  formatLastUsed,
  formatMoney,
  formatRatio,
  formatSigned,
  formatTotal,
  funnelRows,
  metricLabel,
  orderSeries,
  periodCaption,
  planLabel,
  planTone,
  providerLabel,
  relativeTime,
  unsetKnownSecrets,
  type AdminTab,
} from "./report";

export function AdminPane() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});

  // Undefined until the first round trip lands, which is not the same as
  // `false`. Rendering the refusal while it is unresolved would flash "not
  // found" at an admin on every cold load.
  if (isAdmin === undefined) return <AdminChrome><Loading /></AdminChrome>;
  if (!isAdmin) return <AdminChrome><NotFound /></AdminChrome>;
  return (
    <AdminChrome>
      <Console />
    </AdminChrome>
  );
}

/**
 * The page's own surface, exported so it can be mounted without Convex.
 *
 * `__tests__/safeArea.test.ts` mounts every route and asserts that its text
 * clears the notch and the home indicator. `AdminPane` is a live subscription
 * from its first line, so what that census mounts is this — the whole of what
 * the route ever paints — for the reason `WelcomeChrome` is exported next
 * door.
 *
 * `ScreenScroll` rather than a bare `ScrollView`: it owns the safe-area
 * padding, and a page outside the console frame has nothing else supplying it.
 */
export function AdminChrome({ children }: { children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <ScreenScroll
      style={styles.scroll}
      contentContainerStyle={styles.content}
      testID="admin-pane"
    >
      {children}
    </ScreenScroll>
  );
}

function Loading() {
  return <Text variant="paneSub">Loading…</Text>;
}

/**
 * What a non-admin sees.
 *
 * The same words the server's refusal uses, and deliberately not "you are not
 * an administrator": the route is in a public repository so its existence is
 * not a secret, but confirming to a signed-in stranger that their account is
 * the only thing between them and it is still an oracle worth not running.
 */
function NotFound() {
  return (
    <View>
      <Text variant="paneTitle">Not found</Text>
      <Text variant="paneSub">There is nothing at this address.</Text>
    </View>
  );
}

// -- the console ----------------------------------------------------------

/**
 * The tabs, and the one piece of state they share.
 *
 * The window lives here rather than inside a tab so that switching from
 * Growth to Activity keeps the period somebody chose. Two tabs asking
 * different questions of the same thirty days is the common case; re-picking
 * the window every time you cross a tab is not a feature.
 */
function Console() {
  const styles = useThemedStyles(makeStyles);
  const [tab, setTab] = useState<AdminTab>("growth");
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);

  return (
    <>
      <View style={styles.sectionHead}>
        <Text variant="paneTitle">Staff console</Text>
        <Text variant="paneSub">
          Platform-wide, across every context. Counts are bucketed by UTC date,
          so a figure is the same figure for everyone looking at it.
        </Text>
      </View>

      <View style={styles.tabs} role="tablist">
        {ADMIN_TABS.map((entry) => (
          <Button
            key={entry.key}
            label={entry.label}
            variant={entry.key === tab ? "white" : "mini"}
            onPress={() => setTab(entry.key)}
            testID={`admin-tab-${entry.key}`}
          />
        ))}
      </View>

      {tab === "growth" ? <GrowthSection days={days} onDays={setDays} /> : null}
      {tab === "estate" ? <EstateSection days={days} /> : null}
      {tab === "activity" ? (
        <ActivitySection days={days} onDays={setDays} />
      ) : null}
      {tab === "credentials" ? <SecretsSection /> : null}
    </>
  );
}

function WindowPicker({
  days,
  onDays,
}: {
  days: number;
  onDays: (days: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.tabs}>
      {WINDOW_CHOICES.map((choice) => (
        <Button
          key={choice}
          label={`${choice} days`}
          variant={choice === days ? "white" : "mini"}
          onPress={() => onDays(choice)}
          testID={`admin-window-${choice}`}
        />
      ))}
    </View>
  );
}

/**
 * The one sentence that has to appear when the census stopped counting.
 *
 * Every figure below it is then a floor, and the trend curves are **withheld
 * rather than drawn**, because a cumulative line missing an arbitrary slice of
 * its rows is not a less precise chart — it is a different and wrong shape.
 * Same rule the storage card follows for a note count it could not finish.
 */
function TruncatedNotice({ truncated }: { truncated: boolean }) {
  if (!truncated) return null;
  return (
    <Notice tone="warn" testID="admin-census-truncated">
      <Text variant="rowSub">
        More rows than one census page holds. Every figure here is a floor, and
        the growth curves are not drawn — a curve missing part of its rows is
        the wrong shape, not a rough one. This is the point to replace counting
        with maintained totals.
      </Text>
    </Notice>
  );
}

// -- growth ---------------------------------------------------------------

function GrowthSection({
  days,
  onDays,
}: {
  days: number;
  onDays: (days: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const census = useQuery(api.functions.admin.censusReport, { days });
  const usage = useQuery(api.functions.admin.usageReport, { days });

  const funnel = useMemo(
    () => (census ? funnelRows(census.funnel) : []),
    [census],
  );
  const kinds = useMemo(
    () =>
      census
        ? compositionOf([
            {
              key: "personal",
              label: "Personal",
              count: census.contexts.personal,
              tone: "accent" as const,
            },
            {
              key: "shared",
              label: "Shared",
              count: census.contexts.shared,
              tone: "shared" as const,
            },
          ])
        : [],
    [census],
  );

  if (census === undefined) return <Loading />;

  const activeToday =
    usage?.activeContexts.points[usage.activeContexts.points.length - 1]?.count ??
    null;

  return (
    <View style={styles.section}>
      <WindowPicker days={days} onDays={onDays} />
      <TruncatedNotice truncated={census.truncated} />

      <View style={styles.tiles}>
        <StatTile
          emphasis
          label="Accounts"
          value={formatTotal(census.accounts.total)}
          caption={periodCaption(
            census.accounts.newInWindow,
            census.accounts.newInPriorWindow,
          )}
          testID="admin-stat-accounts"
        />
        <StatTile
          emphasis
          label="Contexts"
          value={formatTotal(census.contexts.total)}
          caption={`${formatRatio(census.contexts.perAccount)} per account · ${periodCaption(
            census.contexts.newInWindow,
            census.contexts.newInPriorWindow,
          )}`}
          testID="admin-stat-contexts"
        />
        <StatTile
          emphasis
          label="Paying contexts"
          value={formatCount(census.plans.paying)}
          tone={census.plans.paying > 0 ? "ok" : undefined}
          caption={`${formatMoney(census.plans.mrrCents)} a month`}
          testID="admin-stat-paying"
        />
        <StatTile
          emphasis
          label="Active contexts"
          value={
            usage === undefined
              ? "…"
              : formatCount(usage.activeContexts.distinctInWindow)
          }
          caption={
            activeToday === null
              ? `in the last ${days} days`
              : `${formatCount(activeToday)} today`
          }
          testID="admin-stat-active"
        />
      </View>

      {/* Withheld rather than drawn from a partial page. See
          `TruncatedNotice` — this is the other half of that rule. */}
      {census.truncated ? null : (
        <View style={styles.tiles}>
          <Card style={styles.panel} testID="admin-curve-accounts">
            <Text variant="eyebrow">Accounts over time</Text>
            <GrowthCurve
              cumulative={census.accounts.cumulative}
              added={census.accounts.added}
            />
            <Text variant="meta">
              {formatSigned(census.accounts.newInWindow)} in this window. Solid
              columns are days somebody arrived.
            </Text>
          </Card>
          <Card style={styles.panel} testID="admin-curve-contexts">
            <Text variant="eyebrow">Contexts over time</Text>
            <GrowthCurve
              cumulative={census.contexts.cumulative}
              added={census.contexts.added}
              tone="shared"
            />
            <Text variant="meta">
              {formatSigned(census.contexts.newInWindow)} in this window.{" "}
              {census.contexts.membersPerShared === null
                ? "No shared contexts yet."
                : `${formatRatio(census.contexts.membersPerShared)} members per shared context.`}
            </Text>
          </Card>
        </View>
      )}

      <Card style={styles.panel} testID="admin-funnel">
        <Text variant="eyebrow">How far accounts get</Text>
        <Text variant="paneSub">
          Thresholds, not a nested funnel: a step can be larger than the one
          above it, and when it is — a client connected to a context whose
          bucket never verified — that is the customer to go and talk to.
        </Text>
        <FunnelChart rows={funnel} />
      </Card>

      <Card style={styles.panel} testID="admin-kinds">
        <Text variant="eyebrow">Personal and shared</Text>
        <CompositionBar segments={kinds} empty="No contexts yet." />
      </Card>

      <RosterCard roster={census.roster} />
    </View>
  );
}

/**
 * Who is here, newest first.
 *
 * **A roster is the honest dashboard at this size**, and it is control-plane
 * metadata only — an address, when they arrived, how many contexts, whether
 * storage verified, how many clients, what they pay. Nothing about what they
 * wrote: `functions/admin.ts` carries the standing rule, and this card is the
 * thing most likely to tempt somebody to break it. Do not add a column that
 * names a note, a folder, or a search.
 */
function RosterCard({
  roster,
}: {
  roster: readonly {
    joinedAt: number;
    email?: string;
    contexts: number;
    owned: number;
    connectedStorage: number;
    clients: number;
    plan: string;
    lastSeenAt: number | null;
  }[];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.panel} testID="admin-roster">
      <Text variant="eyebrow">Accounts, newest first</Text>
      {roster.length === 0 ? (
        <Text variant="paneSub">Nobody has signed up yet.</Text>
      ) : (
        <View>
          {roster.map((row) => (
            <View key={`${row.email ?? "anon"}-${row.joinedAt}`} style={styles.rosterRow}>
              <View style={styles.rosterWho}>
                <Text variant="rowTitle">{row.email ?? "no address"}</Text>
                <Text variant="meta">
                  joined {relativeTime(row.joinedAt)} · last seen{" "}
                  {formatLastUsed(row.lastSeenAt)}
                </Text>
              </View>
              <View style={styles.rosterFacts}>
                <Pill tone={row.contexts > 0 ? "neutral" : "warn"}>
                  {formatCount(row.contexts)}{" "}
                  {row.contexts === 1 ? "context" : "contexts"}
                </Pill>
                <Pill
                  tone={row.connectedStorage > 0 ? "ok" : "warn"}
                  // Dashed for the one that was never attempted, so "no bucket
                  // yet" does not read as "a bucket that failed".
                  dashed={row.owned > 0 && row.connectedStorage === 0}
                >
                  {formatCount(row.connectedStorage)} storage
                </Pill>
                <Pill tone={row.clients > 0 ? "ok" : "warn"}>
                  {formatCount(row.clients)}{" "}
                  {row.clients === 1 ? "client" : "clients"}
                </Pill>
                <Pill tone={planTone(row.plan)}>{planLabel(row.plan)}</Pill>
              </View>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

// -- the estate -----------------------------------------------------------

function EstateSection({ days }: { days: number }) {
  const styles = useThemedStyles(makeStyles);
  const census = useQuery(api.functions.admin.censusReport, { days });

  const storage = useMemo(
    () =>
      census
        ? compositionOf([
            {
              key: "managed",
              label: "Managed by us",
              count: census.storage.managed,
              tone: "accent" as const,
            },
            {
              key: "customer",
              label: "Customer's own bucket",
              count: census.storage.customer,
              tone: "ok" as const,
            },
            {
              key: "unbound",
              label: "No bucket yet",
              count: census.storage.unbound,
              tone: "warn" as const,
            },
          ])
        : [],
    [census],
  );

  const plans = useMemo(
    () =>
      census
        ? compositionOf([
            {
              key: "active",
              label: "Paying",
              count: census.plans.paying,
              tone: "ok" as const,
            },
            {
              key: "past_due",
              label: "Past due",
              count: census.plans.pastDue,
              tone: "crit" as const,
            },
            {
              key: "canceled",
              label: "Cancelled",
              count: census.plans.canceled,
              tone: "warn" as const,
            },
            {
              key: "free",
              label: "Free",
              count: census.plans.free,
              tone: "muted" as const,
            },
          ])
        : [],
    [census],
  );

  if (census === undefined) return <Loading />;

  return (
    <View style={styles.section}>
      <TruncatedNotice truncated={census.truncated} />

      <Card style={styles.panel} testID="admin-storage">
        <Text variant="eyebrow">Storage — how much do we hold</Text>
        <Text variant="paneSub">
          A bucket counts as ours only when its whole name is the one we derive
          from the context's id. A customer's own bucket that happens to start
          with our prefix is theirs.
        </Text>
        <CompositionBar segments={storage} empty="No contexts yet." />
        <View style={styles.chips}>
          {census.storage.byStatus.map((entry) => (
            <Pill key={entry.status} tone={bindingStatusTone(entry.status)}>
              {bindingStatusLabel(entry.status)} {formatCount(entry.count)}
            </Pill>
          ))}
          {census.storage.byStatus.length === 0 ? (
            <Text variant="meta">No bindings yet.</Text>
          ) : null}
        </View>
        <View style={styles.rows}>
          {census.storage.byProvider.map((entry) => (
            <FactRow
              key={entry.provider}
              label={providerLabel(entry.provider)}
              sub={`${formatCount(entry.managed)} ours · ${formatCount(entry.customer)} theirs`}
              value={formatCount(entry.managed + entry.customer)}
              testID={`admin-provider-${entry.provider}`}
            />
          ))}
        </View>
      </Card>

      <Card style={styles.panel} testID="admin-plans">
        <Text variant="eyebrow">Subscriptions</Text>
        <View style={styles.tiles}>
          <StatTile
            label="Monthly recurring"
            value={formatMoney(census.plans.mrrCents)}
            tone={census.plans.mrrCents > 0 ? "ok" : undefined}
            caption={`${formatCount(census.plans.paying)} paying, at the one price`}
            testID="admin-stat-mrr"
          />
          <StatTile
            label="Serving managed storage"
            value={formatCount(census.plans.servingManagedStorage)}
            caption="selected and paid for"
          />
          <StatTile
            label="Serving fast search"
            value={formatCount(census.plans.servingFastSearch)}
            caption="selected and paid for"
          />
        </View>
        <CompositionBar segments={plans} empty="No contexts yet." />
        {census.plans.provisioningRunning + census.plans.provisioningFailed >
        0 ? (
          <Notice
            tone={census.plans.provisioningFailed > 0 ? "warn" : "neutral"}
            testID="admin-provisioning"
          >
            <Text variant="rowSub">
              {formatCount(census.plans.provisioningRunning)} managed bucket
              {census.plans.provisioningRunning === 1 ? "" : "s"} being created,{" "}
              {formatCount(census.plans.provisioningFailed)} failed. A failure
              is somebody who has paid and has nothing yet.
            </Text>
          </Notice>
        ) : null}
        {census.plans.unresolved > 0 ? (
          <Text variant="meta">
            {formatCount(census.plans.unresolved)} with a subscription status
            this build does not recognise. Those serve nothing.
          </Text>
        ) : null}
      </Card>

      <Card style={styles.panel} testID="admin-clients">
        <Text variant="eyebrow">Connected clients</Text>
        <Text variant="paneSub">
          One row per OAuth client holding a live grant. Names are what the
          client called itself at registration, which is unauthenticated — treat
          them as a label, not an identity.
        </Text>
        {census.clients.length === 0 ? (
          <Text variant="paneSub">Nothing is connected yet.</Text>
        ) : (
          <View style={styles.rows}>
            {census.clients.map((client) => (
              <FactRow
                key={client.clientId}
                label={client.clientName}
                sub={`${formatCount(client.contexts)} contexts · ${formatCount(
                  client.accounts,
                )} accounts · last used ${formatLastUsed(client.lastUsedAt)}${
                  client.revoked > 0
                    ? ` · ${formatCount(client.revoked)} revoked`
                    : ""
                }`}
                value={formatCount(client.active)}
                testID={`admin-client-${client.clientId}`}
              />
            ))}
          </View>
        )}
      </Card>

      <Card style={styles.panel} testID="admin-sources">
        <Text variant="eyebrow">Other capture sources</Text>
        <View style={styles.rows}>
          <FactRow
            label="Google accounts"
            sub={`${formatCount(census.sources.gmail)} mail · ${formatCount(
              census.sources.calendar,
            )} calendar · ${formatCount(census.sources.chat)} chat`}
            value={formatCount(census.sources.googleAccounts)}
            testID="admin-source-google"
          />
          <FactRow
            label="Dropbox as storage"
            sub="a folder rather than a bucket"
            value={formatCount(census.sources.dropbox)}
            testID="admin-source-dropbox"
          />
          <FactRow
            label="Mail capture"
            sub={`${formatCount(census.sources.mailAllowlisted)} allowlisted · ${formatCount(
              census.sources.mailOpen,
            )} open to anyone`}
            value={formatCount(
              census.sources.mailAllowlisted + census.sources.mailOpen,
            )}
            chip={census.sources.mailOpen > 0 ? "open inbox" : undefined}
            chipTone="warn"
            testID="admin-source-mail"
          />
          <FactRow
            label="Obsidian plugins"
            sub="contexts with a live plugin grant"
            value={formatCount(census.sources.obsidian)}
            testID="admin-source-obsidian"
          />
        </View>
      </Card>
    </View>
  );
}

// -- activity -------------------------------------------------------------

/**
 * The event counters.
 *
 * These keep their day-over-day percentage: unlike accounts and contexts, tool
 * calls and searches run to hundreds a day, which is a denominator big enough
 * for a ratio to carry something.
 *
 * The two all-time totals that used to sit here are gone. They are the
 * census's to report now, and one number arriving on one page from two
 * different reads — with two different ceilings — is how a dashboard starts
 * disagreeing with itself.
 */
function ActivitySection({
  days,
  onDays,
}: {
  days: number;
  onDays: (days: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.admin.usageReport, { days });

  const series = useMemo(
    () => (report ? orderSeries(report.series) : []),
    [report],
  );

  if (report === undefined) return <Loading />;

  return (
    <View style={styles.section}>
      <WindowPicker days={days} onDays={onDays} />

      <Card style={styles.panel} testID="admin-active">
        <Text variant="eyebrow">Contexts seen, day by day</Text>
        <Text variant="statValue">
          {formatCount(report.activeContexts.distinctInWindow)}
        </Text>
        <TrendBars points={report.activeContexts.points} />
        <Text variant="meta">
          Distinct contexts reached over the last {report.days} days. A
          cardinality, never a sum — the same context on two days is one
          context.
        </Text>
      </Card>

      <View style={styles.tiles}>
        {series.map((entry) => (
          <StatTile
            key={entry.metric}
            label={metricLabel(entry.metric)}
            value={formatCount(entry.total)}
            caption={`${formatDelta(dayOverDay(entry.points))} vs yesterday`}
            testID={`admin-metric-${entry.metric}`}
          >
            <TrendBars points={entry.points} peak={false} />
          </StatTile>
        ))}
      </View>
    </View>
  );
}

// -- secrets --------------------------------------------------------------

/**
 * A secret is written here and never read back.
 *
 * There is no "reveal" control and no place to put one: `listSecrets` returns
 * a fingerprint and the control plane has no function that returns a value at
 * all. What this offers is "set it" and "replace it", and the fingerprint is
 * how somebody confirms the paste landed — see `functions/lib/appSecrets.ts`
 * for why it is a hash rather than the last four characters.
 */
function SecretsSection() {
  const styles = useThemedStyles(makeStyles);
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const setSecret = useAction(api.functions.admin.setSecret);
  const deleteSecret = useMutation(api.functions.admin.deleteSecret);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const unset = useMemo(() => unsetKnownSecrets(secrets ?? []), [secrets]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await setSecret({
        name,
        value,
        description: description.length > 0 ? description : undefined,
      });
      // The value is cleared on success and never re-rendered. A form that
      // keeps a credential in component state after the write is a credential
      // sitting in a browser tab for as long as the tab is open.
      setValue("");
      setDescription("");
      setName("");
      setSaved(`${result.name} set — fingerprint ${result.fingerprint}`);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="paneTitle">Integration credentials</Text>
        <Text variant="paneSub">
          Encrypted at rest and never shown again. The fingerprint is a hash, not
          part of the value — check it against the credential you meant to paste.
        </Text>
      </View>

      <Card style={styles.form}>
        <TextField
          label="Name"
          value={name}
          onChangeText={setName}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="SEARCH_D1_API_TOKEN"
          hint="Uppercase, digits and underscore. The name the code reads."
          testID="admin-secret-name"
        />
        <TextField
          label="Value"
          value={value}
          onChangeText={setValue}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          hint="Written once. There is no way to read it back from here."
          testID="admin-secret-value"
        />
        <TextField
          label="What it is for"
          value={description}
          onChangeText={setDescription}
          optional
          autoCapitalize="sentences"
          testID="admin-secret-description"
        />
        {error ? (
          <Text variant="error" testID="admin-secret-error">
            {error}
          </Text>
        ) : null}
        {saved ? (
          <Text variant="check" testID="admin-secret-saved">
            {saved}
          </Text>
        ) : null}
        <Button
          label={busy ? "Saving…" : "Set credential"}
          variant="white"
          disabled={busy || name.trim().length === 0 || value.length === 0}
          onPress={save}
          testID="admin-secret-save"
        />
      </Card>

      {secrets === undefined ? (
        <Loading />
      ) : (
        <View style={styles.rows}>
          {secrets.map((row) => (
            <Card key={row.name} style={styles.row}>
              <View style={styles.rowHead}>
                <Text variant="rowTitle">{row.name}</Text>
                <Text variant="mono">{row.fingerprint}</Text>
              </View>
              {row.description ? (
                <Text variant="rowSub">{row.description}</Text>
              ) : null}
              <Text variant="meta">
                set {relativeTime(row.updatedAt)}
                {row.updatedByEmail ? ` by ${row.updatedByEmail}` : ""}
              </Text>
              <Button
                label="Delete"
                variant="danger"
                onPress={() => {
                  void deleteSecret({ name: row.name }).catch((caught) =>
                    setError(messageFor(caught)),
                  );
                }}
                testID={`admin-secret-delete-${row.name}`}
              />
            </Card>
          ))}
          {secrets.length === 0 ? (
            <Text variant="paneSub">Nothing is configured yet.</Text>
          ) : null}
        </View>
      )}

      {unset.length > 0 ? (
        <View style={styles.rows}>
          <Text variant="eyebrow">Not set</Text>
          {unset.map((known) => (
            <Card key={known.name} style={styles.row}>
              <Text variant="rowTitle">{known.name}</Text>
              <Text variant="rowSub">{known.description}</Text>
              {/* What is actually broken while this is missing, rather than a
                  neutral "unset" — the difference between a checklist and a
                  page somebody can act on. */}
              <Text variant="meta">{known.unsetMeans}</Text>
              <Button
                label="Set this one"
                onPress={() => setName(known.name)}
                testID={`admin-secret-pick-${known.name}`}
              />
            </Card>
          ))}
        </View>
      ) : null}

      <Text variant="foot">
        {KNOWN_SECRETS.length} integrations are known to the code. Any other name
        is accepted too — except the keys this deployment needs before it can
        read this table at all, which stay in the environment and are refused
        here.
      </Text>
    </View>
  );
}

/**
 * The message from a `ConvexError`, or a flat sentence.
 *
 * Never `String(error)`: a raw error can carry a stack and, from a failed
 * action, the arguments it was called with — which on this screen is a
 * credential.
 */
function messageFor(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (data !== null && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "That did not work. Check the name and try again.";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scroll: { flex: 1, backgroundColor: colors.ground },
    content: { padding: space.x6, gap: space.x6, maxWidth: 1100, width: "100%" },
    section: { gap: space.x5 },
    sectionHead: { gap: space.x2 },
    tabs: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x4 },
    panel: { flexGrow: 1, flexBasis: 320, gap: space.x3, padding: space.x5 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    rows: { gap: space.x1 },
    row: { gap: space.x2, padding: space.x5 },
    rowHead: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: space.x3,
    },
    rosterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x3,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    rosterWho: { flex: 1, gap: 2, minWidth: 180 },
    rosterFacts: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    form: { gap: space.x4, padding: space.x5 },
  });

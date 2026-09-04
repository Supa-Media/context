/**
 * `/admin` — the staff console.
 *
 * Two things live here: what the product is doing, and the integration
 * credentials it runs on. Both are platform-wide rather than about any one
 * context, which is why this is a route of its own rather than a pane in the
 * console rail.
 *
 * ## The screen is not the authorization
 *
 * `amIAdmin` decides what to *render*. It decides nothing else: `usageReport`,
 * `listSecrets`, `setSecret` and `deleteSecret` each call `requireAdmin`
 * server-side, so a client that forces the boolean gets a page whose every
 * query throws. That is the arrangement to keep — a screen that is the only
 * thing standing between somebody and a credential store is not a security
 * boundary, it is a suggestion.
 *
 * The corollary is that the admin queries are **skipped**, not merely hidden,
 * for a non-admin: they throw for that caller, and `useQuery` re-throws a
 * failed query during render, so subscribing and ignoring the result would
 * crash the app rather than show an empty page.
 *
 * ## A secret is written here and never read back
 *
 * There is no "reveal" control and no place to put one: `listSecrets` returns
 * a fingerprint and the control plane has no function that returns a value at
 * all. What this screen offers is "set it" and "replace it", and the
 * fingerprint is how somebody confirms the paste landed — see
 * `functions/lib/appSecrets.ts` for why it is a hash rather than the last four
 * characters.
 */

import { useMemo, useState } from "react";
import { View, StyleSheet } from "react-native";
import { ScreenScroll } from "../app/Screen";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import {
  Button,
  Card,
  Text,
  TextField,
  useColors,
  useThemedStyles,
  radii,
  space,
  type Colors,
} from "../design";
import {
  KNOWN_SECRETS,
  barHeights,
  dayOverDay,
  formatCount,
  formatDelta,
  metricLabel,
  orderSeries,
  relativeTime,
  shortDay,
  unsetKnownSecrets,
} from "./report";

const REPORT_DAYS = 30;

export function AdminPane() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});

  // Undefined until the first round trip lands, which is not the same as
  // `false`. Rendering the refusal while it is unresolved would flash "not
  // found" at an admin on every cold load.
  if (isAdmin === undefined) return <AdminChrome><Loading /></AdminChrome>;
  if (!isAdmin) return <AdminChrome><NotFound /></AdminChrome>;
  return (
    <AdminChrome>
      <UsageSection />
      <SecretsSection />
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

// -- usage ----------------------------------------------------------------

function UsageSection() {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.admin.usageReport, { days: REPORT_DAYS });

  const series = useMemo(
    () => (report ? orderSeries(report.series) : []),
    [report],
  );

  if (report === undefined) return <Loading />;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="paneTitle">Usage</Text>
        <Text variant="paneSub">
          The last {report.days} days, bucketed by UTC date — so a figure is the
          same figure for everyone looking at it.
        </Text>
      </View>

      <View style={styles.tiles}>
        <StatTile
          label="Active contexts"
          value={formatCount(report.activeContexts.distinctInWindow)}
          caption={`${formatCount(
            report.activeContexts.points[report.activeContexts.points.length - 1]
              ?.count ?? 0,
          )} today`}
          points={report.activeContexts.points}
        />
        <StatTile
          label="Contexts"
          value={formatCount(report.totals.workspaces)}
          caption="all time"
        />
        <StatTile
          label="Accounts"
          value={formatCount(report.totals.users)}
          caption="all time"
        />
      </View>

      <View style={styles.tiles}>
        {series.map((entry) => (
          <StatTile
            key={entry.metric}
            label={metricLabel(entry.metric)}
            value={formatCount(entry.total)}
            caption={`${formatDelta(dayOverDay(entry.points))} vs yesterday`}
            points={entry.points}
          />
        ))}
      </View>
    </View>
  );
}

function StatTile({
  label,
  value,
  caption,
  points,
}: {
  label: string;
  value: string;
  caption: string;
  points?: readonly { day: string; count: number }[];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Card style={styles.tile}>
      <Text variant="statLabel">{label}</Text>
      <Text variant="statValue">{value}</Text>
      {points ? <Sparkline points={points} /> : null}
      <Text variant="meta">{caption}</Text>
    </Card>
  );
}

/**
 * A bar per day, scaled to this series' own maximum.
 *
 * Views rather than a chart library: the app has no charting dependency and
 * thirty flex children is not a reason to acquire one. Scaling is per series
 * — see `barHeights` for why a shared scale would draw most of these as a flat
 * line at zero.
 */
function Sparkline({ points }: { points: readonly { day: string; count: number }[] }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const heights = barHeights(points);
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <View>
      <View
        style={styles.spark}
        accessibilityLabel={`${points.length} days, ending ${
          last ? formatCount(last.count) : 0
        } on the last day`}
      >
        {heights.map((height, index) => (
          <View
            key={points[index].day}
            style={[
              styles.sparkBar,
              {
                // A zero day still draws a hairline, so the axis reads as a
                // row of days with nothing in some of them rather than as a
                // chart that stops.
                height: `${Math.max(height * 100, 2)}%`,
                backgroundColor: height > 0 ? colors.accent : colors.line,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.sparkAxis}>
        <Text variant="meta">{first ? shortDay(first.day) : ""}</Text>
        <Text variant="meta">{last ? shortDay(last.day) : ""}</Text>
      </View>
    </View>
  );
}

// -- secrets --------------------------------------------------------------

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
    content: { padding: space.x6, gap: space.x8, maxWidth: 1100, width: "100%" },
    section: { gap: space.x5 },
    sectionHead: { gap: space.x2 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x4 },
    tile: { flexGrow: 1, flexBasis: 200, gap: space.x2, padding: space.x5 },
    spark: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 2,
      height: 48,
      marginTop: space.x2,
    },
    sparkBar: { flex: 1, borderRadius: radii.xs, minHeight: 1 },
    sparkAxis: {
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: space.x1,
    },
    form: { gap: space.x4, padding: space.x5 },
    rows: { gap: space.x3 },
    row: { gap: space.x2, padding: space.x5 },
    rowHead: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: space.x3,
    },
  });

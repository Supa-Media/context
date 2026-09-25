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
 * crash the app rather than show an empty page. Every one of them lives in
 * `Console` or below it, and `Console` is rendered only once the answer is
 * `true`.
 *
 * ## What a non-admin sees, and what anybody sees before the answer
 *
 * A non-admin gets the app's own `DeadLinkScreen` with its default words, so
 * `/admin` is indistinguishable from any address that does not exist. The
 * route is in a public repository and its existence is not a secret, but
 * confirming to a signed-in stranger that their account is the only thing
 * between them and it is an oracle worth not running.
 *
 * Before `amIAdmin` resolves the page is a spinner and nothing else — no
 * title, no tabs, no frame. Drawing the console's chrome while the check is in
 * flight would tell a non-admin what the page is for a round trip, and
 * drawing the refusal would flash "not found" at an admin on every cold load.
 *
 * ## Why this page is shaped for ten customers rather than ten thousand
 *
 * Four claims about a product with single-digit customers, each of which the
 * layout makes rather than states:
 *
 *  1. **Absolute change, not percentages**, for accounts and contexts. A
 *     ratio needs a denominator big enough to carry information.
 *  2. **Composition before count.** Managed against customer-owned storage,
 *     personal against shared, paying against free.
 *  3. **A funnel, a nudge list and a roster, because at this size the answer
 *     is a person.**
 *  4. **Four tabs, because there are four errands.** Growth, estate,
 *     activity, credentials.
 *
 * The arithmetic is in `./report` and `./growth`, the shapes in `./Charts`
 * and `./GrowthArea`, each tab in its own module, and the furniture they
 * share in `./AdminKit`.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { DeadLinkScreen } from "../app/DeadLinkScreen";
import { ScreenScroll } from "../app/Screen";
import { space, useColors, useThemedStyles, type Colors } from "../design";
import { ActivitySection } from "./ActivitySection";
import { useCompact } from "./AdminKit";
import { ConsoleHeader } from "./ConsoleHeader";
import { EstateSection } from "./EstateSection";
import { GrowthSection } from "./GrowthSection";
import { DEFAULT_WINDOW, unsetKnownSecrets, type AdminTab } from "./report";
import { SecretsSection } from "./SecretsSection";

export function AdminPane() {
  const isAdmin = useQuery(api.functions.admin.amIAdmin, {});

  // Undefined until the first round trip lands, which is not the same as
  // `false`. See the header for why this names nothing.
  if (isAdmin === undefined) return <AuthPending />;
  if (!isAdmin) return <DeadLinkScreen />;
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
 * the route paints once the admin check has passed.
 *
 * `ScreenScroll` rather than a bare `ScrollView`: it owns the safe-area
 * padding, and a page outside the console frame has nothing else supplying
 * it. The column's vertical spacing is on an inner view rather than on the
 * content container, whose top and bottom padding are the safe area's.
 */
export function AdminChrome({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  return (
    <ScreenScroll
      style={styles.scroll}
      testID="admin-pane"
    >
      <View style={[styles.column, compact && styles.columnCompact]}>{children}</View>
    </ScreenScroll>
  );
}

/** A spinner, alone. Nothing here may say what the page is. */
function AuthPending() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.pending} aria-busy>
      <ActivityIndicator color={colors.muted} />
    </View>
  );
}

/**
 * The tabs, and the state they share.
 *
 * The window lives here rather than inside a tab so that switching from
 * Growth to Activity keeps the period somebody chose. `listSecrets` lives
 * here too, once, so the Credentials tab can carry its count of known names
 * not yet set from every tab — it is admin-gated like everything else here,
 * and this component only renders for an admin.
 */
function Console() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const [tab, setTab] = useState<AdminTab>("growth");
  const [days, setDays] = useState<number>(DEFAULT_WINDOW);
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const unset = useMemo(() => unsetKnownSecrets(secrets ?? []), [secrets]);
  // Zero until the list lands, rather than every known name at once.
  const unsetCount = secrets === undefined ? 0 : unset.length;

  return (
    <>
      <ConsoleHeader
        tab={tab}
        onTab={setTab}
        days={days}
        onDays={setDays}
        unsetCount={unsetCount}
      />
      <View style={compact ? styles.bodyCompact : styles.body}>
        {tab === "growth" ? (
          <GrowthSection
            days={days}
            unsetCount={unsetCount}
            onCredentials={() => setTab("credentials")}
          />
        ) : null}
        {tab === "estate" ? <EstateSection days={days} /> : null}
        {tab === "activity" ? <ActivitySection days={days} /> : null}
        {tab === "credentials" ? <SecretsSection secrets={secrets} unset={unset} /> : null}
      </View>
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scroll: { flex: 1, backgroundColor: colors.ground },
    column: {
      width: "100%",
      maxWidth: 1040,
      alignSelf: "center",
      paddingHorizontal: space.x8,
      paddingTop: 36,
      paddingBottom: 72,
    },
    columnCompact: { paddingHorizontal: space.x4, paddingTop: space.x5, paddingBottom: 48 },
    body: { marginTop: space.x6 },
    bodyCompact: { marginTop: space.x4 },
    pending: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.ground,
    },
  });

import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useConvex } from "convex/react";
import type { CheckoutOutcome } from "@context/shared";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Card, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import {
  FormError,
  Notice,
  ToggleGroup,
} from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { leaveTo } from "../../../consent/leave";
import { selectedContext, type ConsoleData } from "../../types";
import { settingsSectionLabel } from "../sections";
import {
  CHECKOUT_SETTLING_SLOW_MS,
  EXPORT_PROMISE,
  checkoutReturnCopy,
  demoPremiumView,
  describePremium,
  describeSessionFailure,
  entitlementRows,
  entitlementsHint,
  formatPrice,
  managedMigrationCopy,
  premiumControl,
  premiumPill,
  premiumStateOf,
  renewalLine,
  unreadablePremiumView,
  usageLine,
  type PremiumEntitlements,
  type PremiumView,
} from "./premium";
import { usePremium } from "./usePremium";
import { useArming } from "../../useArming";

/**
 * Premium, in a context's settings.
 *
 * ## What this screen is allowed to say about leaving
 *
 * One sentence, in every state, unqualified: taking your notes with you is
 * free, on both plans, and keeps working after a cancellation
 * (`CLAUDE.md`, non-negotiable #1). It is a constant rather than something
 * computed — see `EXPORT_PROMISE` — and it is drawn in the same place whether
 * this context is paying or not. **Nothing here may gate, dim, defer or upsell
 * it.** That is the one change to this file that would look like a feature and
 * be a different product.
 *
 * It is stated as a promise rather than offered as a button because the export
 * and hand-off path is not built yet (`docs/decisions/storage-and-credentials.md`
 * says so in its own last paragraph). A button that did nothing would be worse
 * than a sentence that is true.
 *
 * ## Per context, not per person
 *
 * The subscription hangs off this brain or workspace. That is the first thing
 * the section says, because it is the thing somebody is most likely to get
 * wrong: they will assume upgrading their account upgrades everything they can
 * reach, and it does not.
 *
 * ## Absent rather than disabled
 *
 * Every control comes from `usePremium`, which attaches the mutations only
 * where the server said `canManage`. A member sees the plan and no buttons,
 * and the landing page's demo console sees the same section with nothing
 * behind it — neither is offered a control whose only outcome is a permission
 * error. `premiumControl` is the single place that decides.
 */
export function PremiumPanel({
  data,
  /** Absent is the old one-scroll settings pane; present is the overlay. */
  section,
  /**
   * What the return from Stripe said, handed down from the route.
   *
   * Read where the URL is already read rather than here. A leaf that imports
   * `expo-router` needs a router mocked wherever it is mounted, and this one is
   * mounted in six suites that have no business knowing about navigation —
   * which is exactly what happened when it read the parameter itself.
   */
  returned = null,
}: {
  data: ConsoleData;
  section?: string;
  returned?: CheckoutOutcome | null;
}) {
  /*
    `useConvex` returns `undefined` rather than throwing when there is no
    provider in the tree; `useQueries` throws. So the question is asked here,
    once, and the subscribing half is a separate component that is simply not
    rendered when there is nothing to subscribe to — a conditional *component*,
    never a conditional hook.

    Three callers reach this with no client: the landing page's demo console,
    which has no control plane at all; a render harness; and, in principle, a
    browser mid-boot. The first gets a fixture of the free plan, the other two
    get "could not be read just now" — and all three still get the export
    promise, because that sentence is not conditional on anything.
  */
  const client = useConvex();
  const current = selectedContext(data);
  const workspaceId =
    data.demo || client === undefined ? null : (current?.id ?? null);
  if (workspaceId === null) {
    return (
      <PremiumBody
        view={data.demo ? demoPremiumView() : unreadablePremiumView()}
        section={section}
        returned={returned}
      />
    );
  }
  return (
    <PremiumLive
      workspaceId={workspaceId}
      section={section}
      returned={returned}
    />
  );
}

/** The half that subscribes. Rendered only where there is a client to do it. */
function PremiumLive({
  workspaceId,
  section,
  returned,
}: {
  workspaceId: string;
  section?: string;
  returned: CheckoutOutcome | null;
}) {
  const view = usePremium({ workspaceId: workspaceId as Id<"workspaces"> });
  return <PremiumBody view={view} section={section} returned={returned} />;
}

/**
 * The section with its data already resolved.
 *
 * Split out so the whole screen can be driven from fixtures — every state, and
 * the states a live console cannot easily be put into — without a Convex
 * provider. `PremiumPanel` is then two lines: read, render.
 */
export function PremiumBody({
  view,
  section,
  returned = null,
  /** Test seam: the settling copy's later wording, without waiting for it. */
  slowAfter = CHECKOUT_SETTLING_SLOW_MS,
}: {
  view: PremiumView;
  section?: string;
  /** What the return from Stripe said, or `null` for an ordinary visit. */
  returned?: CheckoutOutcome | null;
  slowAfter?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const testCleanup = useArming(async () => {
    if (view.deleteTestWorkspace !== undefined) {
      await view.deleteTestWorkspace();
    }
  });
  /*
    The settling copy changes once, on a timer, and the timer only runs while
    there is something to wait for. Cleared on unmount and never restarted, so
    a section somebody left open for an hour does not keep a handle alive.
  */
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (returned !== "done") return undefined;
    const handle = setTimeout(() => setSlow(true), slowAfter);
    return () => clearTimeout(handle);
  }, [returned, slowAfter]);

  const run = (action: (() => Promise<void>) | undefined) => {
    if (action === undefined) return;
    setWorking(true);
    setFailure(null);
    void action()
      .catch(() =>
        // Our sentence, never the backend's: a Convex error can carry a
        // function path, and a person reading a billing card is owed the next
        // step instead.
        setFailure(
          "That did not go through. Check your connection and try again.",
        ),
      )
      .finally(() => setWorking(false));
  };

  const status = view.status;
  const state = premiumStateOf(status?.status);
  const copy = describePremium(state, status?.canManage ?? true);
  const pill = premiumPill(state, status?.canManage ?? true);
  const control = premiumControl(view);
  const session = view.session;
  const returning = checkoutReturnCopy(returned, state, { slow });
  const migration = status === null ? null : managedMigrationCopy(status);

  const toggle = (value: string, next: boolean) => {
    if (status === undefined || status === null || view.choose === undefined)
      return;
    const chosen: PremiumEntitlements = { ...status.selected };
    if (value === "managedStorage") chosen.managedStorage = next;
    if (value === "fastSearch") chosen.fastSearch = next;
    run(() => view.choose!(chosen));
  };

  return (
    <View>
      <Text
        /*
          In the overlay one block is the whole panel, so its name is the
          panel's title rather than a label separating it from the block above.
          The string comes from the catalogue and never from a literal here —
          the row and its heading drifted apart once already.
        */
        variant={section === undefined ? "eyebrow" : "paneTitle"}
        style={
          section === undefined ? styles.sectionHeadLater : styles.sectionHead
        }
      >
        {settingsSectionLabel("premium")}
      </Text>
      <Text variant="paneSub" style={styles.sectionSub}>
        What this brain or workspace pays for. Premium is per context rather
        than per person, so upgrading this one leaves every other context you
        can reach exactly as it is.
      </Text>

      {/*
        A return that is still settling is drawn *as* the plan, not above it.

        It was a notice over the card first, and looking at it in a browser is
        what killed that: "Payment received — setting up this context" sat
        directly above "This context is on the free plan", two statements about
        somebody's money contradicting each other on one screen. The plan has
        genuinely not changed yet — the webhook decides that — so the honest
        move is to stop asserting the old state while we are telling them the
        new one is coming, rather than to assert both.

        A *cancelled* return is a notice, because "no payment was taken" and
        "you are on the free plan" agree with each other.
      */}
      {returning === null || returning.working ? (
        <></>
      ) : (
        <Notice
          tone={returning.tone}
          style={styles.notice}
          testID="premium-checkout-return"
        >
          <View style={styles.returnText}>
            <Text variant="rowTitle" role="status">
              {returning.title}
            </Text>
            <Text variant="rowSub" style={styles.blurb}>
              {returning.body}
            </Text>
          </View>
        </Notice>
      )}

      {status === null ? (
        <Card>
          <View style={styles.loadingRow}>
            {view.loading ? <ActivityIndicator size="small" /> : null}
            <Text variant="rowSub">
              {view.loading
                ? "Loading…"
                : "What this context pays for could not be read just now."}
            </Text>
          </View>
        </Card>
      ) : (
        <Card
          testID={
            returning?.working === true ? "premium-checkout-return" : undefined
          }
        >
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text variant="rowTitle" testID="premium-title" role="status">
                {returning?.working === true ? returning.title : copy.title}
              </Text>
              <Text variant="rowSub" style={styles.blurb}>
                {returning?.working === true ? returning.body : copy.blurb}
              </Text>
            </View>
            {returning?.working === true ? (
              <View style={styles.settlingPill}>
                <ActivityIndicator size="small" />
                <Pill tone="neutral">Setting up</Pill>
              </View>
            ) : pill === null ? null : (
              <Pill tone={pill.tone} leading={<Dot tone={pill.tone} />}>
                {pill.label}
              </Pill>
            )}
          </View>

          <Row divided style={styles.priceRow}>
            <Text variant="rowSub">Price</Text>
            <Text variant="rowTitle" testID="premium-price">
              {formatPrice(status)}
            </Text>
          </Row>

          {renewalLine(status) === null ? null : (
            <Hint style={styles.hint}>
              <Text variant="rowSub">{renewalLine(status)}</Text>
            </Hint>
          )}
          {usageLine(status) === null ? null : (
            <Notice style={styles.notice} testID="premium-usage">
              <Text variant="rowSub">{usageLine(status)}</Text>
            </Notice>
          )}
          {migration === null ? null : (
            <Notice
              tone={migration.failed ? "warn" : "neutral"}
              style={styles.notice}
              testID="managed-storage-migration"
            >
              <View style={styles.returnText}>
                <Text variant="rowTitle" role="status">
                  {migration.title}
                </Text>
                <Text variant="rowSub" style={styles.blurb}>
                  {migration.body}
                </Text>
                {migration.failed && view.retryManagedStorage !== undefined ? (
                  <Button
                    label={working ? "Trying again…" : "Try copy again"}
                    variant="mini"
                    disabled={working}
                    onPress={() => run(view.retryManagedStorage)}
                    testID="managed-storage-retry"
                  />
                ) : null}
              </View>
            </Notice>
          )}
        </Card>
      )}

      {status === null ? null : (
        <Card style={styles.card}>
          {view.choose === undefined ? (
            /*
              A member, or the demo. The two entitlements are still worth
              naming — "what does this context get" is not privileged — but
              they are read out rather than offered as switches.
            */
            <View>
              <Text variant="eyebrow">What Premium includes</Text>
              {entitlementRows(status).map((row) => (
                <View key={row.value} style={styles.readOnlyRow}>
                  <View style={styles.readOnlyHead}>
                    <Text variant="rowTitle">{row.label}</Text>
                    {/*
                      A pill saying which it is, rather than a tick-or-warning
                      pair. The first drawing of this used `Check`, whose "off"
                      tone is an exclamation mark — so a free context, which is
                      most of them, was shown two warning glyphs for two things
                      that are simply not switched on. Nothing is wrong on that
                      screen and nothing should look as though it is.
                    */}
                    <Pill tone={row.on ? "ok" : "neutral"}>
                      {row.on ? "Included" : "Not included"}
                    </Pill>
                  </View>
                  <Text variant="rowSub" style={styles.blurb}>
                    {row.detail}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <ToggleGroup
              label="What Premium includes"
              hint={entitlementsHint(status)}
              options={entitlementRows(status)}
              onToggle={toggle}
              disabled={working}
              testID="premium-entitlement"
            />
          )}
        </Card>
      )}

      {failure === null ? (
        <></>
      ) : (
        <FormError headline={failure} style={styles.notice} />
      )}
      {session?.status === "failed" ? (
        <FormError
          headline={describeSessionFailure(session.errorCode)}
          style={styles.notice}
        />
      ) : (
        <></>
      )}

      {control === "none" ? (
        <></>
      ) : control === "choose" ? (
        <Hint style={styles.hint}>
          <Text variant="rowSub">
            Tick managed storage, fast search, or both to continue.
          </Text>
        </Hint>
      ) : session?.status === "ready" && session.url !== undefined ? (
        <Row style={styles.actions}>
          {/*
            Two presses, and the second one is the one that leaves. Minting the
            page needs the payment key, which only a scheduled action may open,
            so the URL arrives a beat after the first press — and a navigation
            that happens on its own, seconds after somebody pressed something
            else, is the kind a browser blocks and a person does not trust.
          */}
          <Button
            label={
              session.kind === "portal"
                ? "Continue to billing"
                : "Continue to Stripe"
            }
            accessibilityLabel="Open the payment page, which is hosted by Stripe"
            variant="decision"
            trailing={<Text variant="rowSub">↗</Text>}
            onPress={() => leaveTo(session.url!)}
            testID="premium-continue"
          />
        </Row>
      ) : (
        <Row style={styles.actions}>
          <Button
            label={
              working || session?.status === "pending"
                ? "Opening…"
                : control === "manage"
                  ? "Manage billing"
                  : status?.isTestAccount === true
                    ? "Activate test Premium"
                    : "Upgrade this context"
            }
            accessibilityLabel={
              control === "manage"
                ? "Open the billing portal, where the card, invoices and cancellation live"
                : status?.isTestAccount === true
                  ? "Activate Premium for this test context without a charge"
                  : "Start a subscription for this context"
            }
            variant={control === "manage" ? "mini" : "decision"}
            disabled={working || session?.status === "pending"}
            onPress={() =>
              run(control === "manage" ? view.manageBilling : view.upgrade)
            }
            testID={control === "manage" ? "premium-manage" : "premium-upgrade"}
          />
        </Row>
      )}

      {/*
        THE EXIT, IN EVERY STATE, WITH NOTHING IN FRONT OF IT.

        Not conditional on the plan, not behind a press, not softer on the free
        plan than on Premium, and never phrased as something Premium adds.
        `EXPORT_PROMISE` takes no arguments precisely so this cannot become a
        function of what somebody is paying — see `CLAUDE.md`, non-negotiable
        #1, and the test that walks every state.
      */}
      <Notice style={styles.notice} testID="premium-export-promise">
        <Text variant="rowSub">{EXPORT_PROMISE}</Text>
      </Notice>

      {view.deleteTestWorkspace !== undefined ? (
        <Card testID="premium-test-cleanup">
          <Row style={styles.actions}>
            <View style={styles.testCleanupCopy}>
              <Text variant="rowTitle">Delete this test context</Text>
              <Text variant="rowSub">
                Removes only this unshared test context and its managed bucket
                and search index. Existing contexts and buckets are untouched.
              </Text>
            </View>
            <Button
              label={
                testCleanup.stage === "working"
                  ? "Deleting…"
                  : testCleanup.stage === "armed"
                    ? "Press again to delete"
                    : "Delete test context"
              }
              accessibilityLabel="Delete this unshared production test context and its managed resources"
              variant="danger"
              disabled={testCleanup.stage === "working"}
              onPress={testCleanup.press}
              testID="premium-delete-test-workspace"
            />
          </Row>
        </Card>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sectionHead: { marginBottom: 6 },
    sectionHeadLater: { marginTop: 28, marginBottom: 6 },
    sectionSub: { marginBottom: 12 },
    card: { marginTop: 12 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    headText: { flex: 1 },
    blurb: { marginTop: 4 },
    priceRow: {
      marginTop: 12,
      justifyContent: "space-between",
      alignItems: "center",
    },
    hint: { marginTop: 12 },
    notice: { marginTop: 12 },
    settlingPill: { flexDirection: "row", alignItems: "center", gap: 8 },
    returnText: { flex: 1, minWidth: 0 },
    readOnlyRow: { marginTop: 14 },
    readOnlyHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    actions: { marginTop: 12, gap: 8 },
    testCleanupCopy: { flex: 1, minWidth: 0, gap: 4 },
    loadingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      // Referenced so a themed palette change is visible here rather than this
      // being a themed stylesheet that uses nothing themed.
      borderColor: colors.line,
    },
  });

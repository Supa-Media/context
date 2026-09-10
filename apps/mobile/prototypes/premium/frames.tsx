import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../features/design/components/Button";
import { Card, Row } from "../../features/design/components/Card";
import { Dot } from "../../features/design/components/Dot";
import { Hint } from "../../features/design/components/Field";
import { FormError, Notice, ToggleGroup } from "../../features/design/components/Input";
import { Pill } from "../../features/design/components/Pill";
import { Text } from "../../features/design/components/Text";
import { leading, space } from "../../features/design/tokens";
import { useThemedStyles, type Colors } from "../../features/design/theme";
import { PremiumBody } from "../../features/console/settings/panels/PremiumPanel";
import {
  EXPORT_PROMISE,
  entitlementRows,
  entitlementsHint,
  formatBytes,
  formatPrice,
  type PremiumStatus,
  type PremiumView,
} from "../../features/console/settings/panels/premium";
import {
  Block,
  ChoiceCard,
  ChoiceRow,
  PointList,
  PriceRow,
  StateBanner,
  StepList,
  hotspot,
} from "./components";
import {
  cancelled,
  ceiling,
  confirm,
  exit,
  firstRunA,
  firstRunB,
  leaving,
  pricing,
  provisionFailed,
  readOnly,
  ready,
  settling,
  switchToManaged,
} from "./copy";

/**
 * The frames a reviewer clicks through, and the evidence each one carries.
 *
 * ## Three kinds, and the difference is not cosmetic
 *
 * - `settings` frames are mounted **inside the real console**, with the real
 *   settings overlay around them, by mocking one module (`PremiumPanel`) in the
 *   shot script. Four of them render the shipping `PremiumBody` against
 *   fixtures, so what is being reviewed there is the product as it is today,
 *   not a drawing of it.
 * - `welcome` frames are mounted inside the real `WelcomeChrome` — the step
 *   rail, the wordmark, the card, the footer — with a proposed step body in
 *   place of `StorageStep`.
 * - `page` frames have no production chrome to sit in yet (a pricing page, and
 *   a banner that belongs above a note list), so they are drawn on the app's
 *   own ground and labelled as such.
 *
 * ## Evidence, on every frame
 *
 * `evidence` is the answer to "which of these buttons actually does something
 * today", and it is attached to the frame rather than written in a document
 * beside it so the two cannot come apart. `built` means it ships now;
 * `backend` means the screen is drawable and the control plane cannot answer
 * it yet; `proposed` means neither half exists and this frame is the proposal.
 * The prototype's own chrome prints these under each frame.
 */

export type EvidenceState = "built" | "backend" | "proposed";

export interface Evidence {
  label: string;
  state: EvidenceState;
}

export interface ProtoFrame {
  id: string;
  title: string;
  group: "Acquisition" | "First run" | "Back from Stripe" | "Settings" | "Lifecycle";
  kind: "welcome" | "settings" | "page";
  /** One line under the frame in the prototype: what this frame is deciding. */
  note: string;
  evidence: ReadonlyArray<Evidence>;
  /**
   * Where this frame goes on its own, with nothing pressed.
   *
   * `settling` and `provisioning` are waits: in the product they advance when a
   * webhook lands or a bucket is made, and there is no control on them because
   * there is nothing for a person to do. A prototype still has to be walkable,
   * so the prototype's *chrome* advances them — clicking anywhere on the frame —
   * and says so above the frame. It is deliberately not a button inside the
   * frame: a button there would be a control this design does not propose.
   */
  next?: string;
  body: () => ReactElement;
}

/* -------------------------------------------------------------------------- *
 * Fixtures.
 *
 * The shapes `billing.status` actually returns, so the shipping panel can be
 * put into states a live console cannot easily be put into. Fake values only —
 * this repository is public, and `hasStripeCustomer` is a boolean here for the
 * same reason it is a boolean on the wire.
 * -------------------------------------------------------------------------- */

const BASE: PremiumStatus = {
  status: "none",
  selected: { managedStorage: false, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 2000,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
};

/** A fixed clock, so the renewal line reads the same on every run. */
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 10) / 1000);

function status(over: Partial<PremiumStatus>): PremiumStatus {
  return { ...BASE, ...over };
}

/** The price as the product renders it, never as a literal in copy. */
const PRICE = formatPrice(BASE);
const CEILING = formatBytes(BASE.ceilingBytes);

/** The context these frames are about. The demo console's own name. */
const CONTEXT = "@seyi's brain";

/** `{price}`, `{context}` and `{ceiling}` filled from the same source as the UI. */
function fill(text: string): string {
  return text
    .replaceAll("{price}", PRICE)
    .replaceAll("{context}", CONTEXT)
    .replaceAll("{ceiling}", CEILING);
}

function view(over: Partial<PremiumStatus>, extra: Partial<PremiumView> = {}): PremiumView {
  return {
    status: status(over),
    loading: false,
    session: null,
    // Present so the shipping panel draws an owner's controls. They are inert:
    // nothing in this folder may reach the control plane.
    choose: async () => {},
    upgrade: async () => {},
    manageBilling: async () => {},
    ...extra,
  };
}

/* -------------------------------------------------------------------------- *
 * The frames.
 * -------------------------------------------------------------------------- */

function Pricing(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.page}>
      <Text variant="eyebrow">{pricing.eyebrow}</Text>
      <Text variant="paneTitle" style={styles.pageTitle}>
        {pricing.title}
      </Text>
      <Text variant="rowSub" style={styles.pageLede}>
        {pricing.lede}
      </Text>

      <View style={styles.planRow}>
        <Card style={styles.plan}>
          <Text variant="rowTitle">{pricing.freeTitle}</Text>
          <PointList points={pricing.freePoints} />
        </Card>
        <Card style={styles.plan}>
          <View style={styles.planHead}>
            <Text variant="rowTitle">{pricing.premiumTitle}</Text>
            <Pill tone="neutral">{fill(pricing.premiumPrice)}</Pill>
          </View>
          <Text variant="rowSub" style={styles.planLede}>
            {pricing.premiumLede}
          </Text>
          <View style={styles.planPoints}>
            {entitlementRows(status({})).map((row) => (
              <View key={row.value} style={styles.planPoint}>
                <Text variant="rowTitle">{row.label}</Text>
                <Text variant="rowSub" style={styles.planPointBody}>
                  {row.detail}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      </View>

      <Hint style={styles.gap}>
        <Text variant="rowSub">{pricing.compare}</Text>
      </Hint>

      <Row style={styles.actions}>
        <Button label={pricing.cta} variant="decision" testID={hotspot("first-run-a")} />
        <Text variant="foot">{pricing.ctaSub}</Text>
      </Row>

      <Notice style={styles.gap} testID="proto-export-promise">
        <Text variant="rowSub">{EXPORT_PROMISE}</Text>
      </Notice>
    </View>
  );
}

function FirstRunA(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {firstRunA.lede}
      </Text>
      <ChoiceRow>
        <ChoiceCard
          title={firstRunA.bucket.title}
          sub={firstRunA.bucket.sub}
          badge={firstRunA.bucket.badge}
          goto={null}
          testID="proto-choose-bucket"
        />
        <ChoiceCard
          title={firstRunA.dropbox.title}
          sub={firstRunA.dropbox.sub}
          goto={null}
          testID="proto-choose-dropbox"
        />
      </ChoiceRow>
      {/*
        The third option is on the same screen and below the two free ones, at
        full width rather than as a third column. Ordering free before paid is
        the honest hierarchy — Dropbox is one click and costs nothing, so a
        screen that sold above it would be selling against its own free tier —
        and full width is what stops "below" reading as "lesser".
      */}
      <View style={styles.managedWrap}>
        <ChoiceCard
          title={firstRunA.managed.title}
          sub={firstRunA.managed.sub}
          badge={fill(firstRunA.managed.badge)}
          badgeTone="neutral"
          wide
          goto="confirm"
          testID="proto-choose-managed"
        />
      </View>
      <View style={styles.actions}>
        <Button label={firstRunA.later} variant="ghost" testID={hotspot(null)} />
      </View>
      <Text variant="foot" style={styles.foot}>
        {firstRunA.laterNote}
      </Text>
    </View>
  );
}

function FirstRunB(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {firstRunB.lede}
      </Text>
      <ChoiceRow>
        <ChoiceCard
          title={firstRunB.haveTitle}
          sub={firstRunB.haveSub}
          goto="first-run-a"
          testID="proto-branch-have"
        />
        <ChoiceCard
          title={firstRunB.needTitle}
          sub={fill(firstRunB.needSub)}
          goto="confirm"
          testID="proto-branch-need"
        />
      </ChoiceRow>
      <View style={styles.actions}>
        <Button label={firstRunB.later} variant="ghost" testID={hotspot(null)} />
      </View>
      <Text variant="foot" style={styles.foot}>
        {/*
          Said here rather than on the cards: variant B's whole claim is that
          one question is easier than three names, and a card that then lists
          the names has given the claim back.
        */}
        Neither answer costs anything to change later. Storage is one setting in
        this context's console.
      </Text>
    </View>
  );
}

function Confirm(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  const chosen = status({ selected: { managedStorage: true, fastSearch: false } });
  return (
    <View>
      <Text variant="rowTitle">{confirm.title}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {confirm.lede}
      </Text>
      <Notice style={styles.gap}>
        <Text variant="rowSub">{fill(confirm.unit)}</Text>
      </Notice>

      <Card style={styles.gap}>
        <ToggleGroup
          label={confirm.includesLabel}
          hint={entitlementsHint(chosen)}
          options={entitlementRows(chosen)}
          onToggle={() => {}}
          testID="proto-confirm-entitlement"
        />
        <PriceRow price={PRICE} note={confirm.renewalNote} />
        <Hint style={styles.gap}>
          <Text variant="rowSub">{fill(ceiling.line)}</Text>
        </Hint>
      </Card>

      <Block title={confirm.whatHappensLabel}>
        <PointList points={confirm.whatHappens} />
      </Block>

      <Row style={styles.actions}>
        <Button
          label={confirm.cta}
          accessibilityLabel="Open the payment page, which is hosted by Stripe"
          variant="decision"
          trailing={<Text variant="rowSub">↗</Text>}
          testID={hotspot("leaving")}
        />
        <Button label={confirm.back} variant="ghost" testID={hotspot("first-run-a")} />
      </Row>
      <Text variant="foot" style={styles.foot}>
        {confirm.ctaSub}
      </Text>

      <Notice style={styles.gap} testID="proto-export-promise">
        <Text variant="rowSub">{EXPORT_PROMISE}</Text>
      </Notice>
    </View>
  );
}

function Leaving(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowTitle">{leaving.ready}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {leaving.readySub}
      </Text>
      <Row style={styles.actions}>
        <Button
          label={leaving.cta}
          accessibilityLabel="Open the payment page, which is hosted by Stripe"
          variant="decision"
          trailing={<Text variant="rowSub">↗</Text>}
          testID={hotspot("settling")}
        />
      </Row>
      {/*
        The slow case is drawn on the same frame rather than as a sixteenth
        one: it is the same screen a few seconds later, and a reviewer needs to
        see that the failure of a *departure* never strands somebody — the two
        ways out are both here.
      */}
      <Notice tone="warn" style={styles.gap}>
        <Text variant="rowSub">{leaving.slow}</Text>
      </Notice>
      <Row style={styles.actions}>
        <Button label={leaving.retry} testID={hotspot(null)} />
        <Button label={leaving.skip} variant="ghost" testID={hotspot(null)} />
      </Row>
    </View>
  );
}

function Cancelled(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowTitle">{cancelled.title}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {cancelled.body}
      </Text>
      <Row style={styles.actions}>
        <Button label={cancelled.resume} variant="decision" testID={hotspot("confirm")} />
        <Button label={cancelled.other} variant="ghost" testID={hotspot("first-run-a")} />
        <Button label={cancelled.later} variant="ghost" testID={hotspot(null)} />
      </Row>
    </View>
  );
}

function Settling({ slow }: { slow: boolean }): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <View style={styles.head}>
        <Pill tone="ok" leading={<Dot tone="ok" />}>
          Paid
        </Pill>
        <Text variant="rowTitle">{slow ? settling.slowTitle : settling.title}</Text>
      </View>
      <Text variant="rowSub" style={styles.lede}>
        {slow ? settling.slowBody : fill(settling.body)}
      </Text>
      <StepList
        testID="proto-steps"
        steps={[
          { label: settling.steps.paid, state: slow ? "working" : "done" },
          { label: settling.steps.provisioning, state: slow ? "waiting" : "working" },
          { label: settling.steps.scaffolding, state: "waiting" },
          { label: settling.steps.ready, state: "waiting" },
        ]}
      />
      {slow ? (
        <View>
          <Row style={styles.actions}>
            <Button label={settling.slowAction} testID={hotspot(null)} />
          </Row>
          <Text variant="foot" style={styles.foot}>
            {settling.supportAfter}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Provisioning(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowTitle">{settling.steps.provisioning}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {fill(settling.body)}
      </Text>
      <StepList
        testID="proto-steps"
        steps={[
          { label: settling.steps.paid, state: "done" },
          { label: settling.steps.provisioning, state: "done" },
          { label: settling.steps.scaffolding, state: "working" },
          { label: settling.steps.ready, state: "waiting" },
        ]}
      />
    </View>
  );
}

function ProvisionFailed(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <FormError headline={provisionFailed.title} next={provisionFailed.body} />
      <StepList
        testID="proto-steps"
        steps={[
          { label: settling.steps.paid, state: "done" },
          { label: settling.steps.provisioning, state: "failed" },
          { label: settling.steps.scaffolding, state: "waiting" },
          { label: settling.steps.ready, state: "waiting" },
        ]}
      />
      <Row style={styles.actions}>
        <Button label={provisionFailed.retry} variant="decision" testID={hotspot("provisioning")} />
        <Button label={provisionFailed.support} variant="ghost" testID={hotspot(null)} />
      </Row>
      <Block title={provisionFailed.fallbackTitle} sub={provisionFailed.fallbackBody}>
        <Row>
          <Button label={provisionFailed.fallback} testID={hotspot("first-run-a")} />
        </Row>
      </Block>
      <Text variant="foot" style={styles.foot}>
        {provisionFailed.supportBody}
      </Text>
    </View>
  );
}

function Ready(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Notice tone="ok">
        <Text variant="check" role="status">
          {ready.title}
        </Text>
      </Notice>
      <Text variant="rowSub" style={styles.lede}>
        {fill(ready.body)}
      </Text>
      <StepList
        testID="proto-steps"
        steps={[
          { label: settling.steps.paid, state: "done" },
          { label: settling.steps.provisioning, state: "done" },
          { label: settling.steps.scaffolding, state: "done" },
          { label: settling.steps.ready, state: "done" },
        ]}
      />
      <Hint style={styles.gap}>
        <Text variant="rowSub">{ready.managedNote}</Text>
      </Hint>
      <Row style={styles.actions}>
        <Button label={ready.cta} variant="decision" testID={hotspot(null)} />
      </Row>
      <Text variant="foot" style={styles.foot}>
        {ready.ctaSub}
      </Text>
    </View>
  );
}

function SwitchToManaged(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="paneTitle">{switchToManaged.title}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {fill(switchToManaged.lede)}
      </Text>
      <Block title={switchToManaged.keepTitle}>
        <PointList points={switchToManaged.keepPoints} />
      </Block>
      <Card style={styles.gap}>
        <PriceRow price={PRICE} note={fill(switchToManaged.price)} />
      </Card>
      <Row style={styles.actions}>
        <Button
          label={switchToManaged.cta}
          variant="decision"
          trailing={<Text variant="rowSub">↗</Text>}
          testID={hotspot("settling")}
        />
        <Button label={switchToManaged.cancel} variant="ghost" testID={hotspot("settings-free")} />
      </Row>
      <Text variant="foot" style={styles.foot}>
        {switchToManaged.afterNote}
      </Text>
      <Notice style={styles.gap} testID="proto-export-promise">
        <Text variant="rowSub">{EXPORT_PROMISE}</Text>
      </Notice>
    </View>
  );
}

function ExitPanel(): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="paneTitle">{exit.title}</Text>
      <Text variant="rowSub" style={styles.lede}>
        {exit.lede}
      </Text>
      <Block title={exit.downloadTitle} sub={exit.downloadBody}>
        <Row>
          <Button label={exit.downloadCta} variant="decision" testID={hotspot(null)} />
        </Row>
      </Block>
      <Block title={exit.handoffTitle} sub={exit.handoffBody}>
        <Row>
          <Button label={exit.handoffCta} variant="decision" testID={hotspot(null)} />
        </Row>
      </Block>
      <Notice style={styles.gap} testID="proto-export-promise">
        <Text variant="rowSub">{exit.afterCancelNote}</Text>
      </Notice>
    </View>
  );
}

function ReadOnlyBanner({ who }: { who: "owner" | "member" | "cancelled" }): ReactElement {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.page}>
      <Text variant="eyebrow">Above the note list, in the context itself</Text>
      {who === "owner" ? (
        <StateBanner
          tone="warn"
          testID="proto-banner"
          title={readOnly.ownerTitle}
          body={readOnly.ownerBody}
          primary={{ label: readOnly.ownerCta, goto: "settings-past-due" }}
          secondary={{ label: readOnly.ownerSecondary, goto: "settings-exit" }}
        />
      ) : who === "member" ? (
        <StateBanner
          tone="warn"
          testID="proto-banner"
          title={readOnly.memberTitle}
          body={readOnly.memberBody}
        />
      ) : (
        <StateBanner
          tone="neutral"
          testID="proto-banner"
          title={readOnly.cancelledOwnerTitle}
          body={readOnly.cancelledOwnerBody}
          primary={{ label: readOnly.cancelledOwnerCta, goto: "settings-free" }}
          secondary={{ label: readOnly.ownerSecondary, goto: "settings-exit" }}
        />
      )}
      <Text variant="foot" style={styles.foot}>
        Drawn on its own here. In the product it is the first thing inside the
        context, above the folder listing and above an open note, so somebody who
        cannot save reads it where they are rather than in settings.
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */

export const FRAMES: ReadonlyArray<ProtoFrame> = [
  {
    id: "pricing",
    title: "Pricing — the way in",
    group: "Acquisition",
    kind: "page",
    note: "Free first, then the two things $20 buys. The billable unit is on the price itself.",
    evidence: [
      { label: "Price, ceiling and entitlement copy come from the shipping module", state: "built" },
      { label: "A pricing surface anywhere in the product", state: "proposed" },
      { label: "Sign-up from here", state: "built" },
    ],
    body: () => <Pricing />,
  },
  {
    id: "first-run-a",
    title: "First run — storage choice (variant A)",
    group: "First run",
    kind: "welcome",
    note: "Three options, free ones first, price on the face of the paid one. The variant this pack recommends.",
    evidence: [
      { label: "The two free cards, and skipping", state: "built" },
      { label: "The managed card and everything behind it", state: "proposed" },
      {
        label:
          "The line under the card still reads \"your notes stay in a bucket you own\" — " +
          "true on two of three paths and false on the third. The chrome's own copy has to " +
          "change with this screen; the replacement is in the copy deck.",
        state: "proposed",
      },
    ],
    body: () => <FirstRunA />,
  },
  {
    id: "first-run-b",
    title: "First run — storage choice (variant B)",
    group: "First run",
    kind: "welcome",
    note: "Ask the question the cards answer, then show one branch. The alternative, kept for the critique.",
    evidence: [{ label: "The whole screen", state: "proposed" }],
    body: () => <FirstRunB />,
  },
  {
    id: "confirm",
    title: "Confirm — price, unit, entitlements",
    group: "First run",
    kind: "welcome",
    note: "The last screen before Stripe: what it costs, what it covers, what it is not, and where you are going.",
    evidence: [
      { label: "Entitlement rows, hint and price", state: "built" },
      { label: "Selecting entitlements before a plan row exists", state: "backend" },
      { label: "The confirmation step itself", state: "proposed" },
    ],
    body: () => <Confirm />,
  },
  {
    id: "leaving",
    title: "Leaving for Stripe",
    group: "First run",
    kind: "welcome",
    note: "The URL arrives a beat after the press, so the departure is its own moment — with a way out if it never arrives.",
    evidence: [
      { label: "Two round trips, and the press that leaves", state: "built" },
      { label: "The slow-mint case having any UI at all", state: "proposed" },
    ],
    body: () => <Leaving />,
  },
  {
    id: "cancelled",
    title: "Back without paying",
    group: "Back from Stripe",
    kind: "welcome",
    note: "Stripe's cancel URL lands somewhere that says nothing was charged, and offers the free paths.",
    evidence: [
      { label: "`cancel_url` is set", state: "built" },
      { label: "A route that answers it (today it is `/settings`, which is not a route)", state: "backend" },
      { label: "This screen", state: "proposed" },
    ],
    body: () => <Cancelled />,
  },
  {
    id: "settling",
    title: "Back from Stripe — payment settling",
    group: "Back from Stripe",
    kind: "welcome",
    note: "The webhook has not landed. Never says failed, never spins without a sentence, and gives permission to leave.",
    evidence: [
      { label: "The webhook that ends this wait", state: "built" },
      { label: "A return route, and a way to watch a plan turn active", state: "backend" },
      { label: "This screen", state: "proposed" },
    ],
    next: "provisioning",
    body: () => <Settling slow={false} />,
  },
  {
    id: "settling-slow",
    title: "Back from Stripe — still waiting",
    group: "Back from Stripe",
    kind: "welcome",
    note: "A minute later. The work finishes server-side whether or not this tab is open, and the copy says so.",
    evidence: [
      { label: "Server-side completion independent of the tab", state: "built" },
      { label: "A support path that can finish it by hand", state: "proposed" },
    ],
    next: "provisioning",
    body: () => <Settling slow />,
  },
  {
    id: "provisioning",
    title: "Making your storage",
    group: "Back from Stripe",
    kind: "welcome",
    note: "The managed bucket being created and scaffolded. Named steps rather than a bar, because there is no honest percentage.",
    evidence: [
      { label: "Bucket naming and the guards around the managed account", state: "built" },
      { label: "The provisioning action itself", state: "backend" },
      { label: "This screen", state: "proposed" },
    ],
    next: "ready",
    body: () => <Provisioning />,
  },
  {
    id: "provision-failed",
    title: "Provisioning failed — and retry is safe",
    group: "Back from Stripe",
    kind: "welcome",
    note: "Paid, and no storage. Says the money and the notes are safe, says retry cannot duplicate, and offers the free path out.",
    evidence: [
      { label: "Retry being idempotent (the bucket is named from the workspace id)", state: "built" },
      { label: "A retry control, and a subscription that can be stopped from here", state: "backend" },
      { label: "This screen", state: "proposed" },
    ],
    body: () => <ProvisionFailed />,
  },
  {
    id: "ready",
    title: "Storage ready — carry on",
    group: "Back from Stripe",
    kind: "welcome",
    note: "Ends in the next onboarding step rather than in a tick, and restates the hand-off in the same breath.",
    evidence: [
      { label: "The layout step this hands to", state: "built" },
      { label: "The hand-off it points at", state: "backend" },
    ],
    body: () => <Ready />,
  },
  {
    id: "settings-free",
    title: "Settings — free plan (shipping today)",
    group: "Settings",
    kind: "settings",
    note: "The real panel against a free fixture. Nothing here is a drawing.",
    evidence: [{ label: "Everything on this frame", state: "built" }],
    body: () => <PremiumBody view={view({})} section="premium" />,
  },
  {
    id: "settings-active",
    title: "Settings — Premium active (shipping today)",
    group: "Settings",
    kind: "settings",
    note: "Both entitlements, a renewal date, a note census, and the manage-billing press that leaves for Stripe.",
    evidence: [
      { label: "Everything on this frame", state: "built" },
      { label: "Anything actually consuming the entitlement", state: "backend" },
    ],
    body: () => (
      <PremiumBody
        view={view({
          status: "active",
          selected: { managedStorage: true, fastSearch: true },
          active: { managedStorage: true, fastSearch: true },
          hasStripeCustomer: true,
          currentPeriodEnd: PERIOD_END,
          notes: 412,
          storageIsManaged: true,
        })}
        section="premium"
      />
    ),
  },
  {
    id: "settings-past-due",
    title: "Settings — payment failed, owner (shipping today)",
    group: "Settings",
    kind: "settings",
    note: "The owner is told their card was declined and where to fix it. Nothing is deleted, and the panel says so.",
    evidence: [
      { label: "Everything on this frame", state: "built" },
      { label: "The context going read-only as a result", state: "backend" },
    ],
    body: () => (
      <PremiumBody
        view={view({
          status: "past_due",
          selected: { managedStorage: true, fastSearch: true },
          hasStripeCustomer: true,
          currentPeriodEnd: PERIOD_END,
          storageIsManaged: true,
        })}
        section="premium"
      />
    ),
  },
  {
    id: "settings-member",
    title: "Settings — payment failed, member (shipping today)",
    group: "Settings",
    kind: "settings",
    note: "The same state, seen by somebody who does not hold the card: no decline, no date, no buttons.",
    evidence: [{ label: "Everything on this frame", state: "built" }],
    body: () => (
      <PremiumBody
        view={{
          status: status({
            status: "past_due",
            selected: { managedStorage: true, fastSearch: true },
            canManage: false,
            storageIsManaged: true,
          }),
          loading: false,
          session: null,
        }}
        section="premium"
      />
    ),
  },
  {
    id: "settings-switch",
    title: "Settings — move an existing context to managed storage",
    group: "Settings",
    kind: "settings",
    note: "The upgrade path for a context that already has notes somewhere. The hazard is silent data loss, so the copy is about what is copied and what is left alone.",
    evidence: [
      { label: "Reading the current binding and its provider", state: "built" },
      { label: "Copying an existing context's notes into managed storage", state: "backend" },
      { label: "This screen", state: "proposed" },
    ],
    body: () => <SwitchToManaged />,
  },
  {
    id: "settings-exit",
    title: "Settings — leaving with everything",
    group: "Settings",
    kind: "settings",
    note:
      "The promise, as two controls. Marked: neither is built, and non-negotiable #1 makes " +
      "both launch blockers for managed storage. It is drawn under Premium here because that " +
      "is the seam this prototype renders through — it belongs under Storage, or on its own " +
      "row, where a free context can reach it too.",
    evidence: [
      { label: "The promise, in words, in every state", state: "built" },
      { label: "A download of everything", state: "backend" },
      { label: "Handing a managed bucket to storage the customer owns", state: "backend" },
    ],
    body: () => <ExitPanel />,
  },
  {
    id: "read-only-owner",
    title: "Read-only — the owner sees it in the context",
    group: "Lifecycle",
    kind: "page",
    note: "Past due on a managed context. The way out is on the banner, not three screens away.",
    evidence: [
      { label: "The plan status behind it", state: "built" },
      { label: "A write path that actually goes read-only", state: "backend" },
      { label: "The banner", state: "proposed" },
    ],
    body: () => <ReadOnlyBanner who="owner" />,
  },
  {
    id: "read-only-member",
    title: "Read-only — a member sees less",
    group: "Lifecycle",
    kind: "page",
    note: "Same state, no card detail, no controls — the narrowing `describePremium` already performs, carried out of settings.",
    evidence: [{ label: "The narrowing rule", state: "built" }, { label: "The banner", state: "proposed" }],
    body: () => <ReadOnlyBanner who="member" />,
  },
  {
    id: "read-only-cancelled",
    title: "Cancelled — read-only and exportable",
    group: "Lifecycle",
    kind: "page",
    note: "Not an alarm. States what is true — readable, exportable, never deleted — and offers both ways forward.",
    evidence: [
      { label: "Cancelling never deleting anything", state: "built" },
      { label: "Read-only enforcement, and the export beside it", state: "backend" },
    ],
    body: () => <ReadOnlyBanner who="cancelled" />,
  },
];

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { padding: space.x6, gap: space.x2, maxWidth: 900, width: "100%", marginHorizontal: "auto" },
    pageTitle: { marginTop: space.x2 },
    pageLede: { marginTop: space.x2, lineHeight: leading(13, 1.7), maxWidth: 620 },
    planRow: { flexDirection: "row", flexWrap: "wrap", gap: space.x3, marginTop: space.x5 },
    plan: { flexGrow: 1, flexBasis: 300 },
    planHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    planLede: { marginTop: space.x2, lineHeight: leading(13, 1.6) },
    planPoints: { marginTop: space.x4, gap: space.x3 },
    planPoint: { gap: space.x1 },
    planPointBody: { lineHeight: leading(13, 1.6) },

    lede: { marginTop: space.x2, marginBottom: space.x4, lineHeight: leading(12.5, 1.7) },
    head: { flexDirection: "row", alignItems: "center", gap: space.x3, flexWrap: "wrap" },
    gap: { marginTop: space.x3 },
    managedWrap: { marginTop: space.x3 },
    actions: { marginTop: space.x4, gap: space.x3, flexWrap: "wrap", alignItems: "center" },
    foot: {
      marginTop: space.x3,
      lineHeight: leading(12.5, 1.7),
      // Referenced so a palette change is visible here rather than this being a
      // themed stylesheet that uses nothing themed.
      color: colors.muted,
    },
  });

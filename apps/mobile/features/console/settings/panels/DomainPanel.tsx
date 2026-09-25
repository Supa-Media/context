import { createContext, useContext, useState } from "react";
import { useConvex } from "convex/react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { CopyField } from "../../../design/components/CopyField";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { FormError, Notice, TextField } from "../../../design/components/Input";
import { Menu } from "../../../design/components/Menu";
import type { MenuItem } from "../../files/menu";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useArming } from "../../useArming";
import {
  cleanDomainInput,
  describeDomainFailure,
  domainPill,
  domainShapeProblem,
  domainUrl,
  type DomainView,
} from "../../domain/domain";
import type { DomainActions, DomainPanelView, HomepageChoice } from "../../domain/useDomain";
import { useDomain } from "../../domain/useDomain";
import { DomainSetup } from "./DomainSetup";
import { PanelHead } from "./PanelHead";
import { LiveWebsiteCard, WebsiteCard, WebsiteViewOverride } from "./WebsiteCard";
import { consoleOrigin } from "../../files/shareOrigin";

/**
 * A fixed view in place of the subscription, for the browser fixture that
 * draws every state (`features/e2e/DomainFixture.tsx`). Nothing in the app
 * provides it.
 */
export const DomainViewOverride = createContext<DomainPanelView | null>(null);

/** What the landing page's console shows: a live domain, read-only. */
/** No client to ask: say the section couldn't load rather than invent a state. */
const UNREADABLE_DOMAIN_VIEW: DomainPanelView = { settings: undefined, failed: true, homepageChoices: [] };

const DEMO_DOMAIN_VIEW: DomainPanelView = {
  failed: false,
  homepageChoices: [],
  settings: {
    available: true,
    paying: true,
    canManage: false,
    domain: {
      id: "demo",
      hostname: "docs.acme.com",
      apex: false,
      status: "active",
      stage: "live",
      ownershipVerified: true,
      routingVerified: true,
      httpsReady: true,
      problem: null,
      homeSlug: null,
      checkedAt: null,
      checkingSince: 0,
      records: [],
      oneClick: null,
    },
  },
};

/** The whole section as `SettingsPane` mounts it: heading, then the panel. */
export function DomainSection({
  sectioned,
  workspaceId,
  handle,
  demo,
  onOpenPremium,
}: {
  sectioned: boolean;
  workspaceId: string | null;
  handle: string;
  demo: boolean;
  onOpenPremium?: () => void;
}) {
  /*
    `useConvex` returns `undefined` with no provider in the tree: the landing
    page's demo console and the render tests. The subscribing half only mounts
    when there is a client to subscribe with, as the Premium panel does.
  */
  const client = useConvex();
  const override = useContext(DomainViewOverride);
  const websiteOverride = useContext(WebsiteViewOverride);
  const head = (
    <PanelHead section="website" sectioned={sectioned}>
      Publish pages from the website folder in your workspace. Nothing else goes live.
    </PanelHead>
  );
  const fixed = override ?? (demo ? DEMO_DOMAIN_VIEW : client === undefined ? UNREADABLE_DOMAIN_VIEW : null);
  return (
    <>
      {head}
      {/* The demo and the domain-only fixture have no website to show. */}
      {websiteOverride !== null || fixed === null ? (
        <>
          {websiteOverride !== null ? (
            <WebsiteCard view={websiteOverride} origin={consoleOrigin()} />
          ) : (
            <LiveWebsiteCard workspaceId={workspaceId} />
          )}
          <DomainIntro />
        </>
      ) : null}
      {fixed !== null ? (
        <DomainPanel view={fixed} handle={handle} onOpenPremium={onOpenPremium} />
      ) : (
        <LiveDomainPanel workspaceId={workspaceId} handle={handle} onOpenPremium={onOpenPremium} />
      )}
    </>
  );
}

/** The line between the two cards: a domain serves the website as well as the links. */
function DomainIntro() {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="paneSub" style={styles.intro}>
      Your site and short links can use your own domain.
    </Text>
  );
}

function LiveDomainPanel({
  workspaceId,
  handle,
  onOpenPremium,
}: {
  workspaceId: string | null;
  handle: string;
  onOpenPremium?: () => void;
}) {
  const view = useDomain(workspaceId);
  return <DomainPanel view={view} handle={handle} onOpenPremium={onOpenPremium} />;
}

/**
 * Settings › Website: the address a workspace's published links open at.
 *
 * One card whatever the state, built only from components the other panels
 * already use, and following their rules: controls are absent — never
 * disabled — for anybody who is not an owner; a status is `ok`, `warn` or
 * `neutral`; nothing spins, because the settings query is a subscription and
 * the card changes in place when the checker finds something.
 */
export function DomainPanel({
  view,
  handle,
  onOpenPremium,
}: {
  view: DomainPanelView;
  /** The workspace's own handle, for the "same as context.lc/@…" sentence. */
  handle: string;
  onOpenPremium?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { settings, actions } = view;

  if (view.failed) {
    return <FormError headline="Couldn't load this workspace's domain." next="Reload the page to try again." />;
  }
  if (settings === undefined) {
    return (
      <Card>
        <Text variant="rowSub">Loading…</Text>
      </Card>
    );
  }
  if (!settings.available) {
    return (
      <Card testID="domain-unavailable">
        <Text variant="rowTitle">Domains aren't available here</Text>
        <Text variant="rowSub" style={styles.sub}>
          This deployment isn't set up to serve custom domains.
        </Text>
      </Card>
    );
  }

  const domain = settings.domain;
  return (
    <View>
      {domain !== null ? (
        <DomainCard domain={domain} actions={actions} view={view} handle={handle} onOpenPremium={onOpenPremium} />
      ) : !settings.paying ? (
        <Card testID="domain-upsell">
          <Row>
            <Grow>
              <Text variant="rowTitle">Use your own domain</Text>
              <Text variant="rowSub" style={styles.sub}>
                {actions !== undefined
                  ? "With Premium, your short links can open at an address you own, like docs.acme.com/intake."
                  : "With Premium, short links can open at an address you own. An owner can turn on Premium."}
              </Text>
            </Grow>
            {actions !== undefined && onOpenPremium !== undefined ? (
              <Button variant="mini" label="See Premium" onPress={onOpenPremium} />
            ) : null}
          </Row>
        </Card>
      ) : actions !== undefined ? (
        <ConnectForm actions={actions} />
      ) : (
        <Card>
          <Text variant="rowTitle">No domain connected</Text>
          <Text variant="rowSub" style={styles.sub}>
            {`Links from this workspace open at context.lc/@${handle}/…`}
          </Text>
        </Card>
      )}
      {actions === undefined ? (
        <Text variant="foot" style={styles.foot}>
          Only an owner of this workspace can change its domain.
        </Text>
      ) : null}
    </View>
  );
}

function ConnectForm({ actions }: { actions: DomainActions }) {
  const styles = useThemedStyles(makeStyles);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const cleaned = cleanDomainInput(value);

  async function connect() {
    if (busy || cleaned === "") return;
    const shape = domainShapeProblem(cleaned);
    if (shape !== null) {
      setFieldError(shape);
      return;
    }
    setBusy(true);
    setFormError(undefined);
    try {
      await actions.connect(cleaned);
    } catch (error) {
      const failure = describeDomainFailure(error);
      setFieldError(failure.field);
      setFormError(failure.form);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testID="domain-connect">
      <TextField
        label="Domain"
        placeholder="docs.acme.com"
        value={value}
        onChangeText={(next) => {
          setValue(next);
          setFieldError(undefined);
          setFormError(undefined);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        inputMode="url"
        returnKeyType="go"
        onSubmitEditing={() => void connect()}
        error={fieldError}
        hint={fieldError === undefined ? "A domain you own. A subdomain like docs.acme.com is simplest." : undefined}
        testID="domain-input"
      />
      <Button
        label={busy ? "Connecting…" : "Connect"}
        variant="accent"
        disabled={busy || cleaned === ""}
        style={styles.connect}
        onPress={() => void connect()}
        testID="domain-connect-button"
      />
      {formError !== undefined ? <FormError headline={formError} style={styles.formError} /> : null}
    </Card>
  );
}

function DomainCard({
  domain,
  actions,
  view,
  handle,
  onOpenPremium,
}: {
  domain: DomainView;
  actions?: DomainActions;
  view: DomainPanelView;
  handle: string;
  onOpenPremium?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const pill = domainPill(domain);
  const owner = actions !== undefined;

  return (
    <Card testID="domain-card">
      <Row>
        <Grow>
          <Text variant="rowTitle" selectable numberOfLines={1} role="status">
            {domain.hostname}
          </Text>
        </Grow>
        <Pill tone={pill.tone} leading={<Dot tone={pill.tone} />} testID="domain-pill">
          {pill.label}
        </Pill>
      </Row>

      {domain.status === "active" ? (
        <>
          <CopyField value={domainUrl(domain.hostname)} label="Copy your domain's address" style={styles.block} />
          {owner ? <HomepageRow domain={domain} choices={view.homepageChoices} actions={actions} /> : null}
          <Row divided>
            <Grow>
              <Text variant="rowTitle">Short links</Text>
              <Text variant="rowSub" style={styles.sub}>
                {`${domain.hostname}/intake opens the same note as context.lc/@${handle}/intake, for every short link anyone can open.`}
              </Text>
            </Grow>
          </Row>
        </>
      ) : null}

      {domain.status === "pending" ? (
        owner ? (
          <DomainSetup domain={domain} actions={actions} />
        ) : (
          <Text variant="rowSub" style={styles.block}>
            Being set up by an owner.
          </Text>
        )
      ) : null}

      {domain.status === "suspended" ? (
        <Notice tone="neutral" style={styles.block}>
          <Text variant="rowTitle">Paused while Premium is off</Text>
          <Text variant="rowSub" style={styles.sub}>
            {`${domain.hostname} isn't serving right now. Your links still work at context.lc, and nothing has been deleted. Turn Premium back on and it comes straight back.`}
          </Text>
          {owner && onOpenPremium !== undefined ? (
            <Button variant="mini" label="Open Premium" onPress={onOpenPremium} style={styles.noticeButton} />
          ) : null}
        </Notice>
      ) : null}

      {domain.status === "removing" ? (
        <Text variant="rowSub" style={styles.block}>
          {`Removing ${domain.hostname}. Your notes and links aren't affected.`}
        </Text>
      ) : null}

      {owner && domain.status !== "removing" ? <RemoveRow domain={domain} actions={actions} /> : null}
    </Card>
  );
}

function HomepageRow({
  domain,
  choices,
  actions,
}: {
  domain: DomainView;
  choices: HomepageChoice[];
  actions: DomainActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const current = choices.find((choice) => choice.slug === domain.homeSlug);

  async function choose(slug: string | null) {
    setOpen(false);
    setSaving(true);
    setFailure(undefined);
    try {
      await actions.setHomepage(slug);
    } catch (error) {
      setFailure(describeDomainFailure(error).form);
    } finally {
      setSaving(false);
    }
  }

  const items: MenuItem<string>[] = [
    {
      id: "",
      label: "None",
      detail: "Shows “Nothing here yet”",
      checked: domain.homeSlug === null,
    },
    ...choices.map(
      (choice): MenuItem<string> => ({
        id: choice.slug,
        label: `/${choice.slug}`,
        detail: choice.title,
        checked: choice.slug === domain.homeSlug,
      }),
    ),
  ];

  const summary = saving
    ? "Saving…"
    : domain.homeSlug === null
      ? "None yet. The address shows a “Nothing here yet” page."
      : `/${domain.homeSlug}${current !== undefined ? ` · ${current.title}` : ""}`;

  return (
    <>
      <Row divided>
        <Grow>
          <Text variant="rowTitle">Homepage</Text>
          <Text variant="rowSub" style={styles.sub} numberOfLines={2}>
            {summary}
          </Text>
        </Grow>
        <Button variant="mini" label="Change" onPress={() => setOpen(true)} testID="domain-homepage" />
      </Row>
      {failure !== undefined ? <FormError headline={failure} style={styles.formError} /> : null}
      {open ? (
        <Menu<string>
          title="Homepage"
          titleDetail={
            choices.length === 0 ? "Claim a short link on a note shared with anyone, and it appears here." : undefined
          }
          items={items}
          onSelect={(id) => void choose(id === "" ? null : id)}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function RemoveRow({ domain, actions }: { domain: DomainView; actions: DomainActions }) {
  const styles = useThemedStyles(makeStyles);
  const [failure, setFailure] = useState<string | undefined>();
  const removal = useArming(async () => {
    try {
      await actions.remove();
    } catch (error) {
      setFailure(describeDomainFailure(error).form);
    }
  });
  const idle = removal.stage === "idle";
  return (
    <View>
      <Row divided style={styles.removeRow}>
        <View style={styles.grow} />
        <Button
          variant="danger"
          label={idle ? "Remove" : "Confirm"}
          disabled={removal.stage === "working"}
          accessibilityLabel={idle ? `Remove ${domain.hostname}` : `Confirm removing ${domain.hostname}`}
          testID="domain-remove"
          onPress={removal.press}
        />
      </Row>
      {removal.stage === "armed" ? (
        <Hint>
          <Text variant="hint">
            {`Removing stops serving ${domain.hostname}. No notes or links are deleted, and every link keeps working at context.lc. Delete the DNS records at your provider too.`}
          </Text>
        </Hint>
      ) : null}
      {failure !== undefined ? <FormError headline={failure} style={styles.formError} /> : null}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    sub: { marginTop: 2 },
    block: { marginTop: 13 },
    foot: { marginTop: 13 },
    connect: { marginTop: 12 },
    formError: { marginTop: 8 },
    checkLine: { marginTop: 13 },
    removeRow: { marginTop: 13 },
    grow: { flex: 1 },
    noticeButton: { marginTop: 10, alignSelf: "flex-start" },
    intro: { marginTop: 26, marginBottom: 12 },
  });

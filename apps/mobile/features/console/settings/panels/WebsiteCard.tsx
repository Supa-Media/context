import { createContext, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import type { WebsiteStateView } from "@context/shared";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { CopyField } from "../../../design/components/CopyField";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { FormError } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { consoleOrigin } from "../../files/shareOrigin";
import { useArming } from "../../useArming";
import { describeWebsiteFailure, websiteAddress, websiteWarning } from "../../website/website";
import { useWebsite, type WebsiteActions, type WebsiteCardView } from "../../website/useWebsite";

/**
 * Settings › Website: whether the website folder is published, and the switch.
 *
 * The card above the domain card. Off, it says where the site would open and
 * offers one button; on, it shows the address with Copy and Open, and a Turn
 * off at the foot. Both switches arm first and say what they do before they
 * do it, the same two-press pattern as removing a domain — there is no dialog
 * in this pane for one to look like.
 *
 * Who may press them is the server's answer (`canManage`): a member sees the
 * state and no control, absent rather than disabled, like every card here.
 */
export function WebsiteCard({ view, origin }: { view: WebsiteCardView; origin: string }) {
  const styles = useThemedStyles(makeStyles);
  const { state, actions } = view;

  if (view.failed) {
    return <FormError headline="Couldn't load this workspace's website." next="Reload the page to try again." />;
  }
  if (state === undefined) {
    return (
      <Card>
        <Text variant="rowSub">Loading…</Text>
      </Card>
    );
  }

  const address = websiteAddress(origin, state.handlePath);
  const on = state.state === "enabled";
  const open = () => void Linking.openURL(address.url).catch(() => undefined);
  return (
    <View>
      <Card testID="website-card">
        <Row>
          <Grow>
            <Text variant="rowTitle">Website</Text>
          </Grow>
          <Pill tone={on ? "ok" : "neutral"} leading={<Dot tone={on ? "ok" : "neutral"} />} testID="website-pill">
            {on ? "Live" : "Off"}
          </Pill>
        </Row>
        {on ? (
          <CopyField value={address.url} label="Copy your website's address" style={styles.block} />
        ) : (
          <Text variant="rowSub" style={styles.sub}>
            {`Your site will open at ${address.short}`}
          </Text>
        )}
        {actions !== undefined ? (
          <SwitchRow state={state} actions={actions} short={address.short} onOpen={on ? open : undefined} />
        ) : on ? (
          <Row divided style={styles.block}>
            <OpenButton onPress={open} />
          </Row>
        ) : null}
      </Card>
      {actions === undefined ? (
        <Text variant="foot" style={styles.block}>
          Only an owner of this workspace can change its website.
        </Text>
      ) : null}
    </View>
  );
}

function OpenButton({ onPress }: { onPress: () => void }) {
  return (
    <Button
      variant="mini"
      label="Open site"
      accessibilityLabel="Open your website"
      onPress={onPress}
      testID="website-open"
    />
  );
}

function SwitchRow({
  state,
  actions,
  short,
  onOpen,
}: {
  state: WebsiteStateView;
  actions: WebsiteActions;
  short: string;
  onOpen?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const on = state.state === "enabled";
  const [failure, setFailure] = useState<string | undefined>();
  const arming = useArming(async () => {
    setFailure(undefined);
    try {
      await (on ? actions.disable() : actions.enable());
    } catch (error) {
      setFailure(describeWebsiteFailure(error, !on));
    }
  });
  const label =
    arming.stage === "working"
      ? on
        ? "Turning off…"
        : "Turning on…"
      : arming.stage === "armed"
        ? "Confirm"
        : on
          ? "Turn off"
          : "Turn on";
  return (
    <View>
      <Row divided style={styles.block}>
        {onOpen !== undefined ? <OpenButton onPress={onOpen} /> : null}
        <View style={styles.grow} />
        <Button
          variant={on ? "danger" : "mini"}
          label={label}
          disabled={arming.stage === "working"}
          accessibilityLabel={
            arming.stage === "armed" ? (on ? "Confirm turning off your website" : "Confirm turning on your website") : undefined
          }
          onPress={arming.press}
          testID="website-switch"
        />
      </Row>
      {arming.stage === "armed" ? (
        <Hint>
          <Text variant="hint" testID="website-warning">
            {websiteWarning(state, short)}
          </Text>
        </Hint>
      ) : null}
      {failure !== undefined ? <FormError headline={failure} style={styles.formError} /> : null}
    </View>
  );
}

/**
 * A fixed view in place of the subscription, for the browser fixture that
 * draws every state (`features/e2e/DomainFixture.tsx`). Nothing in the app
 * provides it.
 */
export const WebsiteViewOverride = createContext<WebsiteCardView | null>(null);

/** The card as the Website section mounts it, subscribed to the server's view. */
export function LiveWebsiteCard({ workspaceId }: { workspaceId: string | null }) {
  const view = useWebsite(workspaceId);
  return <WebsiteCard view={view} origin={consoleOrigin()} />;
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    sub: { marginTop: 2 },
    block: { marginTop: 13 },
    grow: { flex: 1 },
    formError: { marginTop: 8 },
  });

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row, Grow } from "../../design/components/Card";
import { TextLink } from "../../design/components/TextLink";
import { useCopy } from "../../design/useCopy";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { SetupAgent } from "../../agentSetup/guides";
import { ConnectClients } from "../clients/ConnectClients";
import { ClientGroupRow } from "../clients/ClientGroupRow";
import { groupClients } from "../clients/grouped";
import { DeleteAccountCard } from "./DeleteAccountCard";
import { atName } from "../format";
import type { ConsoleData } from "../types";
import { settingsSectionLabel, type SettingsSectionKey } from "./sections";
import { MachinesCard } from "./panels/MachinesCard";
import { SignInEmailsCard } from "./panels/SignInEmailsCard";
import { YourPicture } from "./panels/YourPicture";
import { FeedbackSettings } from "../../feedback/FeedbackSettings";

/**
 * The settings that belong to the person rather than to one context.
 *
 * There were none. A storage binding hangs off a `workspaceId`, so settings
 * grew up per-context and everything account-shaped ended up wherever it fit:
 * deleting an account on a per-*context* pane next to "add a client", signing
 * out as a power glyph in the rail, and the endpoint — which reaches every
 * context its person is a live member of — filed under one of them.
 *
 * Nothing here is new behaviour. `ConnectClients`, `ClientRow` and
 * `DeleteAccountCard` are the Connections pane's, imported rather than
 * reimplemented, so the two surfaces cannot drift apart while both exist.
 */
export function AccountSection({
  section,
  data,
  onSignOut,
  onOpenInvitation,
  onSelect,
}: {
  section: SettingsSectionKey;
  data: ConsoleData;
  /** Open another section, for the row that links to Feedback. */
  onSelect?: (key: SettingsSectionKey) => void;
  /**
   * Absent on a surface with no session to end — the landing page's copy of
   * the console, and the fixture. A sign-out button that cannot sign anybody
   * out is the button `ClientRow`'s Revoke comment refuses to draw.
   */
  onSignOut?: () => void;
  /** Answering an invitation is a navigation to `inviteHref(token)`. */
  onOpenInvitation?: (token: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    Whether this person has a workspace of their own. An invited-only viewer is a
    first-class state — `identity.ts` exists partly to handle it — and for one,
    `viewer.name` is their sign-in email rather than a username.
  */
  const owned = data.contexts.some(
    (context) => context.kind === "personal" && context.role === "owner",
  );

  if (section === "feedback") return <FeedbackSettings />;

  if (section === "invitations") {
    const invitations = data.invitations ?? [];
    return (
      <View>
        <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
          {settingsSectionLabel("invitations")}
        </Text>
        <Text variant="paneSub" style={styles.sub}>
          Places you have been asked to join. Accepting one adds it to everything this
          address reaches — the same connection, with the access you were granted there.
        </Text>
        <Card>
          {invitations.length === 0 ? (
            <Row>
              <Grow>
                <Text variant="rowSub">
                  {data.loading ? "Loading…" : "Nothing pending."}
                </Text>
              </Grow>
            </Row>
          ) : null}
          {invitations.map((invitation, index) => (
            <Row key={invitation.token} divided={index > 0}>
              <Grow>
                <Text variant="rowTitle">{atName(invitation.slug)}</Text>
              </Grow>
              {/*
                Answering is deliberately a navigation rather than a button
                that accepts in place: `nav.ts` routes an invitation through
                `inviteHref(token)`, which is the surface that states what is
                being joined and by whom before anything is accepted.
              */}
              <Button
                label="Open"
                accessibilityLabel={`Open the invitation to ${atName(invitation.slug)}`}
                disabled={onOpenInvitation === undefined}
                onPress={
                  onOpenInvitation === undefined
                    ? undefined
                    : () => onOpenInvitation(invitation.token)
                }
                testID={`settings-invitation-${invitation.slug}`}
              />
            </Row>
          ))}
        </Card>
      </View>
    );
  }

  /*
    Profile is the fall-through rather than another `if`: an unknown account
    key lands on the person's own screen, which is the safe answer.
  */
  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("profile")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        You, across every workspace.
      </Text>

      {/* The person's own picture; a photo here is saved with the account. */}
      <YourPicture />

      <Card style={styles.spaced}>
        <Row>
          <Grow>
            <Text variant="rowTitle">{owned ? "Username" : "Signed in as"}</Text>
          </Grow>
          <Text variant="mono">{data.viewer.name}</Text>
        </Row>
        {/*
          Only where it is the address this person's own workspace was issued.
          `viewerIdentity` substitutes a derived one when the open context is
          somebody else's, and a guess presented as a fact under the heading
          "Profile" is a stronger claim than the rail's account block has
          ever made.
        */}
        {owned && data.viewer.detail !== undefined ? (
          <Row divided>
            <Grow>
              <Text variant="rowTitle">Forwarding address</Text>
            </Grow>
            <Text variant="mono">{data.viewer.detail}</Text>
          </Row>
        ) : null}
        {/*
          Appearance is only what the device says: nothing is stored behind it,
          so there is no control to draw.
        */}
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Look</Text>
          </Grow>
          <Text variant="rowSub">Follows your device</Text>
        </Row>
        {/* Feedback is a page of its own, reached from this row. */}
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Help improve Context</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              Crash reports, screen counts and recordings with words hidden.
            </Text>
          </Grow>
          {onSelect === undefined ? null : (
            <TextLink
              label="Choose"
              accessibilityLabel="Choose what helps improve Context"
              onPress={() => onSelect("feedback")}
              testID="profile-feedback-choose"
            />
          )}
        </Row>
      </Card>
      <Text variant="foot" style={styles.foot}>
        Only a personal workspace has an address mail can be sent to. A shared one has
        none at all.
      </Text>

      {/* Every email this person signs in with (Dev2, 2026-10-09). */}
      <View style={styles.spaced}>
        <SignInEmailsCard />
      </View>
      {/*
        The Macs, at the foot of the person they belong to. Drawn only when
        there is one. A machine grant can capture into private notes, so its
        Revoke has to stay reachable from the phone in somebody's hand.
      */}
      <View style={styles.spaced}>
        <MachinesCard />
      </View>

      {/*
        The two ways out, side by side. Sign-out ends a session; delete ends
        the account and is armed by two presses, so it can sit beside it.
      */}
      <View style={styles.ways}>
        <Button
          label="Sign out"
          disabled={onSignOut === undefined}
          onPress={onSignOut}
          testID="settings-sign-out"
        />
        {/* Absent in the demo, where there is no account to delete. */}
        {data.deleteAccount ? <DeleteAccountCard deleteAccount={data.deleteAccount} /> : null}
      </View>
      <Text variant="rowSub" style={styles.rowSub}>
        Signing out keeps everything, and the AI apps you connected keep working.
      </Text>
    </View>
  );
}

/**
 * AI apps: the ones holding a grant, one row each, and a button that opens
 * every client's own setup.
 *
 * Account-scoped: a connection reaches every workspace its person is a live
 * member of, so the address is the bare one, not a per-context URL.
 */
export function ConnectedAppsCard({
  data,
  onConnectAgent,
}: {
  data: ConsoleData;
  /** The full screen Claude/ChatGPT setup, where it can open. */
  onConnectAgent?: (agent: SetupAgent) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [picking, setPicking] = useState(false);
  const copy = useCopy(data.endpoint);
  const groups = groupClients(data.clients);

  return (
    <View>
      <Row style={styles.heading}>
        <Grow>
          <Text variant="eyebrow">AI apps</Text>
        </Grow>
        <Button
          label={picking ? "Done" : "Connect an app"}
          variant={picking ? "mini" : "accent"}
          onPress={() => setPicking((open) => !open)}
          accessibilityLabel={picking ? "Close the list of apps" : "Connect an app"}
          testID="connect-an-app"
        />
      </Row>

      {picking ? (
        <View style={styles.picker}>
          <ConnectClients
            endpoint={data.endpoint}
            clients={data.clients}
            onConnectAgent={onConnectAgent}
          />
        </View>
      ) : null}

      <Card>
        {groups.length === 0 ? (
          <Row>
            <Grow>
              <Text variant="rowSub">
                {data.loading ? "Loading…" : "No apps connected yet."}
              </Text>
            </Grow>
          </Row>
        ) : null}
        {/* One row per app, not per grant: see `grouped.ts`. */}
        {groups.map((group, index) => (
          <ClientGroupRow key={group.name} group={group} divided={index > 0} />
        ))}
      </Card>

      <Text variant="foot" style={styles.address}>
        {"Your address for any other app: "}
        <Text variant="mono" selectable testID="settings-endpoint">
          {data.endpoint}
        </Text>
        {"  "}
        <TextLink
          label={copy.label}
          accessibilityLabel="Copy your address"
          onPress={copy.copy}
        />
      </Text>
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    eyebrow: { marginBottom: space.x2 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    spaced: { marginTop: space.x3 },
    ways: { marginTop: space.x4, flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: space.x2 },
    heading: { marginBottom: space.x2 },
    picker: { marginBottom: space.x3 },
    address: { marginTop: space.x2 },
    rowSub: { marginTop: 2, maxWidth: 520 },
    foot: { marginTop: space.x3 },
  });


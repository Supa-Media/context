import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row, Grow } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ConnectClients } from "../clients/ConnectClients";
import { ClientRow } from "../clients/ClientRow";
import { DeleteAccountCard } from "./DeleteAccountCard";
import { atName } from "../format";
import type { ConsoleData } from "../types";
import { settingsSectionLabel, type SettingsSectionKey } from "./sections";
import { AppearancePanel } from "./panels/AppearancePanel";
import { DevicesPanel } from "./panels/DevicesPanel";

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
}: {
  section: SettingsSectionKey;
  data: ConsoleData;
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
    Whether this person has a brain of their own. An invited-only viewer is a
    first-class state — `identity.ts` exists partly to handle it — and for one,
    `viewer.name` is their sign-in email rather than a username.
  */
  const owned = data.contexts.some(
    (context) => context.kind === "personal" && context.role === "owner",
  );

  if (section === "apps") {
    return (
      <View>
        <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
          {settingsSectionLabel("apps")}
        </Text>
        <Text variant="paneSub" style={styles.sub}>
          One address, added once per app. A connection reaches every brain and
          workspace you are a live member of, and each app can be cut off on its own
          without touching the others.
        </Text>

        <Card>
          <Text variant="eyebrow" style={styles.eyebrow}>
            Your address
          </Text>
          <CopyField
            value={data.endpoint}
            label="Copy your address"
            testID="settings-endpoint"
          />
        </Card>

        {/*
          The same endpoint the one-click rows install, so the sentence above
          and the buttons below cannot disagree. `ConnectionsPane` computes a
          per-context URL for these; this section is account-scoped, where the
          bare address is the honest one — a connection reaches every context
          its person is a live member of, and the named URLs only choose where
          a client starts.
        */}
        <View style={styles.spaced}>
          <ConnectClients endpoint={data.endpoint} clients={data.clients} />
        </View>

        <Card style={styles.spaced}>
          <Row>
            <Grow>
              <Text variant="rowTitle">Connected</Text>
            </Grow>
            <Pill tone="neutral">{`${data.clients.length} active`}</Pill>
          </Row>
          {data.clients.length === 0 ? (
            <Row divided>
              <Grow>
                <Text variant="rowSub">
                  {data.loading
                    ? "Loading…"
                    : "No AI apps yet. Paste the address above into one and sign in."}
                </Text>
              </Grow>
            </Row>
          ) : null}
          {data.clients.map((client) => (
            <ClientRow key={client.id} client={client} />
          ))}
        </Card>
      </View>
    );
  }

  if (section === "profile") {
    return (
      <View>
        <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
          {settingsSectionLabel("profile")}
        </Text>
        <Text variant="paneSub" style={styles.sub}>
          {owned
            ? "Your username comes from one global namespace shared with workspace names — unique, stable, and reserved against interception, which is why it cannot be changed yet."
            : "You are signed in, and you have not made a brain of your own yet. Until you do, this is the address you signed in with rather than a username."}
        </Text>
        <Card>
          <Row>
            <Grow>
              <Text variant="rowTitle">{owned ? "Username" : "Signed in as"}</Text>
            </Grow>
            <Text variant="mono">{data.viewer.name}</Text>
          </Row>
          {/*
            Only where it is the address this person's own brain was issued.
            `viewerIdentity` substitutes a derived one when the open context is
            somebody else's, and a guess presented as a fact under the heading
            "Profile" is a stronger claim than the rail's account block has
            ever made.
          */}
          {owned && data.viewer.detail !== undefined ? (
            <Row divided>
              <Grow>
                <Text variant="rowTitle">Mail sent here</Text>
              </Grow>
              <Text variant="mono">{data.viewer.detail}</Text>
            </Row>
          ) : null}
        </Card>
        <Text variant="foot" style={styles.foot}>
          Only a personal brain has an address mail can be sent to. A workspace has
          none at all.
        </Text>
      </View>
    );
  }

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

  if (section === "devices") {
    return <DevicesPanel />;
  }

  if (section === "appearance") {
    return <AppearancePanel />;
  }

  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("account")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Both ask twice, and neither touches your notes.
      </Text>
      {/*
        Signing out sits above deletion, and it is here rather than only in the
        rail because "Danger zone" was the wrong name for a screen holding one
        button: somebody who wants to end a session searches for "sign out",
        and a search that lands them on a delete-only screen has aimed them at
        the wrong control. Two buttons, in the order of how often they are
        wanted, is safer than one button people arrive at by mistake.
      */}
      <Card style={styles.spaced}>
        <Row>
          <Grow>
            <Text variant="rowTitle">Sign out</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              Ends this session on this device. Everything stays exactly as it is, and
              the AI apps you connected keep working — they hold their own grants.
            </Text>
          </Grow>
          <Button
            label="Sign out"
            disabled={onSignOut === undefined}
            onPress={onSignOut}
            testID="settings-sign-out"
          />
        </Row>
      </Card>
      {/*
        The way all the way out, moved here from the Connections pane. It was
        beside "add a client", which is the opposite intention wearing the same
        card. Absent in the demo, where there is no account to delete.
      */}
      {data.deleteAccount ? (
        <View style={styles.spaced}>
          <DeleteAccountCard deleteAccount={data.deleteAccount} />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    eyebrow: { marginBottom: space.x2 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    spaced: { marginTop: space.x3 },
    rowSub: { marginTop: 2, maxWidth: 520 },
    foot: { marginTop: space.x3 },
  });

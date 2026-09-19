import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row, Grow } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ConnectClients } from "../clients/ConnectClients";
import { ClientGroupRow } from "../clients/ClientGroupRow";
import { groupClients } from "../clients/grouped";
import { DeleteAccountCard } from "./DeleteAccountCard";
import { atName } from "../format";
import type { ConsoleData } from "../types";
import { settingsSectionLabel, type SettingsSectionKey } from "./sections";
import { MachinesCard } from "./panels/MachinesCard";

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
    Whether this person has a workspace of their own. An invited-only viewer is a
    first-class state — `identity.ts` exists partly to handle it — and for one,
    `viewer.name` is their sign-in email rather than a username.
  */
  const owned = data.contexts.some(
    (context) => context.kind === "personal" && context.role === "owner",
  );

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
    Profile is the fall-through rather than another `if`, and that is a claim
    about the list as much as about this function: after Devices, Appearance
    and "Sign out & delete" folded into it, the account scope is AI apps, a
    conditional Invitations, and the screen about you. An unknown account key
    landing here lands on the person's own screen, which is the safe answer.
  */
  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("profile")}
        </Text>
        <Text variant="paneSub" style={styles.sub}>
          {owned
            ? "Your username comes from one global namespace shared with workspace names — unique, stable, and reserved against interception, which is why it cannot be changed yet."
            : "You are signed in, and you have not made a workspace of your own yet. Until you do, this is the address you signed in with rather than a username."}
        </Text>
        <Card>
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
                <Text variant="rowTitle">Mail sent here</Text>
              </Grow>
              <Text variant="mono">{data.viewer.detail}</Text>
            </Row>
          ) : null}
        </Card>
        <Text variant="foot" style={styles.foot}>
          Only a personal workspace has an address mail can be sent to. A shared one has
          none at all.
        </Text>
        {/*
          Appearance, which is now a fact rather than a control.

          It was three buttons — Light, Dark, Follow device — and the whole
          apparatus behind them: a stored choice, a module-level store to keep
          the panel and the provider agreeing, and a launch image held up on
          native until the device had answered. What it bought was a person
          pinning the app against their own system setting, which is not a
          thing anybody asked for and is one more row in a list already too
          long to scan. The row is gone and so is the machinery; this sentence
          is what is left, and it is true.
        */}
        <Card style={styles.spaced}>
          <Row>
            <Grow>
              <Text variant="rowTitle">Appearance</Text>
              <Text variant="rowSub" style={styles.rowSub}>
                Follows your device. Context is light when your phone or Mac is, and
                dark when it is.
              </Text>
            </Grow>
          </Row>
        </Card>
        {/*
          The Macs, at the foot of the person they belong to.

          "Your devices" was a row of its own in the index and is not one any
          more — but the row was never the point, the Revoke button was. A
          machine grant can capture into private notes, so somebody whose
          laptop is gone has to be able to cut it off from the phone in their
          hand, and this is the account-scoped screen they are already on.
        */}
        <View style={styles.spaced}>
          <MachinesCard />
        </View>
        {/*
          The two ways out, at the foot of the screen about the person they
          belong to.

          They were a section of their own — "Sign out & delete" — which is a
          row in the index for a pair of buttons somebody presses once or
          never, and it put the control that ends a *session* on the only
          screen that can end an *account*. Here they are under the identity
          they act on, in the order of how often they are wanted, and the row
          that used to hold them is gone from a list being cut to seven.
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
          The way all the way out. Absent in the demo, where there is no
          account to delete.
        */}
        {data.deleteAccount ? (
          <View style={styles.spaced}>
            <DeleteAccountCard deleteAccount={data.deleteAccount} />
          </View>
        ) : null}
      </View>
  );
}

/**
 * The AI apps holding a grant, and the address you paste into one.
 *
 * Extracted from the account scope, where it was a section of its own called
 * "AI apps", and drawn as the first block of Integrations — because that is
 * the word people arrive with. What a person wants from that screen is
 * everything that talks to this context without being typed into it, and an
 * MCP client is the first of those, not a different kind of thing.
 *
 * **It is still account-scoped and the copy still says so.** A connection
 * reaches every workspace its person is a live member of, so the address here
 * is the bare one rather than a per-context URL, and the sentence above it is
 * the one that was already there. Drawing an account-wide fact on a
 * context-scoped page is only a lie if the page keeps quiet about it.
 */
export function ConnectedAppsCard({ data }: { data: ConsoleData }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
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
        The same endpoint the one-click rows install, so the sentence above and
        the buttons below cannot disagree. `ConnectionsPane` computes a
        per-context URL for these; the bare address is the honest one here — a
        connection reaches every context its person is a live member of, and
        the named URLs only choose where a client starts.
      */}
      <View style={styles.spaced}>
        <ConnectClients endpoint={data.endpoint} clients={data.clients} />
      </View>

      <Card style={styles.spaced}>
        <Row>
          <Grow>
            <Text variant="rowTitle">Connected</Text>
          </Grow>
          {/*
            Both numbers, because they answer different questions: how many
            apps can reach this context, and how many separate grants they
            hold between them. One without the other is the number that
            surprises somebody.
          */}
          <Pill tone="neutral">
            {`${groupClients(data.clients).length} apps · ${data.clients.length} connections`}
          </Pill>
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
        {/*
          One row per app, not per grant. Every machine, browser profile and
          re-auth mints its own grant, so this list was seventeen rows on a
          real workspace with eight of them called Claude — see `grouped.ts`.
        */}
        {groupClients(data.clients).map((group) => (
          <ClientGroupRow key={group.name} group={group} />
        ))}
      </Card>
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

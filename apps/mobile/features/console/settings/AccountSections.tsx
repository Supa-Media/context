import { StyleSheet, View } from "react-native";
import { Card, Row, Grow } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ConnectClients } from "../clients/ConnectClients";
import { ClientRow } from "../clients/ClientRow";
import { DeleteAccountCard } from "./DeleteAccountCard";
import type { ConsoleData } from "../types";
import type { SettingsSectionKey } from "./sections";

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
}: {
  section: SettingsSectionKey;
  data: ConsoleData;
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
        <Text variant="eyebrow" style={styles.head}>
          AI apps
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
        <Text variant="eyebrow" style={styles.head}>
          Profile
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

  return (
    <View>
      <Text variant="eyebrow" style={styles.head}>
        Delete account
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        It asks twice, and it never touches your notes.
      </Text>
      {/*
        Signing out is deliberately not repeated here. Its control is one row
        away in the rail, immediately beside the gear that opened this — a
        second button for the same intention, on a screen about deletion, is
        how somebody presses the wrong one.
      */}
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
    foot: { marginTop: space.x3 },
  });

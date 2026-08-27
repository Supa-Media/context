import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Dot } from "../../design/components/Dot";
import { Hint } from "../../design/components/Field";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors } from "../../design/tokens";
import { MembersSection } from "../members/MembersSection";
import { PaneHead } from "../ConsoleShell";
import { selectedContext, type ConsoleClient, type ConsoleData } from "../types";

/**
 * Who and what can reach this context — the people, and the robots.
 *
 * App level, not per context: there is a single endpoint for the whole
 * account, and the list below spans every context you can reach. Each row says
 * which context let that client in, because that is what a grant hangs off —
 * see `ConsoleClient.context`. It is the same placement the constellation
 * draws.
 *
 * The endpoint and the grant list are both real: grants come from
 * `functions/grants.listGrants` and Revoke calls `revokeGrant`, which is why
 * the demo console omits the callback rather than rendering a button that
 * cannot do anything.
 *
 * `MembersSection` is mounted here because "who has access" is the question
 * this pane answers and there is no per-context settings view yet. It takes one
 * plain prop and imports nothing from the shell or the router, so moving it into
 * a context view when navigation is reshaped is a one-line change — do that
 * rather than copying it.
 */
export function ConnectionsPane({ data }: { data: ConsoleData }) {
  /*
    The members card below is the one per-context thing on an otherwise
    app-level pane, so the role it needs is the *selected* context's — not a
    property of this route. No chip goes in this pane's head for the same
    reason the switcher above it says "All contexts": a `team level only` badge
    on a heading that spans every context you can reach would be naming a scope
    the pane is not in.
  */
  const viewerRole = selectedContext(data)?.role;

  return (
    <View>
      <PaneHead
        title="Connections"
        description="One URL for every AI tool, across every context you can reach. Each client gets its own grant — revoking one leaves the others working."
      />

      <Card>
        <Text variant="eyebrow" style={styles.eyebrow}>
          Your endpoint
        </Text>
        <CopyField
          value={data.endpoint}
          label="Copy your MCP endpoint"
          testID="mcp-endpoint"
        />
        <Hint>
          <Text variant="hint">
            Paste this into any client&apos;s MCP settings and sign in.{" "}
            <Text variant="hint" style={styles.hintStrong}>
              Every client you add appears below
            </Text>{" "}
            and can be revoked on its own, without disturbing the others.
          </Text>
        </Hint>
      </Card>

      <Card style={styles.spaced}>
        <Row style={styles.clientsHead}>
          <Grow>
            <Text variant="rowTitle">Connected clients</Text>
          </Grow>
          <Pill tone="neutral">
            {`${data.clients.length} active`}
          </Pill>
        </Row>

        {data.clients.length === 0 ? (
          <Row divided>
            <Grow>
              <Text variant="rowSub">
                {data.loading
                  ? "Loading…"
                  : "No AI clients yet. Paste the endpoint above into a client and sign in."}
              </Text>
            </Grow>
          </Row>
        ) : null}

        {data.clients.map((client) => (
          <ClientRow key={client.id} client={client} />
        ))}
      </Card>

      <View style={styles.members}>
        <MembersSection view={data.members} viewerRole={viewerRole} />
      </View>
    </View>
  );
}

function ClientRow({ client }: { client: ConsoleClient }) {
  return (
    <Row divided>
      <Dot tone={client.status} />
      <Grow>
        <Text variant="rowTitle">{client.name}</Text>
        <Text variant="rowSub" style={styles.rowSub}>
          {/* Which context, then what it can do there. */}
          <Text variant="rowSub" style={styles.rowContext}>
            {client.context}
          </Text>
          {` · ${client.detail}`}
        </Text>
      </Grow>
      {/*
        Present in the demo but disabled: the mockup shows a Revoke on every
        row, and hiding it there would misrepresent the design — but a demo
        console must never offer a button that pretends to act.
      */}
      <Button
        label="Revoke"
        variant="danger"
        accessibilityLabel={`Revoke ${client.name}'s access to ${client.context}`}
        disabled={client.revoke === undefined}
        onPress={client.revoke}
      />
    </Row>
  );
}

const styles = StyleSheet.create({
  eyebrow: { marginBottom: 10 },
  spaced: { marginTop: 11 },
  clientsHead: { marginBottom: 13 },
  rowSub: { marginTop: 2 },
  rowContext: { color: colors.text2, fontWeight: "600" },
  hintStrong: { color: colors.hintStrong, fontWeight: "600" },
  members: { marginTop: 11 },
});

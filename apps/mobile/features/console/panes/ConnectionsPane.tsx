import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Hint } from "../../design/components/Field";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ClientRow } from "../clients/ClientRow";
import { ConnectClients } from "../clients/ConnectClients";
import { MembersSection } from "../members/MembersSection";
import { shareBackSuggestions } from "../members/members";
import { PaneHead } from "../ConsoleShell";
import { contextEndpoints } from "../endpoints";
import { selectedContext, type ConsoleData } from "../types";

/**
 * Who and what can reach this context — the people, and the robots.
 *
 * App level, not per context: the list below spans every context you can
 * reach, and each row says which context let that client in, because that is
 * what a grant hangs off — see `ConsoleClient.context`. It is the same
 * placement the constellation draws.
 *
 * The endpoint is app level in every sense now: the same URL for everyone, no
 * token in it, and one connection reaches every context its person belongs to.
 * The named `/@name/mcp` URLs are a starting point rather than a boundary — see
 * `../endpoints.ts` for what they are for and why one is refused rather than
 * guessed at.
 *
 * The endpoint and the grant list are both real: grants come from
 * `functions/grants.listGrants` and Revoke calls `revokeGrant`, which is why
 * the demo console omits the callback rather than rendering a button that
 * cannot do anything.
 *
 * `ConnectClients` follows the endpoint rather than replacing it. The endpoint
 * card answers "what is my URL"; the section under it answers "where does it go
 * in my client", which is the question that actually stops people — see
 * `clients/providers.ts`.
 *
 * `MembersSection` is mounted here because "who has access" is the question
 * this pane answers and there is no per-context settings view yet. It takes one
 * plain prop and imports nothing from the shell or the router, so moving it into
 * a context view when navigation is reshaped is a one-line change — do that
 * rather than copying it.
 */
export function ConnectionsPane({ data }: { data: ConsoleData }) {
  const styles = useThemedStyles(makeStyles);
  /*
    The members card below is the one per-context thing on an otherwise
    app-level pane, so the role it needs is the *selected* context's — not a
    property of this route. No chip goes in this pane's head for the same
    reason the switcher above it says "Your context": a `team level only` badge
    on a heading that spans everything this person can reach would be naming a
    scope the pane is not in.
  */
  const viewerRole = selectedContext(data)?.role;

  /*
    One URL reaches everything; the named ones only choose where a client
    starts.

    This card twice described a rule that had changed under it. It first said
    "one URL for every AI tool, across everything you can reach" while a grant
    covered exactly one context — false, and it stranded somebody invited into a
    brain whose agents could not open it. It was then rewritten to offer one URL
    per context and say a client wanted in two takes two, which was true for
    about a day: a grant now covers every context its person is a live member
    of, and a tool call addresses one by name.

    So the bare endpoint leads again, and it is the honest headline this time
    rather than the aspirational one. The named URLs stay, demoted to what they
    genuinely still do: pick the context a client works in when a call does not
    say. Somebody who spends their days in a brain shared with them connects
    there and never types a context name; the bare URL starts in the one they
    approved.
  */
  const perContext = contextEndpoints(data.endpoint, data.contexts);
  const named = perContext.length > 1 ? perContext : null;
  const selected = selectedContext(data);
  /*
    The connect rows build a deep link out of whatever endpoint they are given,
    so on a multi-context account they follow the context the console is
    showing — a one-click install that lands somewhere other than the context
    the person is looking at is the same surprise in a different place. It falls
    back to the bare endpoint, which is right for the account that has one
    context and honest for the deployment whose URL cannot carry a name.
  */
  const connectEndpoint =
    (selected === null
      ? null
      : perContext.find((row) => row.id === selected.id)?.url ?? null) ?? data.endpoint;

  return (
    <View style={styles.root}>
      <PaneHead
        title="Connections"
        description="One URL for every AI tool, across everything you can reach. Each client gets its own grant — revoking one leaves the others working."
      />

      <Card style={styles.endpointCard}>
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
            {named === null
              ? ""
              : " One connection reaches every context you belong to, with the access you have in each."}
          </Text>
        </Hint>

        {named === null ? null : (
          <View style={styles.startIn}>
            <Text variant="eyebrow" style={styles.eyebrow}>
              Or start it in a particular context
            </Text>
            {named.map((row) => (
              <View key={row.id} style={styles.endpointRow}>
                <Text variant="rowSub" style={styles.endpointName}>
                  {row.label}
                </Text>
                <CopyField
                  value={row.url}
                  label={`Copy the MCP endpoint for ${row.label}`}
                  testID={`mcp-endpoint-${row.id}`}
                />
              </View>
            ))}
            <Hint>
              <Text variant="hint">
                Same reach, different starting point: a client connected here works in that
                context when a request does not name another one.
              </Text>
            </Hint>
          </View>
        )}
      </Card>

      <View style={styles.spaced}>
        <ConnectClients endpoint={connectEndpoint} clients={data.clients} />
      </View>

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
        <MembersSection
          view={data.members}
          viewerRole={viewerRole}
          shareBackWith={shareBackSuggestions(data.contexts, data.members)}
        />
      </View>

      {/*
        Deleting the account is not offered here any more. It lives in the
        settings overlay's account scope (`settings/DeleteAccountCard.tsx`),
        which is where every other account-wide control now is — two live
        Delete buttons for one account, on two surfaces kept in step by hand,
        is the hazard the sibling comment used to argue against.
      */}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  root: {
    width: "100%",
    maxWidth: 1080,
    alignSelf: "center",
  },
  endpointCard: {
    paddingVertical: 20,
    paddingHorizontal: 22,
  },
  eyebrow: { marginBottom: 10 },
  startIn: { marginTop: 21 },
  endpointRow: { marginBottom: 12 },
  endpointName: { marginBottom: 4, color: colors.text2, fontWeight: "600" },
  spaced: { marginTop: 14 },
  clientsHead: { marginBottom: 13 },
  hintStrong: { color: colors.hintStrong, fontWeight: "600" },
  members: { marginTop: 14 },
});

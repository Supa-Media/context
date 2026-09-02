import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Dot } from "../../design/components/Dot";
import { Hint } from "../../design/components/Field";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ConnectClients } from "../clients/ConnectClients";
import { MembersSection } from "../members/MembersSection";
import { useArming } from "../useArming";
import { shareBackSuggestions } from "../members/members";
import { PaneHead } from "../ConsoleShell";
import { contextEndpoints } from "../endpoints";
import { selectedContext, type ConsoleClient, type ConsoleData } from "../types";

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
    <View>
      <PaneHead
        title="Connections"
        description="One URL for every AI tool, across everything you can reach. Each client gets its own grant — revoking one leaves the others working."
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
        The way all the way out. It lives on this pane because Connections is
        already the surface about access — who has it, which clients hold it —
        and deleting the account is revoking every one of those at once. Absent
        in the demo, where there is no account to delete.
      */}
      {data.deleteAccount ? <DeleteAccountCard deleteAccount={data.deleteAccount} /> : null}
    </View>
  );
}

/**
 * Deletion is two presses, the second one expires, and the copy says what it
 * does first.
 *
 * The lead is still the fact people fear getting wrong: notes in their own
 * storage are not ours to delete and stay where they are. What follows it are
 * two consequences the copy used to leave out, both of which reach other
 * people:
 *
 *  - **Every context you solely own is destroyed, even where editors and
 *    members remain.** `account.ts` states that edge deliberately — "an
 *    ownerless context has nobody who can rebind storage or revoke a grant,
 *    which is not a state to leave anybody in" — so somebody you invited loses
 *    access, and the old wording ("removes your … memberships") read as though
 *    only yours went.
 *  - **Your name is released**, and because ingestion is on the apex that
 *    includes your capture address: `you@context.lc` becomes claimable.
 *
 * The arming window is `useArming`'s, which expires. It was a bare `useState`
 * with no way back to `idle`, so an armed Delete stayed armed until something
 * pressed it.
 */
export function DeleteAccountCard({ deleteAccount }: { deleteAccount: () => Promise<void> }) {
  const styles = useThemedStyles(makeStyles);
  const arming = useArming(deleteAccount);
  return (
    <View style={styles.account}>
      <Text variant="eyebrow" style={styles.accountHead}>
        Account
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">Delete this account</Text>
            <Text variant="rowSub" style={styles.accountSub}>
              Notes in your own bucket or Dropbox stay exactly where they are — they
              are not ours to delete. What goes is everything Context knows: your
              contexts, storage connections, memberships and sign-in. Any context you
              are the only owner of is deleted with it, so people you invited lose
              access, and your name is released — including your capture address, which
              somebody else can then claim.
            </Text>
          </Grow>
          <Button
            label={
              arming.stage === "working"
                ? "Deleting…"
                : arming.stage === "armed"
                  ? "Press again to delete"
                  : "Delete account"
            }
            variant="danger"
            disabled={arming.stage === "working"}
            testID="delete-account"
            onPress={arming.press}
          />
        </Row>
      </Card>
    </View>
  );
}

/**
 * One connected client, and whose it is.
 *
 * A row that is not yours says so. Only a context's `owner` is shown anybody
 * else's grants at all — `functions/grants.listGrants` narrowed to that after
 * somebody invited into a personal brain found the owner's clients in their
 * own Settings — and what is left is the other half of the same confusion: in
 * a shared context the owner's list holds their colleagues' clients too, under
 * a heading that says every client *you* add appears below, on a card under
 * *your* endpoint. Unmarked, a colleague's Claude is indistinguishable from
 * one of your own, and Revoke beside it is a button that disconnects somebody
 * else's laptop without saying so.
 *
 * It does not name the person. `listGrants` returns a `userId` and no more, and
 * resolving it here would put "who uses which AI client" on a row that only
 * has to answer "is this mine".
 */
export function ClientRow({ client }: { client: ConsoleClient }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Row divided>
      <Dot tone={client.status} />
      <Grow>
        <Row style={styles.rowTitle}>
          <Text variant="rowTitle">{client.name}</Text>
          {client.mine ? null : <Pill tone="neutral">another member&apos;s</Pill>}
        </Row>
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
        accessibilityLabel={
          client.mine
            ? `Revoke ${client.name}'s access to ${client.context}`
            : `Revoke another member's ${client.name} access to ${client.context}`
        }
        disabled={client.revoke === undefined}
        onPress={client.revoke}
      />
    </Row>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  account: { marginTop: 18 },
  accountHead: { marginBottom: 8 },
  accountSub: { maxWidth: 520 },
  eyebrow: { marginBottom: 10 },
  startIn: { marginTop: 17 },
  endpointRow: { marginBottom: 9 },
  endpointName: { marginBottom: 4, color: colors.text2, fontWeight: "600" },
  spaced: { marginTop: 11 },
  clientsHead: { marginBottom: 13 },
  rowTitle: { gap: 8 },
  rowSub: { marginTop: 2 },
  rowContext: { color: colors.text2, fontWeight: "600" },
  hintStrong: { color: colors.hintStrong, fontWeight: "600" },
  members: { marginTop: 11 },
});

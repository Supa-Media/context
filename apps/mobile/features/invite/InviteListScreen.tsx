import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useConvexAuth, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Fact } from "../design/components/Fact";
import { FormError } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { clamp, leading } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { EMPTY_QUERY_SPEC } from "../console/querySpec";
import { CONSOLE_ROUTE } from "../auth/redirect";
import { WELCOME_ROUTE } from "../onboarding/route";
import { ContextOverview } from "../overview/ContextOverview";
import { DeadEnd, InvitePage, Title } from "./InviteScreen";
import {
  acceptanceLine,
  contextLabel,
  describeInviteFailure,
  invitationTerms,
  resolveInviteListView,
  type InvitationsResult,
  type InviteListDecision,
  type InviteListView,
  type PendingInvitation,
} from "./invite";

/**
 * `/invite` — every invitation addressed to this account.
 *
 * `needsOnboarding` sends an account with **zero contexts and at least one
 * pending invitation** here rather than to `/welcome`, because the invitation
 * is the reason that person opened the app at all and "claim your name" throws
 * the whole referral away. See `features/onboarding/route.ts`.
 *
 * Like `/invite/<token>` and `/authorize`, it is outside the `(app)` group and
 * owns its own auth gate — there is no token to preserve here, but the two
 * screens are one flow and a gate in two places that disagree is worse than a
 * gate written twice.
 */
export function InviteListScreen() {
  const styles = useThemedStyles(makeStyles);
  const auth = useConvexAuth();
  const router = useRouter();
  const [decision, setDecision] = useState<InviteListDecision>({ kind: "idle" });

  // A boolean dependency, with `api.…` reached inside the body: see
  // `console/querySpec.ts` for why anything else white-screens the page.
  const queries = useMemo<RequestForQueries>(() => {
    if (!auth.isAuthenticated) return EMPTY_QUERY_SPEC;
    return {
      invitations: { query: api.functions.invitations.listMyInvitations, args: {} },
    };
  }, [auth.isAuthenticated]);
  const results = useQueries(queries);
  const invitations = results.invitations as InvitationsResult;

  const accept = useMutation(api.functions.invitations.acceptInvitation);
  const decline = useMutation(api.functions.invitations.declineInvitation);

  const decide = useCallback(
    async (token: string, choice: "accept" | "decline") => {
      setDecision({ kind: "submitting", token, choice });
      try {
        if (choice === "accept") {
          const joined = await accept({ token });
          setDecision({ kind: "accepted", slug: joined.slug });
        } else {
          await decline({ token });
          // No `declined` state: the row leaves the live subscription, the list
          // shrinks under them, and the last decline lands on the empty view,
          // which already knows how not to strand somebody.
          setDecision({ kind: "idle" });
        }
      } catch (error) {
        setDecision({ kind: "idle", error: describeInviteFailure(error, choice) });
      }
    },
    [accept, decline],
  );

  const view = resolveInviteListView({ auth, invitations, decision, now: Date.now() });

  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;
  if (view.kind === "joined") return <Redirect href={view.href} />;

  return (
    <InvitePage testID="invite-list-page">
      <InviteListBody
        view={view}
        now={Date.now()}
        onDecide={decide}
        onLeaveForConsole={() => router.replace(CONSOLE_ROUTE)}
        onLeaveForWelcome={() => router.replace(WELCOME_ROUTE)}
      />
    </InvitePage>
  );
}

/** The list's body, given an already-resolved view. Exported so tests can mount it. */
export function InviteListBody({
  view,
  now,
  onDecide,
  onLeaveForConsole,
  onLeaveForWelcome,
}: {
  view: InviteListView;
  now: number;
  onDecide: (token: string, choice: "accept" | "decline") => void;
  onLeaveForConsole: () => void;
  onLeaveForWelcome: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);

  switch (view.kind) {
    case "wait":
    case "signIn":
    case "joined":
      return null;

    case "loading":
      return (
        <Card>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">Checking your invitations…</Text>
          </View>
        </Card>
      );

    case "unavailable":
      return (
        <DeadEnd
          titleSize={titleSize}
          headline="We couldn't check your invitations"
          detail="Something went wrong reading them, not with any link you were sent. Reload the page, or open the link from your email again."
          onLeaveForConsole={onLeaveForConsole}
          onLeaveForWelcome={onLeaveForWelcome}
          testID="invite-list-unavailable"
        />
      );

    case "empty":
      // Not a blank list. Somebody arriving here was sent by the app's own
      // gate because they had an invitation a moment ago, so the honest
      // sentence is "there is nothing here now" plus a way on — and both ways
      // on resolve themselves for whatever this account turns out to have.
      return (
        <DeadEnd
          titleSize={titleSize}
          headline="Nothing to answer"
          detail="You have no invitations waiting. If you just accepted or declined one in another tab, that was it — and if somebody told you they invited you, ask them to send it again."
          onLeaveForConsole={onLeaveForConsole}
          onLeaveForWelcome={onLeaveForWelcome}
          testID="invite-list-empty"
        />
      );

    case "list":
      return (
        <>
          <Title size={titleSize}>
            {view.invitations.length === 1
              ? "You've been invited to a context"
              : "You've been invited to these contexts"}
          </Title>
          <Text variant="heroSub" style={styles.sub}>
            Accepting puts a context in your console alongside your own. Declining shares
            nothing and spends the link.
          </Text>

          {view.error ? (
            <FormError
              headline={view.error.headline}
              next={view.error.next}
              style={styles.error}
            />
          ) : null}

          <View style={styles.rows} role="list">
            {view.invitations.map((invitation) => (
              <InvitationRow
                key={invitation.token}
                invitation={invitation}
                now={now}
                busy={view.busy?.token === invitation.token ? view.busy.choice : null}
                // Any row being answered disables every row: two mutations in
                // flight would race one `decision`, and the second answer would
                // silently overwrite the first one's outcome.
                disabled={view.busy !== null}
                onDecide={onDecide}
              />
            ))}
          </View>

          <ContextOverview style={styles.overview} />
        </>
      );
  }
}

function InvitationRow({
  invitation,
  now,
  busy,
  disabled,
  onDecide,
}: {
  invitation: PendingInvitation;
  now: number;
  busy: null | "accept" | "decline";
  disabled: boolean;
  onDecide: (token: string, choice: "accept" | "decline") => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const label = contextLabel(invitation);

  return (
    <View role="listitem">
      <Card style={styles.row}>
        <Fact title="The context" body={label} />
        <Fact title="Your role" body={acceptanceLine(invitation.role)} />
        <Fact title="This link" body={invitationTerms(invitation, now)} />
        <View style={styles.decisions}>
          <Button
            label={busy === "decline" ? "Declining…" : "Decline"}
            variant="decision"
            style={styles.decision}
            disabled={disabled}
            accessibilityLabel={`Decline the invitation to ${label}`}
            onPress={() => onDecide(invitation.token, "decline")}
            trailing={
              busy === "decline" ? <ActivityIndicator color={colors.text} size="small" /> : null
            }
            testID={`invite-decline-${invitation.token}`}
          />
          <Button
            label={busy === "accept" ? "Accepting…" : "Accept"}
            variant="decision"
            style={styles.decision}
            disabled={disabled}
            accessibilityLabel={`Accept the invitation to ${label}`}
            onPress={() => onDecide(invitation.token, "accept")}
            trailing={
              busy === "accept" ? <ActivityIndicator color={colors.text} size="small" /> : null
            }
            testID={`invite-accept-${invitation.token}`}
          />
        </View>
      </Card>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
  sub: { marginTop: 14, fontSize: 15.5, lineHeight: leading(15.5, 1.55) },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  error: { marginTop: 14 },
  rows: { marginTop: 26, gap: 14 },
  row: { gap: 13 },
  overview: { marginTop: 26 },
  decisions: { marginTop: 6, flexDirection: "row", gap: 12 },
  decision: { flex: 1, alignSelf: "auto" },
});

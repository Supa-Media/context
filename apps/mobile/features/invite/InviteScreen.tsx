import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useConvexAuth, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { Fact } from "../design/components/Fact";
import { FormError } from "../design/components/Input";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { clamp, colors, fonts, leading, tracking } from "../design/tokens";
import { EMPTY_QUERY_SPEC } from "../console/querySpec";
import { CONSOLE_ROUTE } from "../auth/redirect";
import { WELCOME_ROUTE } from "../onboarding/route";
import { ContextOverview } from "../overview/ContextOverview";
import {
  acceptanceLine,
  contextLabel,
  describeInviteFailure,
  firstParam,
  invitationLede,
  invitationTerms,
  invitationTitle,
  resolveInviteView,
  type InvitationsResult,
  type InviteDecision,
  type InviteView,
} from "./invite";

/**
 * `/invite/<token>` — the link a stranger clicks in their email.
 *
 * Deliberately **not** under the `(app)` group, for exactly the reason
 * `/authorize` is not: that group's gate bounces a signed-out visitor to a bare
 * `/login`, and the token in this URL exists in one email and nowhere else. A
 * rail has no entry for a context you have not accepted yet, so losing the
 * token loses the invitation. This screen owns its own gate so it can send
 * people to `/login?next=/invite/<token>` and bring them back.
 *
 * The emailed URL may also carry `?code=`, which `ConvexAuthProvider` consumes
 * and strips before this ever renders. Nothing here reads it; `firstParam` is
 * still how the path segment is read, because a duplicated segment arrives as
 * an array and a bare string assumption is how that becomes a crash.
 *
 * Which view to show is `resolveInviteView`, a pure function, and that is what
 * the tests exercise. In particular: **every dead token reads the same**, and
 * `invite.ts` explains why the backend refuses to tell them apart.
 */
export function InviteScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = firstParam(params.token);
  const auth = useConvexAuth();
  const router = useRouter();

  const [decision, setDecision] = useState<InviteDecision>({ kind: "idle" });

  // The shared constant while signed out, and `api.…` reached inside the memo
  // body with only a boolean in the dependency array. `api` is a proxy that
  // returns a new object on every access, so listing it would make this spec
  // unstable and set state during render — see `console/querySpec.ts`.
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
    async (choice: "accept" | "decline") => {
      if (token === null) return;
      setDecision({ kind: "submitting", choice });
      try {
        if (choice === "accept") {
          // The slug comes back from the mutation rather than from the row we
          // rendered: `acceptInvitation` is what decides which context was
          // joined, and it is allowed to disagree with a list that has since
          // gone stale.
          const joined = await accept({ token });
          setDecision({ kind: "accepted", slug: joined.slug });
        } else {
          await decline({ token });
          setDecision({ kind: "declined" });
        }
      } catch (error) {
        setDecision({ kind: "idle", error: describeInviteFailure(error, choice) });
      }
    },
    [accept, decline, token],
  );

  const view = resolveInviteView({ token, auth, invitations, decision, now: Date.now() });

  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;
  // Accepted. Straight into the context they just joined — the whole point of
  // the link, and the one place in this flow with an obvious next screen.
  if (view.kind === "joined") return <Redirect href={view.href} />;

  return (
    <InvitePage testID="invite-page">
      <InviteBody
        view={view}
        now={Date.now()}
        onDecide={decide}
        onLeaveForConsole={() => router.replace(CONSOLE_ROUTE)}
        onLeaveForWelcome={() => router.replace(WELCOME_ROUTE)}
      />
    </InvitePage>
  );
}

/**
 * The chrome both invitation screens sit in: one dark ground, the wordmark, and
 * a column that centres on a tall window and scrolls on a short one.
 *
 * `CenteredScroll` is not optional here for the reason it is not optional on
 * the consent screen. This body runs well past 900px once the overview is on
 * it, and the window it lands in is often a 390x700 phone somebody opened an
 * email in — centred inside a clipped flex box, Accept and Decline would be
 * off the bottom of the screen with nothing to scroll.
 */
export function InvitePage({
  children,
  testID,
}: {
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.ground}>
      <StageBackdrop />
      <CenteredScroll testID={testID}>
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          {children}
        </View>
      </CenteredScroll>
    </View>
  );
}

/**
 * The screen's body, given an already-resolved view.
 *
 * Exported for the same reason `ConsentBody` is: every state this can be in —
 * including the ones that need a spent token or a backend that threw — can then
 * be rendered and read without a Convex client, a session, or an invitation.
 */
export function InviteBody({
  view,
  now,
  onDecide,
  onLeaveForConsole,
  onLeaveForWelcome,
}: {
  view: InviteView;
  now: number;
  onDecide: (choice: "accept" | "decline") => void;
  onLeaveForConsole: () => void;
  onLeaveForWelcome: () => void;
}) {
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
            <Text variant="rowSub">Checking this invitation…</Text>
          </View>
        </Card>
      );

    case "unavailable":
      // Not `dead`. The list failed to load, which says nothing at all about
      // this token, and telling somebody their emailed link is spent when it
      // is not is a mistake they cannot undo.
      return (
        <DeadEnd
          titleSize={titleSize}
          headline="We couldn't check this invitation"
          detail="Something went wrong reading your invitations, not with the link. Reload the page, or open it again from your email."
          onLeaveForConsole={onLeaveForConsole}
          onLeaveForWelcome={onLeaveForWelcome}
          testID="invite-unavailable"
        />
      );

    case "dead":
      return (
        <DeadEnd
          titleSize={titleSize}
          headline={view.headline}
          detail={view.detail}
          onLeaveForConsole={onLeaveForConsole}
          onLeaveForWelcome={onLeaveForWelcome}
          testID="invite-dead"
        />
      );

    case "declined":
      return (
        <DeadEnd
          titleSize={titleSize}
          headline="Declined"
          detail="Nothing was shared, and the link is spent. Whoever invited you sees only that it is no longer outstanding."
          onLeaveForConsole={onLeaveForConsole}
          onLeaveForWelcome={onLeaveForWelcome}
          testID="invite-declined"
        />
      );

    case "ready":
      return (
        <ReadyBody
          view={view}
          now={now}
          titleSize={titleSize}
          onDecide={onDecide}
        />
      );
  }
}

function ReadyBody({
  view,
  now,
  titleSize,
  onDecide,
}: {
  view: Extract<InviteView, { kind: "ready" }>;
  now: number;
  titleSize: number;
  onDecide: (choice: "accept" | "decline") => void;
}) {
  const invitation = view.invitation;

  return (
    <>
      <Title size={titleSize}>{invitationTitle(invitation)}</Title>
      <Text variant="heroSub" style={styles.sub}>
        {invitationLede(invitation)}
      </Text>

      <Card style={styles.card}>
        <Fact title="The context" body={contextLabel(invitation)} />
        <Fact title="Your role" body={acceptanceLine(invitation.role)} testID="invite-role" />
        <Fact
          title="This link"
          body={invitationTerms(invitation, now)}
          testID="invite-terms"
        />
      </Card>

      {/*
        The overview sits here, between what is being offered and the decision
        about it. This is the one moment somebody who has never used Context
        will read six lines about what it is — after they know why they are
        being asked, and before they answer.
      */}
      <ContextOverview style={styles.overview} />

      {view.error ? (
        <FormError headline={view.error.headline} next={view.error.next} style={styles.error} />
      ) : null}

      {/*
        One shape used twice, like Approve and Deny on the consent screen.
        Declining an invitation is a legitimate answer, not a failure, and a
        quieter, greyer control for it would be a dark pattern whatever the
        copy says.
      */}
      <View style={styles.decisions}>
        <Button
          label={view.busy === "decline" ? "Declining…" : "Decline"}
          variant="decision"
          style={styles.decision}
          disabled={view.busy !== null}
          accessibilityLabel={`Decline the invitation to ${contextLabel(invitation)}`}
          onPress={() => onDecide("decline")}
          trailing={
            view.busy === "decline" ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : null
          }
          testID="invite-decline"
        />
        <Button
          label={view.busy === "accept" ? "Accepting…" : "Accept"}
          variant="decision"
          style={styles.decision}
          disabled={view.busy !== null}
          accessibilityLabel={`Accept the invitation to ${contextLabel(invitation)}`}
          onPress={() => onDecide("accept")}
          trailing={
            view.busy === "accept" ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : null
          }
          testID="invite-accept"
        />
      </View>
    </>
  );
}

/**
 * Every state with nothing left to decide, and two ways on.
 *
 * Both destinations answer for themselves, which is what keeps this honest for
 * an account we know nothing about: `/console` sends somebody with no contexts
 * to `/welcome`, and `/welcome` sends somebody who already owns one to the
 * console. Neither button can strand anybody.
 */
export function DeadEnd({
  titleSize,
  headline,
  detail,
  onLeaveForConsole,
  onLeaveForWelcome,
  testID,
}: {
  titleSize: number;
  headline: string;
  detail: string;
  onLeaveForConsole: () => void;
  onLeaveForWelcome: () => void;
  testID?: string;
}) {
  return (
    <View testID={testID}>
      <Title size={titleSize}>{headline}</Title>
      <Text variant="heroSub" style={styles.sub}>
        {detail}
      </Text>
      <View style={styles.deadEndActions}>
        <Button
          label="Set up your own brain"
          variant="decision"
          onPress={onLeaveForWelcome}
          testID="invite-welcome"
        />
        <Button
          label="Go to your console"
          variant="ghost"
          style={styles.deadEndGhost}
          onPress={onLeaveForConsole}
          testID="invite-console"
        />
      </View>
    </View>
  );
}

/**
 * The heading's type, as a style array.
 *
 * A function rather than a `StyleSheet` entry because the size is clamped
 * against the window width, and `tracking()` and `leading()` derive from it —
 * so neither can be pre-baked. Same shape as the consent screen's `Title`.
 */
export function Title({ size, children }: { size: number; children: ReactNode }) {
  return (
    <Text
      role="heading"
      aria-level={1}
      style={[
        styles.title,
        { fontSize: size, lineHeight: leading(size, 1.08), letterSpacing: tracking(size, -0.03) },
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
  wrap: {
    width: "100%",
    maxWidth: 560,
    marginHorizontal: "auto",
    paddingHorizontal: 28,
    paddingVertical: 48,
  },
  mark: { alignSelf: "flex-start", marginBottom: 30 },
  markSuffix: { color: colors.muted },
  title: { fontFamily: fonts.display, fontWeight: "500", color: colors.text },
  sub: { marginTop: 14, fontSize: 15.5, lineHeight: leading(15.5, 1.55) },

  card: { marginTop: 26, gap: 13 },
  overview: { marginTop: 26 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },

  error: { marginTop: 14 },

  decisions: { marginTop: 20, flexDirection: "row", gap: 12 },
  // Both halves flex identically, so neither is the wider, more obvious click.
  decision: { flex: 1, alignSelf: "auto" },

  deadEndActions: {
    marginTop: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
  },
  // `Button`'s base style sets `alignSelf: "flex-start"`, which beats the row's
  // `alignItems: "center"`.
  deadEndGhost: { alignSelf: "center" },
});

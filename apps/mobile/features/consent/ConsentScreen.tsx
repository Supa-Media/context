import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  View,
  useWindowDimensions,
  type TextStyle,
} from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useAction, useConvexAuth, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { ChoiceGroup, FormError, ToggleGroup } from "../design/components/Input";
import { Pill } from "../design/components/Pill";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { clamp, fonts, leading, radii, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { atName } from "../console/format";
import { EMPTY_QUERY_SPEC } from "../console/querySpec";
import { CONSOLE_ROUTE, LANDING_ROUTE } from "../auth/redirect";
import { leaveTo } from "./leave";
import { isSafeRedirect } from "./redirectSafety";
import type { GrantableTier, ScopeLine } from "./scopes";
import {
  describeDecisionFailure,
  resolveConsentView,
  toggleScopeSelection,
  type AuthorizationRequest,
  type ConsentContext,
  type ConsentDecision,
  type ConsentView,
  type RequestResult,
} from "./state";

/**
 * `/authorize?request_id=…` — the screen an AI client's OAuth flow lands on.
 *
 * The gateway parks a validated authorization request and 302s the browser
 * here. Until someone approves on this screen no authorization code exists, so
 * this is not a nicety on top of sign-in — it is the step that makes sign-in
 * mean anything.
 *
 * It is a security surface, and it is built like one:
 *
 *  - Approve and Deny are the **same control**, twice. See `ButtonVariant`.
 *  - Nothing arrives pre-decided. No default action, no focused Approve, no
 *    timer that acts for you.
 *  - Scopes are sentences, from `scopes.ts`, and an unrecognised scope is shown
 *    as unrecognised rather than dropped.
 *  - Every unusable request — expired, spent, someone else's, never real —
 *    reads the same. `state.ts` explains why that matters.
 *
 * The component is deliberately thin: *which* view to show is
 * `resolveConsentView`, a pure function, and that is what the tests exercise.
 */
export function ConsentScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ request_id?: string | string[] }>();
  const requestId = firstParam(params.request_id);
  const auth = useConvexAuth();
  const router = useRouter();

  const [chosenContextId, setChosenContextId] = useState<string | null>(null);
  // `null` until the person touches the list: untouched means "whatever the
  // client asked for that I can hand over", which is not the same as an empty
  // selection. `resolveConsentView` is where that distinction is spelled out.
  const [chosenScopes, setChosenScopes] = useState<readonly string[] | null>(null);
  const [chosenTier, setChosenTier] = useState<GrantableTier | null>(null);
  const [decision, setDecision] = useState<ConsentDecision>({ kind: "idle" });

  // `useQueries` rather than `useQuery` on purpose. `useQuery` re-throws a
  // failed query into the render, and `getAuthorizationRequest` throws
  // `NO_GRANTABLE_WORKSPACE` for an account with nowhere to grant access to —
  // which is a screen of its own, not an error boundary. `useQueries` hands the
  // error back as a value so `resolveConsentView` can decide what it means.
  //
  // Neither query is issued without a session: an unauthenticated visitor must
  // not be able to probe a `request_id` at all.
  const queries = useMemo<RequestForQueries>(() => {
    // The shared constant, not a fresh `{}`: an unstable spec makes
    // `useSubscription` set state during render, and this screen going blank is
    // an OAuth approval nobody can complete. See `console/querySpec.ts`.
    if (!auth.isAuthenticated) return EMPTY_QUERY_SPEC;
    const spec: RequestForQueries = {
      workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} },
    };
    if (requestId !== null) {
      spec.request = {
        query: api.functions.authorizations.getAuthorizationRequest,
        args: { requestId },
      };
    }
    return spec;
  }, [auth.isAuthenticated, requestId]);

  const results = useQueries(queries);

  const request = results.request as RequestResult;
  const workspaces = results.workspaces as
    | ReadonlyArray<{ workspaceId: string; slug: string; role: string }>
    | Error
    | undefined;

  const contexts: ConsentContext[] | undefined =
    workspaces === undefined || workspaces instanceof Error
      ? undefined
      : workspaces.map((workspace) => ({
          id: workspace.workspaceId,
          slug: workspace.slug,
          role: workspace.role,
        }));

  const approve = useAction(api.functions.authorizations.approveAuthorization);
  const deny = useAction(api.functions.authorizations.denyAuthorization);

  const decide = useCallback(
    async (
      choice: "approve" | "deny",
      workspaceId: string | null,
      grantedScopes: string[],
    ) => {
      if (requestId === null) return;
      setDecision({ kind: "submitting", choice });
      try {
        const result =
          choice === "approve"
            ? await approve({
                requestId,
                // Omitted rather than sent as null when nothing is selected:
                // `workspaceId` is optional and the backend resolves its own
                // default. In practice `canApprove` means this is always set.
                ...(workspaceId === null
                  ? {}
                  : { workspaceId: workspaceId as Id<"workspaces"> }),
                // Sent always, including when nothing was narrowed. Omitting it
                // for the untouched case would mean the one path most people
                // take is the one path that does not say what it granted, and
                // "the default is whatever the backend decides" is how a
                // default quietly becomes the widest thing again.
                grantedScopes,
              })
            : await deny({ requestId });

        // `leaveTo` refuses a target it will not navigate to, and it refuses
        // *silently* — which would strand someone on "sending you back…"
        // forever. Check the same thing here so there is a screen to land on,
        // with the offending URL in it.
        if (!isSafeRedirect(result.redirectTo)) {
          setDecision({
            kind: "idle",
            error: {
              headline:
                choice === "approve"
                  ? "Approved, but this app's return address looks wrong"
                  : "Refused, but this app's return address looks wrong",
              next: `We won't send you to ${result.redirectTo}. Go back to the app and connect again.`,
            },
          });
          return;
        }

        setDecision({ kind: "leaving", choice, redirectTo: result.redirectTo });
        leaveTo(result.redirectTo);
      } catch (error) {
        setDecision({ kind: "idle", error: describeDecisionFailure(error, choice) });
      }
    },
    [approve, deny, requestId],
  );

  const view = resolveConsentView({
    requestId,
    auth,
    request,
    contexts,
    chosenContextId,
    chosenScopes,
    chosenTier,
    decision,
    now: Date.now(),
  });

  // Toggling one row rewrites the whole list, because the first toggle is also
  // what turns "untouched" into an explicit set. The derivation lives in
  // `state.ts` so it is reachable from a test without a Convex client.
  const toggleScope = useCallback(
    (scope: string, next: boolean) => {
      if (view.kind !== "ready") return;
      setChosenScopes(toggleScopeSelection(view.scopeChoices, scope, next));
    },
    [view],
  );

  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;

  return (
    <View style={styles.ground}>
      <StageBackdrop />
      {/*
        Scrollable, and not optional. This body runs 700–900px with a context
        chooser and a few scope lines, and the browser it lands in is often a
        390×700 phone that an AI client redirected somebody to. Centred inside a
        clipped flex box, Approve and Deny were simply off the screen with
        nothing to scroll — the OAuth flow could not be finished on a phone at
        all. See `CenteredScroll`.
      */}
      <CenteredScroll testID="consent-page">
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          <ConsentBody
            view={view}
            onChooseContext={(id) => {
              // A different context can mean a different role, so the tier and
              // the tick list stop meaning what they meant. Clearing them
              // re-derives both from the new context instead of carrying a
              // stale choice across — the backend would clamp it anyway, and a
              // screen showing a promise the backend is about to break is the
              // failure this whole feature exists to fix.
              setChosenContextId(id);
              setChosenScopes(null);
              setChosenTier(null);
            }}
            onToggleScope={toggleScope}
            onChooseTier={setChosenTier}
            onDecide={decide}
            onLeaveForConsole={() => router.replace(CONSOLE_ROUTE)}
            onLeaveForHome={() => router.replace(LANDING_ROUTE)}
          />
        </View>
      </CenteredScroll>
    </View>
  );
}

/**
 * The screen's body, given an already-resolved view.
 *
 * Exported for the same reason `ConsoleShell` takes a `ConsoleData` and nothing
 * else: every state this can be in — including the ones that need an expired
 * request or a backend that threw — can then be rendered and looked at without
 * a Convex client, a session, or a parked authorization request.
 */
export function ConsentBody({
  view,
  onChooseContext,
  onToggleScope,
  onChooseTier,
  onDecide,
  onLeaveForConsole,
  onLeaveForHome,
}: {
  view: ConsentView;
  onChooseContext: (id: string) => void;
  onToggleScope: (scope: string, next: boolean) => void;
  onChooseTier: (tier: GrantableTier) => void;
  onDecide: (
    choice: "approve" | "deny",
    workspaceId: string | null,
    grantedScopes: string[],
  ) => void;
  onLeaveForConsole: () => void;
  onLeaveForHome: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);

  switch (view.kind) {
    case "wait":
    case "signIn":
      return null;

    case "loading":
      return (
        <Card style={styles.card}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">Checking this request…</Text>
          </View>
        </Card>
      );

    case "invalid":
      return (
        <>
          <Title size={titleSize}>{view.headline}</Title>
          <Text variant="heroSub" style={styles.sub}>
            {view.detail}
          </Text>
          <View style={styles.deadEndActions}>
            <Button label="Go to your console" variant="decision" onPress={onLeaveForConsole} />
            <Button
              label="Back to Context.lc"
              variant="ghost"
              style={styles.deadEndGhost}
              onPress={onLeaveForHome}
            />
          </View>
        </>
      );

    case "noContext": {
      const who = view.clientName ?? "That app";
      return (
        <>
          <Title size={titleSize}>You don&apos;t have a brain yet</Title>
          <Text variant="heroSub" style={styles.sub}>
            {who} is asking for access, and this account has nothing to share yet.
            Connect a bucket you already own, then ask the app to connect again.
          </Text>
          <View style={styles.deadEndActions}>
            <Button label="Set up your brain" variant="decision" onPress={onLeaveForConsole} />
            <Button
              label="Back to Context.lc"
              variant="ghost"
              style={styles.deadEndGhost}
              onPress={onLeaveForHome}
            />
          </View>
        </>
      );
    }

    case "leaving":
      return (
        <Card style={styles.card}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">
              {view.choice === "approve"
                ? "Approved. Sending you back to the app…"
                : "Refused. Sending you back to the app…"}
            </Text>
          </View>
          <Text variant="foot" style={styles.leavingFoot} selectable>
            {view.redirectTo}
          </Text>
        </Card>
      );

    case "ready":
      return (
        <ReadyBody
          view={view}
          titleSize={titleSize}
          onChooseContext={onChooseContext}
          onToggleScope={onToggleScope}
          onChooseTier={onChooseTier}
          onDecide={onDecide}
        />
      );
  }
}

function ReadyBody({
  view,
  titleSize,
  onChooseContext,
  onToggleScope,
  onChooseTier,
  onDecide,
}: {
  view: Extract<ConsentView, { kind: "ready" }>;
  titleSize: number;
  onChooseContext: (id: string) => void;
  onToggleScope: (scope: string, next: boolean) => void;
  onChooseTier: (tier: GrantableTier) => void;
  onDecide: (
    choice: "approve" | "deny",
    workspaceId: string | null,
    grantedScopes: string[],
  ) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const selected = view.contexts.find((context) => context.id === view.selectedContextId) ?? null;

  return (
    <>
      <Title size={titleSize}>
        {/*
          The nested span carries the *same* type styles as the heading, only
          recoloured. A bare <Text> here would fall back to the 15px body
          variant and render the client's name smaller than the sentence it
          sits in — which is backwards, since the name is the fact the whole
          screen turns on.
        */}
        <Text style={[...titleStyle(styles, titleSize), styles.titleClient]}>{view.clientName}</Text>
        {" wants access to your context"}
      </Title>

      <Text variant="heroSub" style={styles.sub}>
        Approving sends it back to{" "}
        <Text variant="heroSub" style={styles.subStrong}>
          {view.redirectHost}
        </Text>
        . Nothing is shared until you choose, and you can end this from Connections whenever
        you like.
      </Text>

      <Card style={styles.card}>
        {view.contextIsAChoice ? (
          <ChoiceGroup
            label="Which context"
            hint="Only the one you pick becomes reachable. The others stay invisible to this client."
            options={view.contexts.map((context) => ({
              value: context.id,
              label: atName(context.slug),
              detail: `you are ${context.role}`,
            }))}
            value={view.selectedContextId}
            onChange={onChooseContext}
            disabled={view.busy !== null}
            testID="consent-context"
          />
        ) : (
          <View>
            <Text variant="eyebrow">Which context</Text>
            <View style={styles.singleContext} testID="consent-context-single">
              <Text variant="rowTitle">{atName(selected?.slug ?? "")}</Text>
              <Pill tone="neutral">{selected?.role ?? ""}</Pill>
            </View>
          </View>
        )}

        <View style={styles.rule} aria-hidden />

        {view.scopeChoices.length === 0 ? (
          <View>
            <Text variant="eyebrow">What it would be able to do</Text>
            <Text variant="rowSub" style={styles.emptyScopes}>
              {view.withheldScopes.length === 0
                ? "This client asked for no particular access. Approving grants it nothing beyond knowing the connection exists."
                : "Nothing this client asked for is yours to hand over in this context. Pick one you own, or ask its owner."}
            </Text>
          </View>
        ) : (
          <ToggleGroup
            label="What it would be able to do"
            hint="Untick anything you would rather not hand over. Only what is ticked is granted."
            options={view.scopeChoices.map((choice) => ({
              value: choice.scope,
              label: choice.line.sentence,
              detail: choice.line.detail,
              on: choice.granted,
            }))}
            onToggle={onToggleScope}
            disabled={view.busy !== null}
            testID="consent-scope"
          />
        )}

        {view.withheldScopes.length > 0 ? (
          <View style={styles.withheld}>
            <Text variant="rowSub">
              {view.withheldScopes.length === 1
                ? "This client also asked for something you cannot grant here, so it will not be:"
                : "This client also asked for things you cannot grant here, so they will not be:"}
            </Text>
            <View style={styles.withheldList} role="list">
              {view.withheldScopes.map((choice) => (
                <WithheldRow key={choice.scope} line={choice.line} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.rule} aria-hidden />

        {view.tier.isAChoice ? (
          <ChoiceGroup
            label="How much of this context it sees"
            hint="You can hand over the whole context, or keep anything you marked private out of it."
            options={view.tier.options.map((option) => ({
              value: option.value,
              label: option.label,
              detail: option.detail,
            }))}
            value={view.tier.selected === "unknown" ? null : view.tier.selected}
            onChange={onChooseTier}
            disabled={view.busy !== null}
            testID="consent-tier"
          />
        ) : (
          <View>
            <Text variant="eyebrow">How much of this context it sees</Text>
            <Text variant="rowSub" style={styles.tierStatement} testID="consent-tier-single">
              {tierStatement(view)}
            </Text>
          </View>
        )}

        <Text variant="foot" style={styles.storageNote}>
          Your notes stay in your own bucket. This grants an app the right to read and write
          through Context — it does not move a file, and revoking it stops access immediately.
        </Text>
      </Card>

      {view.error ? (
        <FormError headline={view.error.headline} next={view.error.next} style={styles.error} />
      ) : null}

      <View style={styles.decisions}>
        <Button
          label={view.busy === "deny" ? "Refusing…" : "Deny"}
          variant="decision"
          style={styles.decision}
          disabled={view.busy !== null}
          accessibilityLabel={`Deny ${view.clientName} access`}
          onPress={() => onDecide("deny", null, [])}
          trailing={
            view.busy === "deny" ? <ActivityIndicator color={colors.text} size="small" /> : null
          }
          testID="consent-deny"
        />
        <Button
          label={view.busy === "approve" ? "Approving…" : "Approve"}
          variant="decision"
          style={styles.decision}
          disabled={!view.canApprove}
          accessibilityLabel={`Approve ${view.clientName} access${
            selected ? ` to ${atName(selected.slug)}` : ""
          }`}
          onPress={() =>
            onDecide("approve", view.selectedContextId, view.grantedScopes)
          }
          trailing={
            view.busy === "approve" ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : null
          }
          testID="consent-approve"
        />
      </View>

      {view.selectedContextId === null ? (
        <Text variant="rowSub" style={styles.pickFirst} role="status">
          Pick a context above before approving.
        </Text>
      ) : view.scopeChoices.length > 0 && !view.canApprove && view.busy === null ? (
        <Text variant="rowSub" style={styles.pickFirst} role="status">
          Nothing is ticked, so approving would grant nothing. Tick at least one, or refuse.
        </Text>
      ) : null}
    </>
  );
}

/**
 * The tier, stated rather than asked, when there is only one on offer.
 *
 * Two different facts share this line and they must not be blurred: a person
 * who has not picked a context yet is told we do not know, and a person whose
 * role cannot reach private notes is told the tier *and* why it is not a
 * question. Neither of them is "team access, as chosen".
 */
function tierStatement(view: Extract<ConsentView, { kind: "ready" }>): string {
  if (view.tier.selected === "unknown") {
    return "Pick a context above and this will say exactly which notes are included.";
  }
  return (
    "Team notes only — anything marked private stays invisible to this client. " +
    "Only a context's owner can hand over private notes, and this context is not yours to that extent."
  );
}

function WithheldRow({ line }: { line: ScopeLine }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.scope} role="listitem">
      <View style={styles.scopeGlyph} aria-hidden />
      <View style={styles.scopeText}>
        <Text variant="rowSub">{line.sentence}</Text>
      </View>
    </View>
  );
}

/**
 * The heading's type, as a style array.
 *
 * A function rather than a `StyleSheet` entry because the size is clamped
 * against the window width, and tracking and leading are derived from it —
 * `tracking()` and `leading()` convert CSS `em` and unitless line-height into
 * the points React Native wants, so they cannot be pre-baked.
 */
function titleStyle(styles: ReturnType<typeof makeStyles>, size: number): TextStyle[] {
  return [
    styles.title,
    { fontSize: size, lineHeight: leading(size, 1.08), letterSpacing: tracking(size, -0.03) },
  ];
}

function Title({ size, children }: { size: number; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text role="heading" aria-level={1} style={titleStyle(styles, size)}>
      {children}
    </Text>
  );
}

/** Expo Router hands back `string | string[]` for a query parameter. */
function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/** Re-exported for the tests and for anything typing a fixture request. */
export type { AuthorizationRequest };

const makeStyles = (colors: Colors) => StyleSheet.create({
  // `overflow: "hidden"` keeps `StageBackdrop`'s glow inside the page. It no
  // longer clips the content: that lives in the ScrollView, which owns its own
  // overflow.
  ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
  // No `flex: 1` and no `justifyContent` here any more — both belong to
  // `CenteredScroll`'s content container, which is what makes the page centre
  // on a tall window and scroll on a short one instead of clipping.
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
  titleClient: { color: colors.accentText },
  sub: { marginTop: 14, fontSize: 15.5, lineHeight: leading(15.5, 1.55) },
  subStrong: { color: colors.text, fontWeight: "600" },

  card: { marginTop: 26 },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  leavingFoot: { marginTop: 10 },

  singleContext: {
    marginTop: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.xl,
    backgroundColor: colors.surface,
  },

  rule: { marginVertical: 18, height: 1, backgroundColor: colors.line },

  emptyScopes: { marginTop: 9 },
  tierStatement: { marginTop: 9 },
  withheld: { marginTop: 16 },
  withheldList: { marginTop: 8, gap: 8, opacity: 0.6 },

  scopes: { marginTop: 12, gap: 12 },
  scope: { flexDirection: "row", alignItems: "flex-start", gap: 11 },
  scopeGlyph: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginTop: 7,
    backgroundColor: colors.muted,
  },
  scopeGlyphElevated: { backgroundColor: colors.warn },
  scopeText: { flex: 1, minWidth: 0 },
  scopeDetail: { marginTop: 3 },
  scopeUnknown: { color: colors.warnText },

  storageNote: { marginTop: 18, lineHeight: leading(12.5, 1.6) },

  error: { marginTop: 14 },

  decisions: { marginTop: 20, flexDirection: "row", gap: 12 },
  // Both halves flex identically, so neither is the wider, more obvious click.
  decision: { flex: 1, alignSelf: "auto" },
  pickFirst: { marginTop: 10 },

  deadEndActions: {
    marginTop: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
  },
  // `Button`'s base style sets `alignSelf: "flex-start"`, which beats the row's
  // `alignItems: "center"` — without this the ghost link floats to the top of
  // the taller button beside it.
  deadEndGhost: { alignSelf: "center" },
});

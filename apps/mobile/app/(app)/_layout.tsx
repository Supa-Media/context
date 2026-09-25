import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Redirect, Stack, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConvexAuth, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useColors } from "../../features/design/theme";
import { RecordingBar } from "../../features/meetings/components/RecordingBar";
import { StrandedBar } from "../../features/meetings/components/StrandedBar";
import { useMeetingsSetup, useTranscriptionClient } from "../../features/meetings/useMeetings";
import { useAttemptedHref } from "../../features/auth/attemptedHref";
import { useRememberedContexts } from "../../features/offline/useRememberedContexts";
import { resolveProtectedRoute } from "../../features/auth/redirect";
import { EMPTY_QUERY_SPEC } from "../../features/console/querySpec";
import {
  needsOnboarding,
  standingFrom,
  type WorkspaceStandingRow,
} from "../../features/onboarding/route";
import {
  ownPersonalWorkspace,
  resumeAsked,
  resumeAtLogin,
  sessionEntry,
  type ResumeWorkspaceRow,
} from "../../features/onboarding/resume";

/**
 * Everything under `(app)` needs a session, and an account with nowhere to go
 * needs sending somewhere before any of it means anything.
 *
 * Two gates, in order, both pure functions so they are testable without
 * mounting a router. Auth state comes from `@convex-dev/auth` via
 * `useConvexAuth`; the standing comes from the same `listMyWorkspaces`
 * subscription the console already reads plus `listMyInvitations`, both of
 * which Convex dedupes — this does not add a round trip the app was not
 * already making.
 *
 * ## Why the invitation list is up here at all
 *
 * Because "you have no contexts" and "there is nothing here for you" are not
 * the same sentence, and this layout used to say the first when it meant the
 * second. Somebody who was invited into a context and has not accepted yet has
 * zero workspaces, so the old gate sent them to `/welcome` — and the
 * invitation that brought them to the product in the first place was never
 * shown to them. See `features/onboarding/route.ts` for the full rule.
 *
 * ## The subtlety worth keeping
 *
 * Either query is `undefined` until its first round trip lands, and that is
 * **not** the same as an empty list. `standingFrom` returns `undefined` unless
 * both have landed, and `needsOnboarding` renders rather than redirects while
 * it is unresolved, so a signed-in user with contexts is never thrown into
 * onboarding on a cold load. It also never redirects away from `/welcome` or
 * `/invite` — those screens' own gates own that.
 *
 * ## The recording bar is mounted here, and this is the only place it is
 *
 * A recording has to be visible from wherever somebody is — "a recording
 * session with no visible indicator is a bug, not a mode"
 * (`docs/decisions/meetings.md`) — and a bar mounted inside the meetings
 * navigator is visible only on meetings screens. Here it is above every route
 * in the section.
 *
 * It costs this layout nothing: the bar renders `null` while nothing is
 * recording, and the recording lives in an external store rather than a
 * provider, so no context is added and no screen has to know the feature
 * exists. It is mounted **after** the `Stack` because later siblings paint over
 * earlier ones — every react-native-web `View` opens a stacking context, so a
 * `zIndex` set inside the stack would mean nothing out here
 * (`docs/decisions/app-and-console.md`).
 *
 * `useTranscriptionClient` is here for exactly the same reason, and it was not:
 * it lived in `useMeetingsSetup`, in the meetings navigator, which unmounts the
 * moment somebody leaves that section — so leaving mid-meeting switched
 * transcription off for the rest of it while the bar went on drawing a live
 * timer. A recording that is visible from anywhere has to be *working* from
 * anywhere. See `features/meetings/useMeetings.ts`.
 *
 * ## Why `useQueries` and not two `useQuery` calls
 *
 * This layout used to hold a single `useQuery` guarded by the `"skip"`
 * sentinel, for a reason worth restating: `listMyWorkspaces` calls
 * `requireAuth`, so it **throws** `NOT_AUTHENTICATED` for a client that has no
 * identity yet — and `useQuery` re-throws a failed query *during render*. On a
 * cold start the socket connects before the token comes back out of
 * SecureStore, so the subscription goes out unauthenticated and the error lands
 * in the render phase of the layout that was about to redirect to `/login`.
 * There is no ErrorBoundary above this; the app shows expo-router's crash
 * screen instead of the sign-in page.
 *
 * Adding a second `useQuery` here would double that surface. `useQueries` hands
 * an error back as a *value* instead of throwing it, which is why every other
 * subscribing module in this app uses it — so the empty spec now covers the
 * signed-out case and a failure covers itself. The spec's dependency is a
 * boolean, and `api.…` is reached inside the memo body: see the rule in
 * `features/console/querySpec.ts`, which exists because `api` is a proxy that
 * returns a new object on every access.
 */
export default function AppLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  /**
   * The attempted URL is carried into `/login?next=…` so a link somebody was
   * sent survives the sign-in it triggers. `safeNextRoute` narrows it on the
   * way out and again on the way back.
   *
   * **The whole href, not the pathname.** `usePathname` documents itself as
   * returning the location *without search parameters*, and the two links in
   * this product that cannot be recovered by clicking around both carry their
   * payload in the query: `/authorize?request_id=…` and, since team links
   * became readable URLs, `/console/@seyi?note=…`. Passing the pathname sent
   * somebody who followed a note link into a context's empty "choose a note"
   * screen, with no way of knowing which note they had been sent — the link
   * worked, and it landed nowhere.
   *
   * **And not expo-router's reconstruction of it either**, which is the second
   * half of the same bug and the more interesting one: this gate is exactly
   * the "interrupted in a layout" case that leaves React Navigation's state
   * incomplete, so what `useUnstableGlobalHref` hands back is not the URL —
   * measured live, it dropped the `note` and re-emitted `[slug]` as a query
   * parameter. See `attemptedHrefFrom` in `features/auth/redirect.ts`.
   */
  const auth = useConvexAuth();
  /*
    Whether this device remembers a session well enough to draw the app while
    the server is out of reach. `useRememberedContexts` answers with the list
    only when it is offline *and* something was written down by a session that
    signed out of nothing — see its header, and `resolveProtectedRoute` for why
    waiting is the wrong answer on a train.
  */
  const rememberedSession = useRememberedContexts(undefined) !== undefined;
  const decision = resolveProtectedRoute(auth, useAttemptedHref(), rememberedSession);
  /*
    **Not `decision.action === "render"`**, which is what this used to read and
    what it can no longer mean. The two were the same value until an offline
    relaunch could render without the server having confirmed anything; they
    are now different questions, and everything below wants the stricter one.

    A subscription opened on an unconfirmed identity is refused — every query
    here goes through `requireAuth` — so the cost of confusing them is a fan of
    failing queries and a meetings client pointed at nobody, for a session that
    is about to be confirmed or about to be sent to `/login` anyway.

    **Both halves, not just `isAuthenticated`.** `isLoading` and
    `isAuthenticated` can be true together — that is the stale-token window
    `authRedirect.test.ts` already pins — and the old expression excluded it
    because `wait` beat `render`. Writing this as `auth.isAuthenticated` alone
    would quietly open every subscription a render earlier than it used to,
    which is a change to a state machine this file has already been bitten by
    and is no part of what the offline gate is for.
  */
  const authed = !auth.isLoading && auth.isAuthenticated;

  // Above the early returns below, like every other hook here: this layout's
  // job is to gate, and a hook that ran only on the happy path would install
  // transcription a render late on a cold start into a running meeting.
  useTranscriptionClient();
  /*
    And the setup beside it, for the same reason and now one more.

    It used to be mounted by the meetings navigator, which is the half of the
    app that unmounts the moment somebody leaves `/meetings`. That was already
    the wrong half for a recording that outlives the screen that started it —
    the argument this file makes about `useTranscriptionClient` two paragraphs
    up. It is now also the wrong half because the console's microphone key can
    start a meeting without `/meetings` ever having been mounted: the
    controller has to be pointed at the signed-in person before the key is
    pressed, not after.

    One mount, here, above both navigators. The meetings navigator no longer
    calls it, so nothing opens these subscriptions twice.

    `enabled` rather than a conditional call, for the reason this file already
    gives about its own `spec`: the hook has to run on every render, and what
    must wait for a session is the *subscription*, not the hook.
  */
  useMeetingsSetup({ enabled: authed });

  const spec = useMemo<RequestForQueries>(() => {
    if (!authed) return EMPTY_QUERY_SPEC;
    return {
      workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} },
      invitations: { query: api.functions.invitations.listMyInvitations, args: {} },
    };
  }, [authed]);
  const results = useQueries(spec);
  const rows = usable<(WorkspaceStandingRow & ResumeWorkspaceRow)[]>(results.workspaces);

  /*
    An unfinished setup, picked back up at sign-in — `onboarding/resume.ts`
    has the rule. The binding is only asked for while it could change the
    answer: a session that came in by the front door, not yet asked since
    sign-in, for somebody who owns a personal workspace.
  */
  const asked = resumeAsked();
  const entry = authed ? sessionEntry(pathname) : null;
  const ownId = ownPersonalWorkspace(rows)?.workspaceId;
  const askBinding = entry === "front" && !asked && ownId !== undefined;
  const bindingSpec = useMemo<RequestForQueries>(() => {
    if (!askBinding || ownId === undefined) return EMPTY_QUERY_SPEC;
    return {
      binding: {
        query: api.functions.storage.getStorageBinding,
        args: { workspaceId: ownId as Id<"workspaces"> },
      },
    };
  }, [askBinding, ownId]);
  const bindingResults = useQueries(bindingSpec);

  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;

  const onboarding = needsOnboarding({
    standing: standingFrom(rows, usable<unknown[]>(results.invitations)),
    pathname,
  });
  if (onboarding.action === "redirect") return <Redirect href={onboarding.href} />;

  const resume = resumeAtLogin({
    rows,
    binding: usable<object | null>(bindingResults.binding),
    asked,
    entry: entry ?? "deep",
    pathname,
  });
  /*
    Not marked as asked here. A render is not a navigation: the next re-render
    would read "asked", draw the console, and unmount this `Redirect` before
    its navigation ran — the prompt lost to a subscription tick. `/welcome`
    records it once the question is actually on screen.
  */
  if (resume.action === "redirect") return <Redirect href={resume.href} />;

  return (
    <View style={[styles.fill, { backgroundColor: colors.ground }]}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.ground },
        }}
      />
      <RecordingBar bottomInset={insets.bottom} />
      {/*
        Mounted beside the recording bar and *after* it, which is what orders
        them: `zIndex` is only ever an ordering among siblings in
        react-native-web. They never draw together — `StrandedBar` stands down
        while anything is live — but the order is the guarantee rather than the
        condition, for the reason `RecordingBar`'s header gives about two bars
        in one 66pt of glass.
      */}
      <StrandedBar bottomInset={insets.bottom} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

/**
 * Convex hands back `undefined` while loading and an `Error` when a query
 * throws. Both mean "no answer yet" to a gate, and a gate that cannot answer
 * must render rather than redirect — a transient failure on either query is
 * not evidence that somebody has no contexts.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

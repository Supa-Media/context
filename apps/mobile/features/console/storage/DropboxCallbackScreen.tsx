import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAction, useConvexAuth, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { CenteredScroll } from "../../design/components/CenteredScroll";
import { FormError, Notice } from "../../design/components/Input";
import { StageBackdrop } from "../../design/components/StageBackdrop";
import { Text } from "../../design/components/Text";
import { clamp, fonts, leading, tracking } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { CONSOLE_ROUTE } from "../../auth/redirect";
import { CONNECT_TIMEOUT_MS, type WatchedBinding } from "../../onboarding/verify";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import { describeThrownStorageError } from "./errors";
import {
  firstParam,
  parseDropboxCallback,
  resolveDropboxCallbackView,
  type DropboxAttempt,
  type DropboxCallbackView,
} from "./dropbox";

/**
 * `/connect/dropbox?code=…&state=…` — where Dropbox sends the browser back.
 *
 * Deliberately **not** under the `(app)` group, for exactly the reason
 * `/authorize` and `/invite/<token>` are not: that group's gate bounces a
 * signed-out visitor to a bare `/login`, and this URL carries a code and a
 * state that exist for about a minute and nowhere else. This screen owns its
 * gate so it can send somebody to `/login?next=/connect/dropbox?code=…` and
 * bring them back with both halves intact.
 *
 * ## Why it has to watch the binding rather than read a return value
 *
 * `completeDropboxConnect` **schedules** the exchange. It has to: doing the
 * work inline would make a public function reach the decrypt path, which
 * `apps/convex/__tests__/structure.test.ts` refuses, and correctly — the
 * enumerated credential barriers are the whole mechanism. So the action
 * returns "queued, for this workspace" and the outcome arrives on the row,
 * through the reactive `getStorageBinding` subscription. Exactly what the
 * bucket path already does after `bindStorage`, and it reuses that state
 * machine (`connectProgress`) rather than growing a second one.
 *
 * Which view to show is `resolveDropboxCallbackView`, a pure function, and
 * that is what the tests exercise — a redirect rule looks right when you click
 * it and is wrong when somebody reloads.
 */
export function DropboxCallbackScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{
    code?: string | string[];
    state?: string | string[];
    error?: string | string[];
  }>();
  const auth = useConvexAuth();
  const router = useRouter();

  // Memoised on the three strings rather than on `params`, which is a fresh
  // object every render: the exchange effect below depends on this value, and
  // an unstable one would re-run it on every subscription tick.
  const rawCode = firstParam(params.code);
  const rawState = firstParam(params.state);
  const rawError = firstParam(params.error);
  const callback = useMemo(
    () =>
      parseDropboxCallback({
        code: rawCode ?? undefined,
        state: rawState ?? undefined,
        error: rawError ?? undefined,
      }),
    [rawCode, rawError, rawState],
  );

  const complete = useAction(api.functions.dropboxConnect.completeDropboxConnect);

  const [attempt, setAttempt] = useState<DropboxAttempt | undefined>(undefined);
  const [timedOut, setTimedOut] = useState(false);

  /**
   * The exchange runs **once**.
   *
   * Not a nicety: the attempt row is single-use and is deleted before the code
   * is spent, so a second call with the same state is refused. Without this
   * ref, a re-render — StrictMode's double effect, a subscription landing —
   * would fire a second exchange whose only possible outcome is
   * `CONNECT_ATTEMPT_INVALID`, and that failure would replace a connect that
   * was already succeeding.
   */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    if (callback.kind !== "ready") return;
    // No session gate. The exchange is provable without one (see
    // `completeDropboxConnect`), and waiting on auth here is what fed the
    // sign-in wall that burned Dropbox's single-use code on the first live
    // run. The binding *watch* below still waits for a session, because
    // reading the row is members-only.
    started.current = true;
    setAttempt({ kind: "running" });
    void (async () => {
      try {
        const result = await complete({ state: callback.state, code: callback.code });
        setAttempt({ kind: "queued", workspaceId: result.workspaceId, resumeTo: result.resumeTo });
      } catch (error) {
        setAttempt({ kind: "failed", failure: describeThrownStorageError(error, "dropbox") });
      }
    })();
  }, [callback, complete]);

  const workspaceId = attempt?.kind === "queued" ? attempt.workspaceId : null;

  // Started only once there is a workspace to watch, so a failed exchange never
  // sits under a timeout notice about a probe that was never queued.
  useEffect(() => {
    if (workspaceId === null) return;
    const handle = setTimeout(() => setTimedOut(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(handle);
  }, [workspaceId]);

  // `useQueries` with the shared frozen constant while there is nothing to
  // watch, and `api.…` reached *inside* the memo body — `api` is a proxy that
  // mints a new object on every access, so listing it would make this spec
  // unstable and set state during render. See `console/querySpec.ts`.
  const queries = useMemo<RequestForQueries>(() => {
    if (workspaceId === null) return EMPTY_QUERY_SPEC;
    // A signed-out finisher must not mount a members-only query: it would
    // error, and the resolver already gives them the honest terminal state.
    if (!auth.isAuthenticated) return EMPTY_QUERY_SPEC;
    return {
      binding: {
        query: api.functions.storage.getStorageBinding,
        args: { workspaceId: workspaceId as Id<"workspaces"> },
      },
      workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} },
    };
  }, [auth.isAuthenticated, workspaceId]);
  const results = useQueries(queries);

  const rawBinding = results.binding;
  const binding =
    rawBinding === undefined || rawBinding instanceof Error
      ? undefined
      : (rawBinding as (WatchedBinding & { provider?: string }) | null);

  const workspaces = results.workspaces;
  const slug =
    workspaces === undefined || workspaces instanceof Error
      ? null
      : ((workspaces as Array<{ workspaceId: string; slug: string }>).find(
          (workspace) => workspace.workspaceId === workspaceId,
        )?.slug ?? null);

  const view = resolveDropboxCallbackView({
    callback,
    auth,
    attempt,
    binding,
    slug,
    timedOut,
  });

  if (view.kind === "wait") return <View style={styles.ground} />;

  return (
    <ConnectPage testID="dropbox-callback-page">
      <DropboxCallbackBody
        view={view}
        onLeave={(href) => router.replace(href)}
      />
    </ConnectPage>
  );
}

/**
 * The screen's body, given an already-resolved view.
 *
 * Exported for the same reason `InviteBody` and `ConsentBody` are: every state
 * this can be in — including the ones that need a spent code or a backend that
 * threw — can then be rendered and read without a Convex client, a session, or
 * a Dropbox account.
 */
export function DropboxCallbackBody({
  view,
  onLeave,
}: {
  view: DropboxCallbackView;
  onLeave: (href: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);

  switch (view.kind) {
    case "wait":
      return null;

    case "finishing":
      return (
        <Outcome
          titleSize={titleSize}
          headline="Dropbox is connecting"
          detail="The connection is finishing on our side — nothing else to do here. Sign in to open your console and watch it land."
          tone="ok"
          primary={{ label: "Sign in to your console", href: view.href }}
          onLeave={onLeave}
          testID="dropbox-finishing"
        />
      );

    case "working":
      return (
        <View testID="dropbox-working">
          <Card>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="rowSub" role="status" style={styles.loadingBody}>
                {view.message}
              </Text>
            </View>
          </Card>
        </View>
      );

    case "cancelled":
      // Not a failure, and it must not read as one. They were shown what
      // Context was asking for and said no, which is a working consent screen.
      return (
        <Outcome
          titleSize={titleSize}
          headline="You didn't connect Dropbox"
          detail="Dropbox says you cancelled, so nothing was shared and nothing changed. You can start again whenever you like, or connect a bucket you own instead — that path never involves Dropbox at all."
          onLeave={onLeave}
          testID="dropbox-cancelled"
        />
      );

    case "incomplete":
      // Somebody opened `/connect/dropbox` with nothing after it — a bookmark,
      // a truncated link, a reload after the query string was stripped. It says
      // nothing about any particular code, because it cannot: there is not one.
      return (
        <Outcome
          titleSize={titleSize}
          headline="There's nothing to finish here"
          detail="This page is where Dropbox sends you back to, and this visit carries no connection to complete. Start one from your context's storage settings."
          onLeave={onLeave}
          testID="dropbox-incomplete"
        />
      );

    case "connected":
      return (
        <Outcome
          titleSize={titleSize}
          headline="Dropbox is connected"
          detail="We can read and write the folder, so this context has somewhere to keep its notes. Everything in it stays plain Markdown — open the same folder in Obsidian, or on your machine through the Dropbox app, and it is all just files."
          tone="ok"
          primary={{ label: "Open this context", href: view.href }}
          onLeave={onLeave}
          testID="dropbox-connected"
        />
      );

    case "timeout":
      return (
        <View testID="dropbox-timeout">
          <Title size={titleSize}>Still checking</Title>
          <Notice tone="warn" style={styles.notice}>
            <Text variant="check" role="status" style={styles.warnText}>
              {view.message}
            </Text>
          </Notice>
          <Actions
            primary={{ label: "Go to your console", href: CONSOLE_ROUTE }}
            onLeave={onLeave}
          />
        </View>
      );

    case "failed":
      return (
        <View testID="dropbox-failed">
          <Title size={titleSize}>Dropbox didn&apos;t connect</Title>
          <FormError
            headline={view.failure.headline}
            next={[view.failure.next, view.failure.detail].filter(Boolean).join(" ")}
            style={styles.notice}
          />
          <Actions
            primary={{ label: "Go to your console", href: CONSOLE_ROUTE }}
            onLeave={onLeave}
          />
        </View>
      );
  }
}

function Outcome({
  titleSize,
  headline,
  detail,
  tone,
  primary,
  onLeave,
  testID,
}: {
  titleSize: number;
  headline: string;
  detail: string;
  tone?: "ok";
  primary?: { label: string; href: string };
  onLeave: (href: string) => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID={testID}>
      <Title size={titleSize}>{headline}</Title>
      <Text
        variant="heroSub"
        role={tone === "ok" ? "status" : undefined}
        style={styles.sub}
      >
        {detail}
      </Text>
      <Actions
        primary={primary ?? { label: "Go to your console", href: CONSOLE_ROUTE }}
        onLeave={onLeave}
      />
    </View>
  );
}

/**
 * One way on, always.
 *
 * `/console` answers for itself — it sends an account with no contexts to
 * `/welcome` — so no branch of this screen can strand somebody, including the
 * ones reached by a stranger following a link.
 */
function Actions({
  primary,
  onLeave,
}: {
  primary: { label: string; href: string };
  onLeave: (href: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.actions}>
      <Button
        label={primary.label}
        variant="decision"
        onPress={() => onLeave(primary.href)}
        testID="dropbox-primary"
      />
      {primary.href === CONSOLE_ROUTE ? null : (
        <Button
          label="Go to your console"
          variant="ghost"
          style={styles.ghost}
          onPress={() => onLeave(CONSOLE_ROUTE)}
          testID="dropbox-console"
        />
      )}
    </View>
  );
}

/**
 * The chrome this screen sits in: one dark ground, the wordmark, and a column
 * that centres on a tall window and scrolls on a short one.
 *
 * This is the **third** copy of that shape — `InvitePage` in
 * `features/invite/InviteScreen.tsx` and the block inside `ConsentScreen` are
 * the other two, and all three are the same fifteen lines. It is not extracted
 * here on purpose: both of those files have work in flight against them, and a
 * shared component landing under them is a merge conflict in somebody else's
 * branch rather than a tidy-up. Extract it once they have landed; three copies
 * is the moment, and this comment is the marker.
 */
function ConnectPage({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
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

/** The heading's type, clamped against the window. Same shape as the invite screen's. */
function Title({ size, children }: { size: number; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
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

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  notice: { marginTop: 18 },
  warnText: { color: colors.warnText },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  loadingBody: { flex: 1, minWidth: 0 },
  actions: {
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
  },
  // `Button`'s base style sets `alignSelf: "flex-start"`, which beats the row's
  // `alignItems: "center"`.
  ghost: { alignSelf: "center" },
});

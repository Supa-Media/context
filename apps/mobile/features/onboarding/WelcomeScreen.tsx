import { useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, Redirect, useRouter } from "expo-router";
import { checkoutOutcomeFrom } from "@context/shared";
import { ScreenScroll } from "../app/Screen";
import { Text } from "../design/components/Text";
import { fonts, layout, leading, pointerType as t, tracking } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { browseHref } from "../console/nav";
import { STEP_LABELS, stepProgress, stepTitle, type FlowShape, type StepKey } from "./flow";
import { resolveWelcomeRoute } from "./route";
import { useOnboarding } from "./useOnboarding";
import { NameStep } from "./steps/NameStep";
import { StorageStep } from "./steps/StorageStep";
import { VaultImportStep } from "./steps/VaultImportStep";
import { StructureStep } from "./steps/StructureStep";
import { BootstrapStep } from "./redesign/BootstrapStep";
import { ForkStep } from "./redesign/ForkStep";
import { DryRunStep } from "./redesign/DryRunStep";
import { ConnectionsContainer, ToolsLiveContainer } from "./steps/ToolsSteps";
import { INVITE_ROUTE } from "../auth/redirect";
import { NEW_WORKSPACE_ROUTE } from "../workspace/create";
import { DoneStep } from "./steps/DoneStep";
import { ResumeNotice } from "./ResumeNotice";
import { markResumeAsked } from "./resume";

/**
 * `/welcome` — the thirty seconds between "you're signed in" and "your context
 * is connected".
 *
 * Signing in creates an account, not a context. Until a name is claimed there
 * is nothing in the rail, no workspace for a bucket to hang off, and no way to
 * make either from inside the console — so without this screen a new account
 * lands on a dead end that does not look like one.
 *
 * ## The gate
 *
 * `resolveWelcomeRoute` decides whether this screen should run at all, and the
 * `claimed` argument is the part that is easy to get wrong: the instant step 1
 * succeeds, `listMyWorkspaces` reports one context, and a naive "you have a
 * context, go to the console" rule would throw somebody out of step 2 into a
 * console with no bucket. See `route.ts`.
 */
export function WelcomeScreen() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const params = useLocalSearchParams<{ resume?: string | string[]; checkout?: string | string[] }>();
  const resumeParam = Array.isArray(params.resume) ? params.resume[0] : params.resume;
  /*
    Back from Stripe. The payment page returns to `/welcome?checkout=…` —
    built by `@context/shared` from the origin recorded on the session row —
    and that has to re-enter the flow rather than be treated as a fresh visit:
    the person has a claimed name and no storage, so the gate below would
    otherwise send them to a console with nothing in it. It is a resume signal
    as much as a result, and it resumes the step it left from.
  */
  const rawCheckout = Array.isArray(params.checkout) ? params.checkout[0] : params.checkout;
  const checkout = checkoutOutcomeFrom(rawCheckout);
  /*
    `resume=storage` is the sign-in gate's (`resume.ts`): an owner whose
    personal workspace never got storage. It re-enters at the fork — the step
    that asks where notes live — rather than at a storage step whose route
    they never chose.
  */
  const fromLogin = resumeParam === "storage" && checkout === null;
  const resume =
    resumeParam === "structure"
      ? "structure"
      : checkout !== null
        ? "storage"
        : fromLogin
          ? "fork"
          : undefined;
  const resuming = resume !== undefined;
  const controller = useOnboarding({ resume, checkout });
  // Asked, now that it is on screen — see `resume.ts` and the `(app)` gate.
  useEffect(() => {
    if (fromLogin) markResumeAsked();
  }, [fromLogin]);

  const decision = resolveWelcomeRoute({
    owned: controller.owned,
    claimed: controller.claimed !== null,
    resuming,
  });

  if (decision.action === "wait") return <View style={styles.ground} />;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;

  return (
    <WelcomeChrome
      step={controller.step}
      shape={controller.shape}
      notice={
        fromLogin && (controller.step === "fork" || controller.step === "storage") ? (
          <ResumeNotice
            slug={controller.claimed?.slug ?? null}
            onLater={() => router.replace("/console")}
          />
        ) : null
      }
    >
      <StepBody
        controller={controller}
        onOpenConsole={() => {
          const slug = controller.claimed?.slug;
          router.replace(slug === undefined ? "/console" : browseHref(slug));
        }}
        onOpenInvitations={() => router.push(INVITE_ROUTE)}
        onNewWorkspace={() => router.push(NEW_WORKSPACE_ROUTE)}
      />
    </WelcomeChrome>
  );
}

/**
 * The page around a step: wordmark, step rail, title, and the card.
 *
 * Separated from the screen so the chrome can be rendered — and looked at —
 * without a session or a Convex deployment behind it. The gate above is a pure
 * decision; this is pure presentation; the controller is the only part that
 * needs a backend.
 */
export function WelcomeChrome({
  step,
  shape,
  notice = null,
  children,
}: {
  step: StepKey;
  shape: FlowShape;
  /** Drawn above the title — the resume line, when there is one. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const progress = stepProgress(step, shape);

  return (
    <ScreenScroll
      style={styles.ground}
      contentContainerStyle={styles.scroll}
      /*
        The tail this page has always had, moved off `styles.scroll` and onto
        the inset arithmetic. Left on the content container it would *replace*
        the home indicator's inset rather than add to it — see `Screen.tsx`.
      */
      chrome={WELCOME_TAIL}
    >
      {/*
        The canvas's first-run frame (A-03, A-04, B1-01): the wordmark and where
        you are on one line, then the question as a plain heading and the step
        beneath it — no card around it, and no rail of every step's name. The
        rail named steps a person had not reached yet and might never see, and
        "Step 3 of 9" says the same thing in four words.
      */}
      <View style={styles.header}>
        <Text variant="mark">
          Context
          <Text variant="mark" style={styles.markSuffix}>
            .lc
          </Text>
        </Text>
        {progress === null ? null : (
          <Text variant="eyebrow" style={styles.progress} testID="welcome-progress">
            {`Step ${progress.index} of ${progress.total} · ${STEP_LABELS[step]}`}
          </Text>
        )}
      </View>

      <View style={styles.wrap}>
        {notice}
        <Text role="heading" aria-level={1} style={styles.title}>
          {stepTitle(step, shape)}
        </Text>

        <View style={styles.body}>{children}</View>

        <Text variant="foot" style={styles.foot}>
          Your notes are plain files, in storage that answers to you. Nothing here moves a
          file you already have, and everything here leaves with you.
        </Text>
      </View>
    </ScreenScroll>
  );
}

function StepBody({
  controller,
  onOpenConsole,
  onOpenInvitations,
  onNewWorkspace,
}: {
  controller: ReturnType<typeof useOnboarding>;
  onOpenConsole: () => void;
  onOpenInvitations: () => void;
  onNewWorkspace: () => void;
}) {
  const workspaceId = controller.claimed?.workspaceId ?? null;
  switch (controller.step) {
    case "name":
      return <NameStep controller={controller} />;
    case "fork":
      return (
        <ForkStep
          offer={controller.forkOffer}
          starting={controller.startingFree}
          failure={controller.forkFailure}
          onPickManaged={controller.pickManaged}
          onPickBYO={controller.pickOwn}
          onOpenInvitations={onOpenInvitations}
        />
      );
    case "storage":
      return <StorageStep controller={controller} />;
    case "dryrun":
      // The binding is already `connected` — that is what moved the flow here —
      // so the report has its facts; `null` is only ever a render between
      // subscription ticks, and continuing past it loses nothing.
      return controller.dryRun === null ? null : (
        <DryRunStep {...controller.dryRun} onContinue={controller.finishDryRun} />
      );
    case "vault":
      return <VaultImportStep controller={controller} />;
    case "structure":
      return <StructureStep controller={controller} />;
    case "agents":
      return <ConnectionsContainer workspaceId={workspaceId} onContinue={controller.finishAgents} />;
    case "bootstrap":
      /*
        The second half of "point your AI at it". `AgentsStep` handed over the
        endpoint and the seeding prompt; this hands over the standing prompt
        that asks the same client to carry across everything it already knows
        about the person. `prompt` comes from the controller (`BOOTSTRAP_PROMPT`
        in `agents.ts`) rather than from this file, so the pinned wording sits
        with the other product claims about client behaviour.
      */
      return (
        <BootstrapStep
          prompt={controller.bootstrapPrompt}
          onDone={controller.finishBootstrap}
          onSkip={controller.finishBootstrap}
        />
      );
    case "live":
      return <ToolsLiveContainer workspaceId={workspaceId} onContinue={controller.finishLive} />;
    case "done":
      return <DoneStep controller={controller} onOpenConsole={onOpenConsole} onNewWorkspace={onNewWorkspace} />;
  }
}

/** The page's own tail, added to the home indicator rather than replacing it. */
const WELCOME_TAIL = { bottom: 60 } as const;

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  scroll: { minHeight: "100%" },
  header: {
    width: "100%",
    maxWidth: 620,
    marginHorizontal: "auto",
    paddingHorizontal: layout.gutter,
    paddingTop: 30,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  markSuffix: { color: colors.accent },
  progress: { color: colors.muted },
  wrap: {
    width: "100%",
    maxWidth: 520,
    marginHorizontal: "auto",
    paddingHorizontal: layout.gutter,
    marginTop: 32,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: t.title,
    lineHeight: leading(30, 1.1),
    letterSpacing: tracking(30, -0.02),
    fontWeight: "600",
    color: colors.text,
  },
  body: { marginTop: 14 },
  foot: { marginTop: 36, lineHeight: leading(12.5, 1.6), color: colors.muted },
});

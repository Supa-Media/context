import type { ReactNode } from "react";
import { StyleSheet, View, ScrollView, useWindowDimensions } from "react-native";
import { useLocalSearchParams, Redirect, useRouter } from "expo-router";
import { Text } from "../design/components/Text";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { clamp, colors, fonts, layout, leading, radii, tracking } from "../design/tokens";
import { browseHref } from "../console/nav";
import { STEP_LABELS, stepTitle, stepsFor, type FlowShape, type StepKey } from "./flow";
import { resolveWelcomeRoute } from "./route";
import { useOnboarding } from "./useOnboarding";
import { NameStep } from "./steps/NameStep";
import { StorageStep } from "./steps/StorageStep";
import { StructureStep } from "./steps/StructureStep";
import { AgentsStep } from "./steps/AgentsStep";
import { DoneStep } from "./steps/DoneStep";

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
  const router = useRouter();
  const params = useLocalSearchParams<{ resume?: string | string[] }>();
  const resumeParam = Array.isArray(params.resume) ? params.resume[0] : params.resume;
  const resuming = resumeParam === "structure";
  const controller = useOnboarding(resuming ? { resume: "structure" } : {});

  const decision = resolveWelcomeRoute({
    owned: controller.owned,
    claimed: controller.claimed !== null,
    resuming,
  });

  if (decision.action === "wait") return <View style={styles.ground} />;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;

  return (
    <WelcomeChrome step={controller.step} shape={controller.shape}>
      <StepBody
        controller={controller}
        onOpenConsole={() => {
          const slug = controller.claimed?.slug;
          router.replace(slug === undefined ? "/console" : browseHref(slug));
        }}
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
  children,
}: {
  step: StepKey;
  shape: FlowShape;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const titleSize = clamp(27, 3.1, 38, width);

  return (
    <ScrollView style={styles.ground} contentContainerStyle={styles.scroll}>
      <StageBackdrop />
      <View style={styles.wrap}>
        <View style={styles.mark}>
          <Text variant="mark">
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
        </View>

        <StepRail step={step} shape={shape} />

        <Text
          role="heading"
          aria-level={1}
          style={[
            styles.title,
            {
              fontSize: titleSize,
              lineHeight: leading(titleSize, 1.05),
              letterSpacing: tracking(titleSize, -0.03),
            },
          ]}
        >
          {stepTitle(step)}
        </Text>

        {/*
          No "Step 2 of 4" line: the rail above already shows where you are, by
          name, and saying it twice in two formats is the sort of padding this
          flow is meant to be free of. The count still exists for screen
          readers, on the rail's own label.
        */}

        <View style={styles.card}>{children}</View>

        <Text variant="foot" style={styles.foot}>
          Your notes stay in a bucket you own. Nothing here moves a file you already have.
        </Text>
      </View>
    </ScrollView>
  );
}

function StepBody({
  controller,
  onOpenConsole,
}: {
  controller: ReturnType<typeof useOnboarding>;
  onOpenConsole: () => void;
}) {
  switch (controller.step) {
    case "name":
      return <NameStep controller={controller} />;
    case "storage":
      return <StorageStep controller={controller} />;
    case "structure":
      return <StructureStep controller={controller} />;
    case "agents":
      return <AgentsStep controller={controller} onContinue={controller.finishAgents} />;
    case "done":
      return <DoneStep controller={controller} onOpenConsole={onOpenConsole} />;
  }
}

/**
 * The steps, as a row of labels rather than a progress bar.
 *
 * A bar implies a percentage, and this flow's length changes when somebody
 * skips storage. Naming the steps is both more honest and more useful — it
 * says what is coming.
 */
function StepRail({ step, shape }: { step: StepKey; shape: FlowShape }) {
  const steps = stepsFor(shape);
  const current = steps.indexOf(step);

  return (
    <View style={styles.rail} accessibilityLabel={`Step ${current + 1} of ${steps.length}`}>
      {steps.map((key, index) => (
        <View key={key} style={styles.railItem}>
          <View
            style={[
              styles.railPip,
              index < current && styles.railPipDone,
              index === current && styles.railPipOn,
            ]}
            aria-hidden
          />
          <Text
            variant="foot"
            style={[styles.railLabel, index === current && styles.railLabelOn]}
          >
            {STEP_LABELS[key]}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  scroll: { minHeight: "100%", paddingBottom: 60 },
  wrap: {
    width: "100%",
    maxWidth: 640,
    marginHorizontal: "auto",
    paddingHorizontal: layout.gutter,
  },
  mark: { alignSelf: "flex-start", paddingTop: 30, marginBottom: 30 },
  markSuffix: { color: colors.muted },
  rail: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginBottom: 22 },
  railItem: { flexDirection: "row", alignItems: "center", gap: 7 },
  railPip: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  railPipDone: { backgroundColor: colors.ok, borderColor: colors.ok },
  railPipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  railLabel: { color: colors.muted },
  railLabelOn: { color: colors.text },
  title: { fontFamily: fonts.display, fontWeight: "500", color: colors.text },
  card: {
    marginTop: 22,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 22,
    paddingHorizontal: 22,
  },
  foot: { marginTop: 22, lineHeight: leading(12.5, 1.6) },
});

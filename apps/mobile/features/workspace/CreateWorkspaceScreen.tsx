import type { ReactNode } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { Text } from "../design/components/Text";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { clamp, fonts, layout, leading, radii, tracking } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { browseHref } from "../console/nav";
import {
  WORKSPACE_STEP_LABELS,
  workspaceStepTitle,
  workspaceStepsFor,
  type WorkspaceFlowShape,
  type WorkspaceStepKey,
} from "./create";
import { useCreateWorkspace, type CreateWorkspaceController } from "./useCreateWorkspace";
import { WorkspaceNameStep } from "./steps/WorkspaceNameStep";
import { WorkspaceStorageStep } from "./steps/WorkspaceStorageStep";
import { WorkspaceLayoutStep } from "./steps/WorkspaceLayoutStep";
import { WorkspacePeopleStep } from "./steps/WorkspacePeopleStep";
import { WorkspaceDoneStep } from "./steps/WorkspaceDoneStep";

/**
 * `/workspace/new` — making a context that is not about one person.
 *
 * ## Why this is a screen and not a dialog in the console
 *
 * Three of its five steps are the same weight as onboarding's: a permanent name
 * claim, a credential for somebody's object storage, and a write into that
 * bucket. A modal over a file tree is the wrong frame for any of them — it says
 * "small, cancellable, you can go back", and the first step is none of those.
 * It is also a real URL, so an interrupted setup can be resumed by reloading
 * and a colleague can be pointed at it.
 *
 * ## There is no gate on this screen
 *
 * `/welcome` has one, because onboarding produces the one thing a person may
 * only have once and re-running it is a bug. This produces a thing they may
 * have several of, so the only limits are the control plane's own —
 * `MAX_WORKSPACES_PER_USER` and the create rate limit — and they arrive as
 * refusals from `createWorkspace` with an error the name step renders. A
 * client-side count would be a second copy of a rule that already exists, and
 * the copy would be the one that is wrong after a deploy.
 */
export function CreateWorkspaceScreen() {
  const router = useRouter();
  const controller = useCreateWorkspace();

  return (
    <CreateWorkspaceChrome step={controller.step} shape={controller.shape}>
      <StepBody
        controller={controller}
        onOpenWorkspace={() => {
          const slug = controller.created?.slug;
          router.replace(slug === undefined ? "/console" : browseHref(slug));
        }}
        onCancel={() => router.back()}
      />
    </CreateWorkspaceChrome>
  );
}

/**
 * The page around a step. Separated from the screen for `WelcomeChrome`'s
 * reason: it can be rendered, and looked at, without a session or a deployment.
 */
export function CreateWorkspaceChrome({
  step,
  shape,
  children,
}: {
  step: WorkspaceStepKey;
  shape: WorkspaceFlowShape;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(27, 3.1, 38, width);

  return (
    <ScreenScroll
      style={styles.ground}
      contentContainerStyle={styles.scroll}
      chrome={CREATE_TAIL}
    >
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
          {workspaceStepTitle(step)}
        </Text>

        <View style={styles.card}>{children}</View>

        <Text variant="foot" style={styles.foot}>
          A workspace is a context several people share. Its notes live in a bucket you own,
          and `team` here means its members — never the internet.
        </Text>
      </View>
    </ScreenScroll>
  );
}

function StepBody({
  controller,
  onOpenWorkspace,
  onCancel,
}: {
  controller: CreateWorkspaceController;
  onOpenWorkspace: () => void;
  onCancel: () => void;
}) {
  switch (controller.step) {
    case "name":
      return <WorkspaceNameStep controller={controller} onCancel={onCancel} />;
    case "storage":
      return <WorkspaceStorageStep controller={controller} />;
    case "layout":
      return <WorkspaceLayoutStep controller={controller} />;
    case "people":
      return <WorkspacePeopleStep controller={controller} />;
    case "done":
      return <WorkspaceDoneStep controller={controller} onOpenWorkspace={onOpenWorkspace} />;
  }
}

/** The steps, as a row of labels. See `WelcomeChrome`'s `StepRail`. */
function StepRail({ step, shape }: { step: WorkspaceStepKey; shape: WorkspaceFlowShape }) {
  const styles = useThemedStyles(makeStyles);
  const steps = workspaceStepsFor(shape);
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
            {WORKSPACE_STEP_LABELS[key]}
          </Text>
        </View>
      ))}
    </View>
  );
}

const CREATE_TAIL = { bottom: 60 } as const;

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground },
  scroll: { minHeight: "100%" },
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

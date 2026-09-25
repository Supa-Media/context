import { StyleSheet, View, useWindowDimensions } from "react-native";
import { useConvex } from "convex/react";
import { densityFor } from "../../app/frame";
import { writeClipboard } from "../../design/clipboard";
import { BOOTSTRAP_PROMPT } from "../../onboarding/agents";
import { NEW_WORKSPACE_ROUTE } from "../../workspace/create";
import type { SettingsSectionKey } from "../settings/sections";
import type { SetupAgent } from "../../agentSetup/guides";
import { selectedContext, type ConsoleData } from "../types";
import { setupView, showSetupWidget } from "./rules";
import { SetupDone } from "./SetupDone";
import { SetupWidget } from "./SetupWidget";
import { useSetupWidget } from "./useSetupWidget";

/**
 * Where the first run carries on after the fork: the setup widget over the
 * owner's own workspace, and "You're set up." once all four rows are true.
 *
 * Mounted by the workspace route rather than inside `BrowsePane`, so the pane
 * — which the landing page's demo and the fixtures render with no Convex
 * client — never subscribes to grants. `pointerEvents="box-none"` on the layer
 * so the note underneath stays clickable everywhere the card is not.
 */
export function SetupWidgetHost({
  data,
  onOpenSettings,
  onNavigate,
  onConnectAgent,
}: {
  data: ConsoleData;
  onOpenSettings?: (section?: SettingsSectionKey) => void;
  onNavigate?: (href: string) => void;
  /** Opens the guided setup for one agent over this workspace. */
  onConnectAgent?: (agent: SetupAgent) => void;
}) {
  const { width } = useWindowDimensions();
  const convex = useConvex();
  const current = selectedContext(data);
  const compact = densityFor(width) === "compact";
  const eligible =
    data.demo !== true && !compact && current?.kind === "personal" && current.role === "owner";
  /*
    Nothing subscribes until the widget could be drawn, and nothing at all
    without a control plane to ask: the route is also rendered by fixtures
    and tests with no Convex client, and a subscription there throws.
  */
  if (!eligible || current === null || convex === undefined) return null;
  return (
    <SetupWidgetLive
      data={data}
      workspaceId={current.id}
      slug={current.slug}
      kind={current.kind}
      role={current.role}
      compact={compact}
      onOpenSettings={onOpenSettings}
      onNavigate={onNavigate}
      onConnectAgent={onConnectAgent}
    />
  );
}

function SetupWidgetLive({
  data,
  workspaceId,
  slug,
  kind,
  role,
  compact,
  onOpenSettings,
  onNavigate,
  onConnectAgent,
}: {
  data: ConsoleData;
  workspaceId: string;
  slug: string;
  kind: string;
  role: string;
  compact: boolean;
  onOpenSettings?: (section?: SettingsSectionKey) => void;
  onNavigate?: (href: string) => void;
  onConnectAgent?: (agent: SetupAgent) => void;
}) {
  const { grants, retired, retire } = useSetupWidget(workspaceId, true);
  if (!showSetupWidget({ demo: data.demo === true, compact, kind, role, retired })) return null;

  const view = setupView({ slug, storage: data.storage, grants });
  const copyBootstrap = () => writeClipboard(BOOTSTRAP_PROMPT);

  if (view.complete) {
    return (
      <View style={styles.center} pointerEvents="box-none">
        <SetupDone
          onClose={retire}
          onCopyBootstrap={copyBootstrap}
          onNewWorkspace={onNavigate ? () => onNavigate(NEW_WORKSPACE_ROUTE) : undefined}
        />
      </View>
    );
  }

  return (
    <View style={styles.corner} pointerEvents="box-none">
      <SetupWidget
        slug={slug}
        view={view}
        workspaceId={workspaceId}
        grants={grants}
        actions={{
          onOpenStorage: () => onOpenSettings?.("storage"),
          onOpenConnections: () => onOpenSettings?.("integrations"),
          onOpenGuide: (agent) => onConnectAgent?.(agent),
          onPutAway: retire,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  corner: { position: "absolute", right: 24, bottom: 24 },
  center: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 60,
    paddingHorizontal: 24,
  },
});

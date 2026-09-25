import { Pressable, StyleSheet, View } from "react-native";
import { useConvex, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Text } from "../design/components/Text";
import { pointerType, radii, space, touchType } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { GrantFacts } from "../onboarding/tools";
import { AGENT_NAMES, SETUP_AGENTS, type SetupAgent } from "./guides";
import { tileState, type TileState } from "./guideState";
import { useSetupProgress } from "./useSetupProgress";

/**
 * Claude and ChatGPT, side by side: where the guide starts and where it
 * resumes. Each tile says the one thing that matters — not started, how far,
 * or connected — and a connected tile is done, so it is not a button.
 */
export function AgentTiles({
  workspaceId,
  grants,
  onOpen,
  touch = false,
}: {
  workspaceId: string;
  grants: readonly GrantFacts[] | undefined;
  onOpen: (agent: SetupAgent) => void;
  /** Drawn at the phone's type sizes. */
  touch?: boolean;
}) {
  const s = useThemedStyles(touch ? touchStyles : pointerStyles);
  return (
    <View style={s.row} testID="agent-tiles">
      {SETUP_AGENTS.map((agent) => (
        <Tile key={agent} agent={agent} workspaceId={workspaceId} grants={grants} onOpen={onOpen} s={s} />
      ))}
    </View>
  );
}

/**
 * The tiles where nothing above them already holds the grants — the member's
 * welcome card. Subscribes only when there is a control plane to ask: the
 * browse pane is also drawn by the landing page's demo and by fixtures with
 * no Convex client, and there the tiles still show saved progress.
 */
export function LiveAgentTiles(props: { workspaceId: string; onOpen: (agent: SetupAgent) => void; touch?: boolean }) {
  const convex = useConvex();
  if (convex === undefined) return <AgentTiles {...props} grants={undefined} />;
  return <SubscribedTiles {...props} />;
}

function SubscribedTiles(props: { workspaceId: string; onOpen: (agent: SetupAgent) => void; touch?: boolean }) {
  const grants = useQuery(api.functions.grants.listGrants, {
    workspaceId: props.workspaceId as Id<"workspaces">,
  }) as GrantFacts[] | undefined;
  return <AgentTiles {...props} grants={grants} />;
}

function statusLine(state: TileState): string {
  if (state.kind === "connected") return "● Connected";
  if (state.kind === "partway") return `Step ${state.step} of ${state.of} · Continue →`;
  return "Set up →";
}

function Tile({
  agent,
  workspaceId,
  grants,
  onOpen,
  s,
}: {
  agent: SetupAgent;
  workspaceId: string;
  grants: readonly GrantFacts[] | undefined;
  onOpen: (agent: SetupAgent) => void;
  s: ReturnType<typeof pointerStyles>;
}) {
  const [progress] = useSetupProgress(workspaceId, agent);
  const state = tileState(agent, progress, grants);
  const name = AGENT_NAMES[agent];
  const line = statusLine(state);
  const connected = state.kind === "connected";
  return (
    <Pressable
      role={connected ? undefined : "button"}
      accessibilityLabel={`${name}: ${line.replace(/[●→]/g, "").trim()}`}
      disabled={connected}
      onPress={() => onOpen(agent)}
      // `hovered` is react-native-web's addition to the press state.
      style={(press) => [
        s.tile,
        state.kind === "partway" && s.tileGo,
        connected && s.tileOk,
        (press as { hovered?: boolean }).hovered === true && !connected && s.tileHover,
      ]}
      testID={`agent-tile-${agent}`}
    >
      <Text style={s.name}>{name}</Text>
      <Text style={[s.status, connected ? s.statusOk : s.statusGo]} numberOfLines={1}>
        {line}
      </Text>
    </Pressable>
  );
}

const build = (colors: Colors, t: typeof pointerType | typeof touchType) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: space.x2 },
    tile: {
      flex: 1,
      minWidth: 0,
      gap: 2,
      paddingVertical: 10,
      paddingHorizontal: space.x3,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.ground,
    },
    tileGo: { borderColor: colors.accent },
    tileOk: { borderColor: colors.okBorder, backgroundColor: colors.okWash },
    tileHover: { borderColor: colors.accent },
    name: { fontSize: t.ui, fontWeight: "600", color: colors.text },
    status: { fontSize: t.meta, fontWeight: "500" },
    statusGo: { color: colors.accentText },
    statusOk: { color: colors.okText },
  });

const pointerStyles = (colors: Colors) => build(colors, pointerType);
const touchStyles = (colors: Colors) => build(colors, touchType);

import type { Colors, MapColors } from "../../../../design/tokens/colors";
import type { AgentTintColors } from "../agentKind";

/**
 * Every colour the map draws with. The engine takes one of these and never
 * reads a theme itself, so it works the same in a test, a worker or the app.
 *
 * Teal (`accent`) is spent on a note being written live, a selected note, a
 * new note, and the texting assistant's badge (`agent.agentContext`, which is
 * the accent in both themes). Reading is drawn in `ink`.
 */
export type MapPalette = {
  ground: string;
  island: string;
  chip: string;
  line: string;
  text: string;
  text2: string;
  muted: string;
  dim: string;
  accent: string;
  dot: string;
  edge: string;
  zone: string;
  zoneLine: string;
  ink: string;
  /** A face with no picture: a silhouette on this ground. */
  faceGround: string;
  faceFigure: string;
  /** Each AI tool's tint and glyph (`agentKind.ts`): a robot or the texting badge. */
  agent: AgentTintColors;
  /** Soft drop shadows. */
  shadow: string;
};

/**
 * The map's palette from the app's tokens (`lightColors`/`darkColors`) and the
 * map's own shades (`lightMapColors`/`darkMapColors`), for the theme in use.
 */
export function mapPalette(colors: Colors, map: MapColors): MapPalette {
  return {
    ground: colors.pageSurface,
    island: map.island,
    chip: colors.surface3,
    line: colors.lineStrong,
    text: colors.text,
    text2: colors.text2,
    muted: colors.muted,
    dim: colors.chromeMuted,
    accent: colors.accent,
    dot: map.dot,
    edge: map.edge,
    zone: map.zone,
    zoneLine: map.zoneLine,
    ink: map.ink,
    faceGround: colors.anonymousGround,
    faceFigure: colors.anonymousFigure,
    agent: {
      agentClaude: map.agentClaude,
      agentCodex: map.agentCodex,
      agentChatgpt: map.agentChatgpt,
      agentContext: map.agentContext,
      agentBlue: map.agentBlue,
      agentPink: map.agentPink,
      agentAmber: map.agentAmber,
      agentGlyph: map.agentGlyph,
    },
    shadow: "rgba(0,0,0,0.18)",
  };
}

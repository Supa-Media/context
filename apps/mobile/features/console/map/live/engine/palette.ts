import type { BoardColors, Colors, MapColors } from "../../../../design/tokens/colors";
import type { DrawnBoard } from "../look";
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
  /** What the map is drawn on (paper, graph paper, brown paper, chalkboard, blueprint). See `draw/board.ts`. */
  board: DrawnBoard;
  /** Ruled lines on graph paper and blueprint, fixed to the window; null on the others. */
  grid: string | null;
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
    board: map.board,
    grid: null,
    ground: map.ground,
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

/**
 * The palette on a board the person chose in the map's settings. The board the
 * theme would pick anyway keeps the theme's own colours; any other brings its
 * whole set, words and cards included, so brown paper in dark mode still reads.
 */
export function withBoard(base: MapPalette, board: DrawnBoard, colors: BoardColors, dark: boolean): MapPalette {
  if (board === base.board) return base;
  const darkBoard = board === "chalk" || board === "blueprint";
  return {
    ...base,
    board,
    grid: colors.grid,
    ground: colors.ground,
    island: colors.island,
    dot: colors.dot,
    edge: colors.edge,
    zone: colors.zone,
    zoneLine: colors.zoneLine,
    ink: colors.ink,
    text: colors.text,
    text2: colors.text2,
    muted: colors.muted,
    dim: colors.dim,
    chip: colors.chip,
    line: colors.line,
    accent: colors.accent,
    shadow: darkBoard === dark ? base.shadow : darkBoard ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.14)",
  };
}

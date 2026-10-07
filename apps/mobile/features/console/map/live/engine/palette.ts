import type { Colors, MapColors } from "../../../../design/tokens/colors";

/**
 * Every colour the map draws with. The engine takes one of these and never
 * reads a theme itself, so it works the same in a test, a worker or the app.
 *
 * Teal (`accent`) is spent on exactly three things: a note being written live,
 * a selected note, and a new note. Reading is drawn in `ink`.
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
    shadow: "rgba(0,0,0,0.18)",
  };
}

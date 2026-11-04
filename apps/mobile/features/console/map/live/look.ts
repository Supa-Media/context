/**
 * How the live map is drawn, as the person chose it in the map's settings
 * (Dev2, 2026-11-04: "I really like the fact that this is all customizable").
 * One record per account (`apps/convex/functions/mapLook.ts`), so the map
 * opens the same way on the phone, in the browser and in the desktop app.
 *
 * Pure: no React, no Convex. A stored record from an older or newer app is
 * read through `lookOf`, which keeps what it understands and falls back to the
 * default for the rest, so a bad row can never break the map.
 */

export type Board = "auto" | "paper" | "graph" | "kraft" | "chalk" | "blueprint";
/** A board as drawn: "auto" resolved against the theme. */
export type DrawnBoard = Exclude<Board, "auto">;

export type MapLook = {
  /** What the map is drawn on. "auto" is paper in light mode and chalkboard in dark. */
  board: Board;
  /** How rough the pencil is: 0 neat, 1 messy. Lines bow and get a second pass, dots a loose ring. */
  sketch: number;
  colorBy: "topic" | "folder" | "workspace" | "pressure" | "none";
  names: "busy" | "all" | "hover";
  textSize: number;
  lines: "all" | "near" | "hover";
  /** Far out, the links between two folders are drawn as one pencil stroke. */
  mergeLines: boolean;
  lineWidth: number;
  dotSize: number;
  spread: number;
  /** How somebody reading a note is shown. */
  reading: "circle" | "pulse" | "halo";
  /** What happens when the map opens. */
  opening: "sketch" | "bloom" | "order" | "zoom";
  /** Dots breathe very slightly, or stay still. Nothing ever moves away from the cursor. */
  motion: "breathe" | "still";
  /** The drawing given depth, tilting a little with the mouse. */
  depth: boolean;
  showArchive: boolean;
  showOrphans: boolean;
  showAgents: boolean;
};

/**
 * Everyone's starting point: the look @shyoh had set on their account, made
 * the default by Dev2 (2026-11-04), read with the `Map look of a person`
 * workflow. Before that it was Dev2's prototype settings.
 */
export const DEFAULT_LOOK: MapLook = {
  board: "auto",
  sketch: 1,
  colorBy: "topic",
  names: "all",
  textSize: 14,
  lines: "near",
  mergeLines: true,
  lineWidth: 0.75,
  dotSize: 1.2,
  spread: 1.8,
  reading: "circle",
  opening: "bloom",
  motion: "breathe",
  depth: true,
  showArchive: true,
  showOrphans: true,
  showAgents: true,
};

/** The allowed range of each number, as the settings' sliders and the server both hold them. */
export const LOOK_RANGES = {
  sketch: [0, 1],
  textSize: [10, 18],
  lineWidth: [0.4, 2.5],
  dotSize: [0.5, 2],
  spread: [0.6, 1.8],
} as const satisfies Record<string, readonly [number, number]>;

const CHOICES = {
  board: ["auto", "paper", "graph", "kraft", "chalk", "blueprint"],
  colorBy: ["topic", "folder", "workspace", "pressure", "none"],
  names: ["busy", "all", "hover"],
  lines: ["all", "near", "hover"],
  reading: ["circle", "pulse", "halo"],
  opening: ["sketch", "bloom", "order", "zoom"],
  motion: ["breathe", "still"],
} as const;

const FLAGS = ["mergeLines", "depth", "showArchive", "showOrphans", "showAgents"] as const;

/** A stored or partial record as a whole look: unknown values become the default. */
export function lookOf(raw: unknown): MapLook {
  const out: MapLook = { ...DEFAULT_LOOK };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const [key, allowed] of Object.entries(CHOICES) as Array<[keyof typeof CHOICES, readonly string[]]>) {
    const v = r[key];
    if (typeof v === "string" && allowed.includes(v)) (out as Record<string, unknown>)[key] = v;
  }
  for (const [key, [lo, hi]] of Object.entries(LOOK_RANGES) as Array<[keyof typeof LOOK_RANGES, readonly [number, number]]>) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.min(hi, Math.max(lo, v));
  }
  for (const key of FLAGS) {
    const v = r[key];
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

/** The board as drawn, with "auto" following the theme. */
export function drawnBoard(board: Board, dark: boolean): DrawnBoard {
  if (board !== "auto") return board;
  return dark ? "chalk" : "paper";
}

/** Whether a board is dark: light pencil on it, as chalk is. */
export const isDarkBoard = (board: DrawnBoard): boolean => board === "chalk" || board === "blueprint";

/** Two looks the same, for skipping a save that would change nothing. */
export function sameLook(a: MapLook, b: MapLook): boolean {
  return (Object.keys(DEFAULT_LOOK) as Array<keyof MapLook>).every((k) => a[k] === b[k]);
}

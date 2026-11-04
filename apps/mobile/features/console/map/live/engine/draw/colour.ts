import type { NotePlace } from "../layout";
import { noteKey } from "../paths";
import type { Model } from "../scene";
import { mapPencils } from "../../../../../design/tokens/colors";
import { isDarkBoard } from "../../look";
import type { DrawEnv } from "./env";

/**
 * What colour a note's dot is drawn in: the map's settings "Colour by"
 * (Dev2, 2026-11-04). Coloured pencils, a set for light boards and a lighter
 * set for dark ones, so every board keeps its contrast.
 *
 * - **workspace** (the default): one pencil per workspace.
 * - **folder**: one per folder, so neighbouring folders differ.
 * - **topic**: one per subfolder, the closest thing to a topic the tree has.
 * - **pressure**: how recently a note was written: dark for the past week,
 *   faint for older.
 * - **none**: one pencil, the board's own.
 */

export const PENCILS_LIGHT = mapPencils.light;
export const PENCILS_DARK = mapPencils.dark;

/** A week: written within it is pressed hard. */
export const PRESSURE_MS = 7 * 24 * 3600 * 1000;

const hashOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** When each note was last written, from the map's events. */
const written = new WeakMap<Model["events"], Map<string, number>>();
function lastWritten(model: Model): Map<string, number> {
  const known = written.get(model.events);
  if (known) return known;
  const out = new Map<string, number>();
  for (const e of model.events) {
    if (e.kind !== "edit" && e.kind !== "create") continue;
    const key = noteKey(e.workspaceId, e.path);
    out.set(key, Math.max(out.get(key) ?? 0, e.at));
  }
  written.set(model.events, out);
  return out;
}

/** The colour of each note's dot in this frame. */
export function dotColour(env: DrawEnv): (n: NotePlace) => string {
  const { style, model } = env;
  const C = style.palette;
  const by = style.look.colorBy;
  if (by === "none") return () => C.dot;
  const pens = isDarkBoard(C.board) ? PENCILS_DARK : PENCILS_LIGHT;
  if (by === "pressure") {
    const at = lastWritten(model);
    const now = env.scene.t;
    return (n) => (now - (at.get(n.key) ?? -Infinity) < PRESSURE_MS ? C.ink : C.dim);
  }
  if (by === "workspace") {
    const index = new Map(model.layout.islands.map((island, i) => [island.workspaceId, i]));
    return (n) => pens[(index.get(n.workspaceId) ?? 0) % pens.length]!;
  }
  if (by === "folder") return (n) => pens[hashOf(n.sub.folder.key) % pens.length]!;
  return (n) => pens[hashOf(n.sub.key) % pens.length]!;
}

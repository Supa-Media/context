/**
 * Whether a sheet is kept up to date by a source that syncs it (the data
 * sources board, 08): a CSV directly in a source folder of the data folder
 * whose `about.md` says `source: github`, `cloudflare`, `stripe` or `url`
 * (Fetch from a URL). Such a sheet is read-only in the app, which says so,
 * since the next sync replaces whatever an edit wrote
 * (`docs/decisions/data-and-metrics.md`).
 *
 * A push source's sheet ("Send from your code") only gains rows, and the
 * Context source's datasets are counted when read, never written, so neither
 * is "kept up to date" this way. Pure.
 */

import { isSheetPath } from "@context/shared/src/fileKinds.cjs";
import type { ListNote } from "../listBlock/model";
import { metricsFolderOf, sourceAt, type SourceKind } from "./sources";

/** The sources whose sync replaces a sheet's rows. */
const SYNCED: ReadonlySet<SourceKind> = new Set<SourceKind>(["github", "cloudflare", "stripe", "fetch"]);

/** `<data>/<source>` for a CSV directly in a source folder of the data folder; null for any other path. */
export function sourceFolderOfSheet(path: string | null, dataFolder: string): string | null {
  if (path === null || dataFolder === "" || !isSheetPath(path)) return null;
  const prefix = `${dataFolder}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length).split("/");
  if (rest.length !== 2 || rest[0] === "") return null;
  const folder = `${prefix}${rest[0]}`;
  return folder === metricsFolderOf(dataFolder) ? null : folder;
}

export interface KeptBy {
  /** The source as drawn: "GitHub", or a url source's own name. */
  readonly name: string;
  /** Its folder, which the banner's link opens. */
  readonly folder: string;
}

/** The source that keeps `path` up to date, from the reader's notes of its folder; null when none does. */
export function keptBy(path: string | null, dataFolder: string, notes: readonly ListNote[]): KeptBy | null {
  const folder = sourceFolderOfSheet(path, dataFolder);
  if (folder === null) return null;
  const source = sourceAt(folder, () => undefined, notes);
  return SYNCED.has(source.kind) ? { name: source.name, folder } : null;
}

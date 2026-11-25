/**
 * The data folder's sources, read from what the file browser already lists:
 * each subfolder of the data folder but its own `metrics/` is one source, its
 * `about.md` says what kind (`source:`) and what it is called (`name:`), and
 * its datasets are the plain CSV sheets beside it (the data sources boards, 01
 * and 07; `docs/decisions/data-and-metrics.md`), and any sheet kept elsewhere
 * that its `about.md` links under `sheets:` (`apps/mcp/src/data/sheetLinks.js`).
 *
 * Pure. The listings and notes are the reader's own, at their clearance, so a
 * source or sheet a reader cannot see is simply not here.
 */

import { isSheetPath } from "@context/shared/src/fileKinds.cjs";
import type { ListNote, PropertyValue } from "../listBlock/model";
import type { FolderListing } from "../types";
import { ABOUT_NOTE, baseName } from "../paths";
import { linkedSheets } from "../../../../../mcp/src/data/sheetLinks.js";

export type SourceKind = "github" | "cloudflare" | "stripe" | "context" | "usage" | "push" | "fetch" | "other";

/** The apps a workspace connects once, by the name the board draws. */
const KIND_NAMES: Readonly<Record<SourceKind, string | null>> = {
  github: "GitHub",
  cloudflare: "Cloudflare",
  stripe: "Stripe",
  context: "Context",
  usage: "Context usage",
  push: null,
  fetch: null,
  other: null,
};

/**
 * The Context usage source's sheets (`apps/mcp/src/data/sync/runUsage.js`): Context-wide activity, kept up to date
 * every hour in the one workspace the deployment names, owners only, and one row per bug report people sent.
 */
export const USAGE_SHEETS = ["activity", "sign-ups", "tex-replies", "calls", "bug-reports"] as const;

/** The built-in Context source's datasets, worked out from notes when read (`contextSource.ts`). */
export const CONTEXT_DATASETS = ["notes-by-status", "time-to-answered"] as const;

/**
 * A source that signs in somewhere: its settings say where the sign-in is kept. A url source sends no
 * credential (`apps/mcp/src/data/fetch/url.js`), so it signs in nowhere.
 */
export function signsIn(kind: SourceKind): boolean {
  return kind === "github" || kind === "cloudflare" || kind === "stripe";
}

export interface Dataset {
  /** `pull-requests`: the sheet's name without `.csv`, as a formula names it. */
  readonly name: string;
  readonly path: string;
  /** Worked out when read and never written: the Context source's own. */
  readonly computed: boolean;
}

export interface DataSource {
  readonly folder: string;
  /** The folder's own name: what a formula calls it (`github` in `github/pull-requests.deployed`). */
  readonly slug: string;
  readonly kind: SourceKind;
  /** As drawn: `name:` in its about.md, else the app's name, else the folder's. */
  readonly name: string;
  readonly aboutPath: string;
  readonly about: ListNote | null;
  readonly datasets: readonly Dataset[];
}

export function textOf(value: PropertyValue | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return "";
}

export function listOf(value: PropertyValue | undefined): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" && value.trim() !== "" ? value.split(",") : [];
  return raw.map((item) => item.trim()).filter((item) => item !== "");
}

export function sourceKindOf(value: PropertyValue | undefined): SourceKind {
  const word = textOf(value).toLowerCase();
  if (word === "github" || word === "cloudflare" || word === "stripe" || word === "context" || word === "usage" || word === "push" || word === "fetch") return word;
  // "Fetch from a URL" writes `source: url` (`dataWrites.ts`), as the sync object reads it.
  if (word === "url") return "fetch";
  // "Send from your code", as the connect dialog calls it.
  if (word === "code" || word === "send") return "push";
  return "other";
}

const inside = (folder: string) => (folder === "" ? "" : `${folder}/`);

/** The metrics folder inside the data folder: `<data>/metrics`. */
export function metricsFolderOf(dataFolder: string): string {
  return `${inside(dataFolder)}metrics`;
}

/** What a folder under the data folder is: the Data page, the metrics folder, a source, or none of those. */
export type DataPageKind = "data" | "metrics" | "source";

export function dataPageKind(path: string, dataFolder: string): DataPageKind | null {
  if (path === dataFolder) return "data";
  if (!path.startsWith(inside(dataFolder)) || dataFolder === "") return null;
  const rest = path.slice(inside(dataFolder).length);
  if (rest === "" || rest.includes("/")) return null;
  return rest === "metrics" ? "metrics" : "source";
}

function sourceOf(folder: string, listing: FolderListing | undefined, notes: readonly ListNote[]): DataSource {
  const aboutPath = `${folder}/${ABOUT_NOTE}`;
  const about = notes.find((note) => note.path === aboutPath) ?? null;
  const kind = sourceKindOf(about?.properties.source);
  const slug = baseName(folder);
  const named = textOf(about?.properties.name);
  const sheets: Dataset[] = (listing?.entries ?? [])
    .filter((entry) => entry.kind === "file" && isSheetPath(entry.name))
    .map((entry) => ({ name: entry.name.slice(0, -4), path: entry.path, computed: false }));
  const datasets =
    kind === "context"
      ? [
          ...CONTEXT_DATASETS.map((name) => ({ name, path: `${folder}/${name}.csv`, computed: true })),
          ...sheets.filter((sheet) => !(CONTEXT_DATASETS as readonly string[]).includes(sheet.name)),
        ]
      : sheets;
  // A sheet kept with the work it measures (an area's own folder), linked from the about note: named like one beside it.
  const linked = linkedSheets(about?.properties, datasets.map((each) => each.name)).map((each) => ({ ...each, computed: false }));
  return { folder, slug, kind, name: named || KIND_NAMES[kind] || slug, aboutPath, about, datasets: [...datasets, ...linked] };
}

/**
 * Every source in the data folder, in its listing's order: each subfolder but
 * `metrics/`. A source whose own listing has not come yet has no datasets yet.
 */
export function sourcesIn(
  dataFolder: string,
  listingOf: (path: string) => FolderListing | undefined,
  notes: readonly ListNote[],
): DataSource[] {
  const metrics = metricsFolderOf(dataFolder);
  return (listingOf(dataFolder)?.entries ?? [])
    .filter((entry) => entry.kind === "folder" && entry.path !== metrics)
    .map((entry) => sourceOf(entry.path, listingOf(entry.path), notes));
}

/** One source by its folder. */
export function sourceAt(folder: string, listingOf: (path: string) => FolderListing | undefined, notes: readonly ListNote[]): DataSource {
  return sourceOf(folder, listingOf(folder), notes);
}

/** The source a formula's `source/` names, by its folder's name. */
export function sourceBySlug(sources: readonly DataSource[]): (slug: string) => DataSource | undefined {
  const bySlug = new Map(sources.map((source) => [source.slug.toLowerCase(), source]));
  return (slug) => bySlug.get(slug.toLowerCase());
}

/**
 * Two columns of cards, each card going under the shorter column, as the
 * board's masonry lays them: GitHub and Context on the left, Cloudflare,
 * Stripe and Eval CI on the right.
 */
export function cardColumns<T extends { datasets: readonly unknown[] }>(cards: readonly T[]): [T[], T[]] {
  const columns: [T[], T[]] = [[], []];
  const heights = [0, 0];
  for (const card of cards) {
    const at = heights[1]! < heights[0]! ? 1 : 0;
    columns[at].push(card);
    heights[at] += 2 + card.datasets.length;
  }
  return columns;
}

/**
 * The sources a reader's notes of the data folder name, where no listing is
 * at hand (a metric note opened on its own): each `<data>/<folder>/about.md`.
 * Their sheets are not known from notes; a formula names the ones it reads.
 */
export function sourcesFromNotes(dataFolder: string, notes: readonly ListNote[]): DataSource[] {
  const prefix = inside(dataFolder);
  const metrics = metricsFolderOf(dataFolder);
  const out: DataSource[] = [];
  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue;
    const rest = note.path.slice(prefix.length).split("/");
    if (rest.length !== 2 || rest[1] !== ABOUT_NOTE) continue;
    const folder = `${prefix}${rest[0]}`;
    if (folder === metrics) continue;
    out.push(sourceOf(folder, undefined, notes));
  }
  return out;
}

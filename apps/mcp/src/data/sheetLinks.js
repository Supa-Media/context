/**
 * A source's sheets kept outside its folder (`docs/decisions/data-and-metrics.md`, "A source's sheet can live
 * anywhere"). The source's `about.md` names each one in its front matter, as a link:
 *
 *     sheets: ["[[areas/operations/Filings/filings.csv]]"]
 *
 * The metric still names it `<source>/<dataset>`, the dataset being the sheet's file name. A link, not a bare path,
 * because the move engines already follow a link when what it points at moves: renaming the area keeps the metric
 * working. Nothing is searched for: only the sheets named here are read, beside the ones in the source's own folder.
 *
 * Pure and shared by the app (`apps/mobile/.../data/sources.ts`) and the hourly keep (`sync/snap.js`), so both read
 * one list. A value that is not a `.csv` path from the workspace's root is left out rather than guessed at.
 */

import { isSheetPath } from "../../../../packages/shared/src/fileKinds.cjs";

const WIKI = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/;
const MARKDOWN = /^\[[^\]]*\]\(<?([^)>]+)>?\)$/;

/** One `sheets:` value as a workspace path, or null: `[[a/b.csv]]`, `[b](a/b.csv)` or `a/b.csv`. */
export function linkedSheetPath(value) {
  if (typeof value !== "string") return null;
  let text = value.trim();
  const wiki = WIKI.exec(text);
  const markdown = wiki ? null : MARKDOWN.exec(text);
  if (wiki) text = wiki[1].trim();
  else if (markdown) text = markdown[1].trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  text = text.replace(/^\/+/, "");
  if (text === "" || !isSheetPath(text)) return null;
  const parts = text.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** A dataset's name: its sheet's file name without `.csv`. */
export function datasetNameOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.slice(0, -4);
}

/**
 * The sheets a source's about note links, from its front matter's `sheets` (a list, or one value), as
 * `[{name, path}]`: first one wins for a name, and a name its own folder already has is left to the folder.
 */
export function linkedSheets(properties, ownNames = []) {
  const raw = properties?.sheets;
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const taken = new Set(ownNames.map((name) => String(name).toLowerCase()));
  const out = [];
  for (const value of values) {
    const path = linkedSheetPath(value);
    if (path === null) continue;
    const name = datasetNameOf(path);
    if (name === "" || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    out.push({ name, path });
  }
  return out;
}

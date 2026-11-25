/**
 * What Connect a source writes, a push source's folder (its about.md and its
 * one dataset) and a url source's (its about.md and its empty dataset), and
 * the formula the metric builder starts from; the metric note itself is
 * `metricDraft.ts`. Pure: the text and the paths, never a write.
 *
 * Nothing written here carries a value or a credential. A push source's key is made
 * afterwards by the sheet's own key flow and kept in the control plane, never
 * in a file (`docs/decisions/app-and-console/sheet-sources.md`).
 */

import { parseHeaderCell, renderHeaderCell } from "../../../../../mcp/src/sheets/csv.js";
import type { DataSource } from "./sources";
import type { Sheet } from "./workOut";

/** "Eval CI" → `eval-ci`; "" when nothing usable is left. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** `<folder>/<base><ext>`, or `<base>-2<ext>` and on, whichever is not taken. */
export function freePath(folder: string, base: string, ext: string, taken: ReadonlySet<string>): string {
  const at = (name: string) => `${folder}/${name}${ext}`;
  if (!taken.has(at(base))) return at(base);
  for (let n = 2; n < 1000; n += 1) if (!taken.has(at(`${base}-${n}`))) return at(`${base}-${n}`);
  return at(`${base}-${Date.now()}`);
}

/** A formula to start from: a count over the first sheet this reader has, else a shape to fill in. */
export function startingFormula(sources: readonly DataSource[], sheets: ReadonlyMap<string, Sheet | null>): string {
  for (const source of sources) {
    for (const dataset of source.datasets) {
      const column = sheets.get(dataset.path)?.columns[0]?.name;
      if (column !== undefined && /^[a-z0-9 _-]+$/i.test(column) && /^[a-z0-9_-]+$/i.test(source.slug) && /^[a-z0-9_-]+$/i.test(dataset.name)) {
        return `count(${source.slug}/${dataset.name}.${column})`;
      }
    }
  }
  return "count(source/dataset.column)";
}

/** The columns a person typed, `suite, p95 ms:number`, as header cells, with a date column first when they named none. */
export function datasetHeader(typed: string): string {
  const columns = typed
    .split(",")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "")
    .map((cell) => parseHeaderCell(cell) as { name: string; type: string });
  const seen = new Set<string>();
  const unique = columns.filter((column) => {
    const key = column.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.some((column) => column.type === "date")) unique.unshift({ name: "date", type: "date" });
  return `${unique.map((column) => renderHeaderCell(column) as string).join(",")}\n`;
}

export interface PushSourceFiles {
  readonly folder: string;
  readonly about: { readonly path: string; readonly text: string };
  readonly sheet: { readonly path: string; readonly text: string };
}

/** A push source's folder: `<data>/<slug>/about.md` saying `source: push`, and its one dataset. */
export function pushSourceFiles(dataFolder: string, name: string, dataset: string, columns: string, taken: ReadonlySet<string>): PushSourceFiles | string {
  const slug = slugOf(name);
  const sheetSlug = slugOf(dataset);
  if (slug === "" || slug === "metrics") return "Give the source a name with a letter or a number in it.";
  if (sheetSlug === "") return "Give the dataset a name with a letter or a number in it.";
  const folder = `${dataFolder}/${slug}`;
  if ([...taken].some((path) => path === folder || path.startsWith(`${folder}/`))) return `There is already a source called ${slug}.`;
  const display = name.replace(/[\r\n]+/g, " ").trim();
  return {
    folder,
    about: {
      path: `${folder}/about.md`,
      text: [
        "---",
        "source: push",
        `name: ${JSON.stringify(display)}`,
        "---",
        "",
        "Rows sent from your code. Anything with a key can add rows here; nothing can read them back with it.",
        "",
      ].join("\n"),
    },
    sheet: { path: `${folder}/${sheetSlug}.csv`, text: datasetHeader(columns) },
  };
}

export interface UrlSourceFiles {
  readonly folder: string;
  readonly about: { readonly path: string; readonly text: string };
  /** Empty: the first sync writes its header and rows (`apps/mcp/src/data/sync/run.js`). */
  readonly sheet: { readonly path: string; readonly text: string };
}

/**
 * The address a person typed, as the sync object will take it: https on a public name, no port or login, and no
 * IP address (`apps/mcp/src/data/fetch/url.js` `publicHttps`, which decides on every run; this only says so early).
 */
export function publicAddress(typed: string): URL | null {
  let url: URL;
  try {
    url = new URL(typed.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa|intranet|lan|corp)$/.test(host)) return null;
  return url;
}

/**
 * A Fetch from a URL source's folder: `<data>/<host>/about.md` saying `source: url`, its address and dataset, and the
 * dataset's empty sheet beside it, named for the host (`status-example-com`), or `-2` and on when that is taken.
 */
export function urlSourceFiles(dataFolder: string, address: string, dataset: string, taken: ReadonlySet<string>): UrlSourceFiles | string {
  const url = publicAddress(address);
  if (url === null) return "Give an https address on a public name, with no port, login or IP address.";
  const sheetSlug = slugOf(dataset);
  if (sheetSlug === "") return "Give the dataset a name with a letter or a number in it.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  const base = slugOf(host) || "url";
  const free = (name: string) => ![...taken].some((path) => path === `${dataFolder}/${name}` || path.startsWith(`${dataFolder}/${name}/`));
  let slug = base === "metrics" ? "metrics-url" : base;
  for (let n = 2; !free(slug) && n < 1000; n += 1) slug = `${base}-${n}`;
  const folder = `${dataFolder}/${slug}`;
  return {
    folder,
    about: {
      path: `${folder}/about.md`,
      text: [
        "---",
        "source: url",
        `name: ${JSON.stringify(host)}`,
        `url: ${JSON.stringify(url.href)}`,
        `dataset: ${sheetSlug}`,
        "---",
        "",
        "Context reads this address every hour and keeps what it answers in the sheet beside this note. Add key: with the column that tells rows apart when the answer has several rows, and date: with the column a row is dated by.",
        "",
      ].join("\n"),
    },
    sheet: { path: `${folder}/${sheetSlug}.csv`, text: "" },
  };
}

/**
 * The apps an owner connects with a read-only key here, and the one dataset each keeps (`apps/mcp/src/data/connect/apps.js`).
 * The payments app on board 02 waits on the gateway, which can't name it yet (`scripts/check-exit-is-ungated.mjs`).
 */
export const APP_DATASETS = { cloudflare: "ai-spend" } as const;
export type ConnectApp = keyof typeof APP_DATASETS;

const APP_NAMES: Readonly<Record<ConnectApp, string>> = { cloudflare: "Cloudflare" };

export interface AppSourceFiles {
  readonly app: ConnectApp;
  readonly folder: string;
  /** Written only when the folder has no about.md yet; a source already there is connected again as it is. */
  readonly about: { path: string; text: string } | null;
  readonly sheet: { path: string; text: string } | null;
  /** The key as pasted, and the Cloudflare account it reads when the token reaches several. Sent once, never written. */
  readonly key: string;
  readonly account?: string;
}

const APP_LINES: Readonly<Record<ConnectApp, string>> = {
  cloudflare: "AI Gateway's spend by day, gateway, provider and model, synced every hour into ai-spend.csv in US dollars.",
};

/**
 * An app source's folder and its empty sheet, for an owner's Connect. Its about.md says only what it is: the key is
 * never in a file. A source already connected for this app (`existing`) is reused, so connecting again swaps the key.
 */
export function appSourceFiles(dataFolder: string, app: ConnectApp, input: { key: string; account?: string }, existing: DataSource | null, taken: ReadonlySet<string>): AppSourceFiles | string {
  const key = input.key.trim();
  if (key === "") return "Paste an API token.";
  const account = input.account?.trim() ?? "";
  const sendAccount = account === "" ? {} : { account };
  const dataset = APP_DATASETS[app];
  if (existing !== null) {
    const sheetPath = `${existing.folder}/${dataset}.csv`;
    const hasSheet = existing.datasets.some((each) => each.path === sheetPath);
    return {
      app,
      folder: existing.folder,
      about: existing.about === null ? { path: existing.aboutPath, text: appAboutText(app) } : null,
      sheet: hasSheet ? null : { path: sheetPath, text: "" },
      key,
      ...sendAccount,
    };
  }
  let slug: string = app;
  for (let n = 2; [...taken].some((path) => path === `${dataFolder}/${slug}` || path.startsWith(`${dataFolder}/${slug}/`)) && n < 1000; n += 1) slug = `${app}-${n}`;
  const folder = `${dataFolder}/${slug}`;
  return { app, folder, about: { path: `${folder}/about.md`, text: appAboutText(app) }, sheet: { path: `${folder}/${dataset}.csv`, text: "" }, key, ...sendAccount };
}

function appAboutText(app: ConnectApp): string {
  return ["---", `source: ${app}`, `name: ${JSON.stringify(APP_NAMES[app])}`, `dataset: ${APP_DATASETS[app]}`, "---", "", `${APP_LINES[app]} An owner connected it with a read-only key, which Context keeps sealed and never writes here.`, ""].join("\n");
}

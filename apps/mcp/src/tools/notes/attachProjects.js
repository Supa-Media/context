/**
 * `manage area` `attach` and `detach`: which area a project serves, as one line in the project's front note,
 * `area: areas/<folder>`, the line the app's area panel writes and `orient { area }` reads
 * (`docs/decisions/app-and-console/areas-as-seats.md`, "A project serves an area"; the owner, 2026-11-25).
 *
 * A project stays where it is in the Projects folder; only that line changes. One project serves one area, so
 * attaching one that serves another moves it. Detaching removes the line only when it names this area or one inside
 * it, so a call aimed at the wrong area never unhooks a project from the one it serves. A project this connection
 * cannot see is answered exactly like one that is not there.
 */

import { FRONT_NOTES } from "../../lists/grammar.js";
import { normalizePath } from "../../notes/paths.js";
import { isVisibleTextFile } from "../../orient/survey.js";
import { factProps } from "../../tree/facts.js";
import { servedListingStore } from "../../tree/served.js";

const MAX_PROJECTS = 50;

const areaKey = (value) => String(value ?? "").trim().replace(/^@+/, "").replace(/^\/+|\/+$/g, "").toLowerCase();

/** A list of project folders from a string or an array; `null` when it is neither. */
function foldersOf(value) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (list === null || list.length > MAX_PROJECTS || list.some((item) => typeof item !== "string")) return null;
  return list.map((item) => normalizePath(item.trim().replace(/\/(about|overview|index|README)\.md$/i, "").replace(/\/+$/, ""))).filter(Boolean);
}

/**
 * @param {object} ctx
 * @param {any} ctx.store
 * @param {string} ctx.scope
 * @param {any} ctx.rules
 * @param {any} ctx.overrides
 * @param {string} ctx.area the area's folder, already checked to be under the Areas folder
 * @param {string} ctx.projectsRoot
 * @param {(path: string, changes: [string, any][], options?: { create?: boolean }) => Promise<any>} ctx.change setArea's write
 * @param {{ attach?: unknown, detach?: unknown }} args
 * @returns {Promise<{ error?: string, done: string[], problems: string[] }>}
 */
export async function attachProjects({ store, scope, rules, overrides, area, projectsRoot, change }, args) {
  const done = [];
  const problems = [];
  if (args.attach === undefined && args.detach === undefined) return { done, problems };
  const attach = args.attach === undefined ? [] : foldersOf(args.attach);
  const detach = args.detach === undefined ? [] : foldersOf(args.detach);
  if (attach === null || detach === null) {
    return { error: `invalid: attach and detach are a project's folder, or a list of up to ${MAX_PROJECTS}, like "${projectsRoot}/website".`, done, problems };
  }
  // A tool call's store has no `treeEntries` of its own (orient's does): the names come from the Convex tree.
  const listing = typeof store?.treeEntries === "function" ? store : servedListingStore(store);
  const visible = await Promise.resolve().then(() => listing.treeEntries()).catch(() => null);
  if (visible === null) return { error: "this workspace's map cannot be read just now; try again shortly.", done, problems };
  const keys = visible.map(({ key }) => key).filter((key) => isVisibleTextFile(key, scope, rules, overrides));
  if (!keys.some((key) => key.startsWith(`${area}/`))) {
    return { error: `No area at ${area}/ that this connection can see. Call orient with no area to see the map, then try again with an area from it.`, done, problems };
  }

  /** The project's front note: the first of FRONT_NOTES it has, or `about.md` to make. */
  const frontOf = (folder) => {
    for (const name of FRONT_NOTES) if (keys.includes(`${folder}/${name}`)) return { path: `${folder}/${name}`, create: false };
    return keys.some((key) => key.startsWith(`${folder}/`)) ? { path: `${folder}/about.md`, create: true } : null;
  };
  const check = (folder) => {
    if (!folder.startsWith(`${projectsRoot}/`)) return `${folder} is not a project: a project is a folder in ${projectsRoot}/.`;
    return frontOf(folder) === null ? `${folder} isn't there, or this connection can't see it. Check it with fetch { id: "${projectsRoot}/" }.` : null;
  };

  for (const folder of attach) {
    const wrong = check(folder);
    if (wrong !== null) {
      problems.push(wrong);
      continue;
    }
    const front = frontOf(folder);
    const wrote = await change(front.path, [["area", area]], { create: front.create });
    if (wrote.error) problems.push(wrote.error);
    else done.push(wrote.unchanged ? `${folder}: already serves ${area}` : `${folder}: now serves ${area} (area line in ${front.path})`);
  }

  for (const folder of detach) {
    const wrong = check(folder);
    if (wrong !== null) {
      problems.push(wrong);
      continue;
    }
    const front = frontOf(folder);
    const said = front.create ? "" : String((await factProps(store, [front.path]))?.get(front.path)?.props?.properties?.area ?? "").trim();
    const saidKey = areaKey(said);
    if (saidKey === "" || /^(true|false)$/.test(saidKey)) {
      done.push(`${folder}: serves no area already`);
      continue;
    }
    if (saidKey !== areaKey(area) && !saidKey.startsWith(`${areaKey(area)}/`)) {
      problems.push(`${folder} serves ${said}, not ${area}, so it was left as it is`);
      continue;
    }
    const wrote = await change(front.path, [["area", null]]);
    if (wrote.error) problems.push(wrote.error);
    else done.push(`${folder}: no longer serves ${said}`);
  }
  return { done, problems };
}

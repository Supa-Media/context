/**
 * What this machine and this project say about how Context is used.
 *
 * Three places, in order of precedence after flags and environment:
 *
 *  1. `.context.json` in the project, found by walking up from the working
 *     directory and stopping below the home directory. Committed by default, so
 *     a team shares it: it may say which workspace the project belongs to and
 *     whether sessions there are captured. It may NOT say where the server is:
 *     a file anybody can commit to a repository must never be able to send this
 *     machine's credential to a host of their choosing.
 *  2. `~/.context/config.json`, this person's own settings.
 *  3. The defaults below.
 *
 * Credentials are not here. They live in `credentials.json` (config.js), which
 * nothing in this module reads or prints.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { baseEndpoint, writeConfig } from "./config.js";

export const DEFAULT_ENDPOINT = "https://mcp.context.lc/mcp";
export const PROJECT_FILE = ".context.json";

export const DEFAULTS = Object.freeze({
  endpoint: DEFAULT_ENDPOINT,
  workspace: null,
  personal: null,
  capture: "on",
  captureExclude: [],
  captureTo: "personal",
  orient: "instruction",
});

/** The keys a project file may set. `endpoint` is deliberately absent. */
const PROJECT_KEYS = ["workspace", "capture", "captureTo"];

/**
 * A project file may NARROW what is captured, never widen it.
 *
 * `capture` defaults to `on`, so a project saying `on` changes nothing for
 * anybody except the person who ran `config set capture off` — and the README
 * tells them that turns it off *everywhere*. A file anybody can commit to a
 * repository is not that person, and this file already refuses that reasoning
 * once: `endpoint` is absent from `PROJECT_KEYS` because a committed file must
 * not choose where a credential is sent.
 *
 * `captureExclude` has never been project-settable for the same reason — a
 * repository cannot shrink the folders somebody excluded — and overriding the
 * global off was the same widening by a different door.
 *
 * Turning capture *off* for one repository stays exactly as it was: that is
 * the affordance the header above describes, and it only ever saves less.
 */
function projectMayNarrow(key, value) {
  return key !== "capture" || value === "off";
}

const VALID = {
  endpoint: (value) => typeof value === "string" && /^https?:\/\//.test(value),
  workspace: (value) => value === null || (typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)),
  personal: (value) => value === null || (typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)),
  capture: (value) => value === "on" || value === "off",
  captureExclude: (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string"),
  captureTo: (value) => value === "personal" || value === "workspace",
  orient: (value) => value === "instruction" || value === "live",
};

/** A workspace name as a person types it: `@slug` or `slug`, stored without the `@`. */
export function normalizeWorkspace(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim().replace(/^@/, "").toLowerCase();
}

export function settingsPath() {
  return process.env.CONTEXT_CONFIG || join(homedir(), ".context", "config.json");
}

async function readJson(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON`);
    throw error;
  }
}

export async function readSettings(path = settingsPath()) {
  return (await readJson(path)) || {};
}

/** Set one key after validating it. `null` removes it, falling back to the default. */
export async function writeSetting(key, value, path = settingsPath()) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting "${key}". Settings: ${Object.keys(DEFAULTS).join(", ")}`);
  const current = await readSettings(path);
  if (value === null) delete current[key];
  else {
    const normalized = key === "workspace" || key === "personal" ? normalizeWorkspace(value) : value;
    if (!VALID[key](normalized)) throw new Error(`invalid value for ${key}: ${JSON.stringify(value)}`);
    current[key] = normalized;
  }
  await writeConfig(current, path);
  return current;
}

/**
 * The nearest `.context.json` at or above `cwd`, and strictly below `home`.
 *
 * Stops below home rather than at the filesystem root: a file in a shared
 * parent directory, or in `/tmp`, is not this person's and must not decide
 * where their sessions go. A working directory outside home finds nothing.
 */
export async function findProjectFile(cwd, home = homedir()) {
  const top = resolve(home);
  let directory = resolve(cwd);
  if (!(directory + sep).startsWith(top + sep) || directory === top) return null;
  while (directory !== top) {
    const path = join(directory, PROJECT_FILE);
    const content = await readJson(path).catch(() => null);
    if (content) return { path, directory, content };
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

/**
 * Every setting with the layer it came from.
 *
 * An invalid value in any layer is skipped rather than fatal, so a typo in a
 * committed project file degrades to the next layer instead of breaking every
 * session in that repository. `sources` says where each value came from, which
 * is what `status` prints.
 */
export async function resolveSettings({
  flags = {},
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
  path = settingsPath(),
} = {}) {
  const project = await findProjectFile(cwd, home);
  const user = await readSettings(path);
  const fromEnv = {
    endpoint: env.CONTEXT_ENDPOINT,
    workspace: env.CONTEXT_WORKSPACE,
    capture: env.CONTEXT_CAPTURE,
  };
  const projectLayer = Object.fromEntries(
    PROJECT_KEYS.filter(
      (key) =>
        project?.content && key in project.content && projectMayNarrow(key, project.content[key])
    ).map((key) => [key, project.content[key]])
  );
  const layers = [
    ["flag", flags],
    ["env", fromEnv],
    ["project", projectLayer],
    ["user", user],
  ];
  const settings = {};
  const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    settings[key] = DEFAULTS[key];
    sources[key] = "default";
    for (const [source, layer] of layers) {
      let value = layer?.[key];
      if (value === undefined || value === null || value === "") continue;
      if (key === "workspace" || key === "personal") value = normalizeWorkspace(value);
      if (!VALID[key](value)) continue;
      settings[key] = value;
      sources[key] = source;
      break;
    }
  }
  return { settings, sources, projectFile: project?.path || null };
}

/**
 * The gateway URL for one workspace: `https://host/@slug/mcp`, or the plain
 * endpoint when no workspace is named. `path` swaps the final `/mcp` for another
 * route on the same workspace, such as `/inbox`.
 */
export function workspaceUrl(endpoint, workspace, path = "/mcp") {
  const url = new URL(baseEndpoint(endpoint));
  const prefix = url.pathname.replace(/\/mcp\/?$/, "");
  url.pathname = `${prefix}${workspace ? `/@${normalizeWorkspace(workspace)}` : ""}${path}`;
  return url.href;
}

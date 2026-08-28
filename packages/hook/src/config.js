/**
 * Where the hook's credential lives, and how carefully.
 *
 * One file, `~/.context/hook.json`, keyed by endpoint so a person with a work
 * context and a personal one has two entries rather than two installs fighting
 * over one slot.
 *
 * Three properties, none of them decorative:
 *
 * **The file is `0600` and its directory `0700`, set at create time.** Not
 * chmod'ed afterwards: a `writeFile` then `chmod` leaves a window in which a
 * refresh token is world-readable, and on a shared machine that window is the
 * whole attack. `mode` on the open is the fix, and `fs.open` with `wx` is what
 * makes it apply — `mode` is ignored for a file that already exists, so an
 * existing file is truncated through a handle we already know is ours.
 *
 * **Writes are atomic.** Temp file in the same directory, then `rename`. A hook
 * runs when a session ends, which is also when a laptop lid closes; a half
 * written credential file would mean the next session cannot authenticate and
 * cannot tell you why.
 *
 * **Nothing here is ever logged.** The CLI prints paths and scopes. It does not
 * print the file's contents, and there is a test asserting no command's output
 * contains a token.
 */

import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function defaultConfigPath() {
  return process.env.CONTEXT_HOOK_CONFIG || join(homedir(), ".context", "hook.json");
}

export async function readConfig(path = defaultConfigPath()) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { endpoints: {} };
    return { endpoints: parsed.endpoints && typeof parsed.endpoints === "object" ? parsed.endpoints : {} };
  } catch (error) {
    // A missing file is the ordinary first run. A corrupt one is not silently
    // replaced: overwriting it would destroy the refresh token that is probably
    // still in there, and "log in again" is a worse answer than "this file is
    // damaged, here is where it is".
    if (error.code === "ENOENT") return { endpoints: {} };
    if (error instanceof SyntaxError) {
      throw new Error(`${path} is not valid JSON; move it aside and run install again`);
    }
    throw error;
  }
}

export async function writeConfig(config, path = defaultConfigPath()) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  const temporary = join(directory, `.hook.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  // The rename preserves the temp file's own 0600, so this only matters when a
  // previous install left a laxer file behind. Cheap, and it closes that case.
  await chmod(path, FILE_MODE).catch(() => {});
  return path;
}

/** Endpoints are compared canonically, so a trailing slash is not a second account. */
export function endpointKey(endpoint) {
  const url = new URL(endpoint);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

export async function saveEndpoint(endpoint, record, path = defaultConfigPath()) {
  const config = await readConfig(path);
  config.endpoints[endpointKey(endpoint)] = { ...config.endpoints[endpointKey(endpoint)], ...record };
  await writeConfig(config, path);
  return config.endpoints[endpointKey(endpoint)];
}

export async function loadEndpoint(endpoint, path = defaultConfigPath()) {
  const config = await readConfig(path);
  return config.endpoints[endpointKey(endpoint)] || null;
}

export async function forgetEndpoint(endpoint, path = defaultConfigPath()) {
  const config = await readConfig(path);
  const existed = endpointKey(endpoint) in config.endpoints;
  delete config.endpoints[endpointKey(endpoint)];
  await writeConfig(config, path);
  return existed;
}

export { FILE_MODE, DIR_MODE };

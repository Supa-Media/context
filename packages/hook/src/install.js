/**
 * Writing the hook into the client's own settings, without breaking them.
 *
 * ## Claude Code is the one client supported, on purpose
 *
 * It has a documented `SessionEnd` hook that runs a command and hands it JSON
 * on stdin including the path to the session transcript. That is exactly the
 * shape this needs, and it is a shape I can point at in that client's own
 * documentation. The other clients on the connect screen either have no
 * end-of-session hook or have one whose contract I would be guessing at, and a
 * guessed integration that silently never fires is worse than an honest "not
 * yet" — the person believes their sessions are being saved and finds out
 * months later that none of them were.
 *
 * `CLIENTS` is the seam. Adding one is a config path, a merge, and a test.
 *
 * ## The merge is the risky part, not the flow
 *
 * `~/.claude/settings.json` is a file the person owns and may have spent real
 * effort on. So: read it, add exactly one entry, write it back atomically, and
 * never touch a key we did not put there. Installing twice replaces our entry
 * rather than stacking a second one — a hook that fires twice posts the same
 * session twice, and the second copy is indistinguishable from a real one.
 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Marks the entry as ours, so re-installing replaces it and uninstall finds it. */
export const HOOK_MARKER = "context-hook";

export const CLIENTS = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    settingsPath: () => process.env.CONTEXT_HOOK_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json"),
    /**
     * `SessionStart` fires on startup, resume and clear, and its output is
     * injected into the session before the first turn. `SessionEnd` hands over
     * the transcript path. Between them they bracket the session without the
     * agent having to remember anything.
     */
    events: { SessionStart: "session-start", SessionEnd: "capture" },
    merge: mergeClaudeCodeHook,
    remove: removeClaudeCodeHook,
  },
};

export function clientById(id) {
  const client = CLIENTS[id];
  if (!client) {
    throw new Error(
      `no hook is available for "${id}". Supported: ${Object.keys(CLIENTS).join(", ")}`
    );
  }
  return client;
}

/**
 * The command the client will run when a session ends.
 *
 * `npx` rather than a path into `node_modules`: the person installed this with
 * `npx` and their `PATH` at hook time is not their shell's. The endpoint is
 * passed on the command line and the credential is not — it is read from the
 * config file, so a settings file somebody pastes into an issue carries no
 * secret.
 */
export function hookCommand({ endpoint, client, command = "capture" }) {
  return `npx -y @context-lc/hook ${command} --client ${shellArg(client)} --endpoint ${shellArg(endpoint)}`;
}

function shellArg(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function mergeClaudeCodeHook(settings, commands) {
  const next = { ...settings };
  const hooks = { ...(next.hooks && typeof next.hooks === "object" ? next.hooks : {}) };
  for (const [event, command] of Object.entries(commands)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Drop any previous entry of ours before adding this one. Matching on the
    // marker rather than on the exact command, so an install that changes the
    // endpoint or the scope replaces rather than duplicates.
    const kept = existing.filter((matcher) => !isOurs(matcher));
    hooks[event] = [...kept, { hooks: [{ type: "command", command, [HOOK_MARKER]: true }] }];
  }
  next.hooks = hooks;
  return next;
}

function removeClaudeCodeHook(settings) {
  const next = { ...settings };
  if (!next.hooks || typeof next.hooks !== "object") return { settings: next, removed: 0 };
  const hooks = { ...next.hooks };
  let removed = 0;
  // Every event, not just the ones we would install today: somebody upgrading
  // from a version that installed a different set must not be left with an
  // orphan entry that no uninstall will ever find again.
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    const kept = matchers.filter((matcher) => !isOurs(matcher));
    removed += matchers.length - kept.length;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  // Leave no empty `hooks: {}` behind if we were the only thing in it.
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { settings: next, removed };
}

function isOurs(matcher) {
  if (!matcher || typeof matcher !== "object") return false;
  const entries = Array.isArray(matcher.hooks) ? matcher.hooks : [];
  return entries.some(
    (entry) =>
      entry?.[HOOK_MARKER] === true ||
      (typeof entry?.command === "string" && entry.command.includes("@context-lc/hook"))
  );
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      // Never rewrite a file we could not parse. It is the person's own
      // configuration and replacing it with `{}` plus our hook would delete
      // everything they had.
      throw new Error(`${path} is not valid JSON; fix it and run install again`);
    }
    throw error;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.settings.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function installHook({ clientId, endpoint }) {
  const client = clientById(clientId);
  const path = client.settingsPath();
  const settings = await readJsonFile(path);
  const commands = Object.fromEntries(
    Object.entries(client.events).map(([event, command]) => [
      event,
      hookCommand({ endpoint, client: clientId, command }),
    ])
  );
  await writeJsonFile(path, client.merge(settings, commands));
  return { path, commands };
}

export async function uninstallHook({ clientId }) {
  const client = clientById(clientId);
  const path = client.settingsPath();
  const settings = await readJsonFile(path);
  const { settings: next, removed } = client.remove(settings);
  if (removed) await writeJsonFile(path, next);
  return { path, removed };
}

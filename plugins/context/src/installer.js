/**
 * Installing Context into coding agents, and removing it again.
 *
 * Three kinds of install, chosen per agent by what that agent can do:
 *
 *  - **A plugin** where the agent has a plugin system this CLI can drive:
 *    Claude Code (`claude plugin install`), Gemini CLI (`gemini extensions
 *    install`), and Codex where its `plugin` command exists. The plugin brings
 *    the MCP entry, the skills and the session hooks together.
 *  - **An MCP entry plus the skills** everywhere else (Cursor, OpenCode, VS
 *    Code, Windsurf, Copilot CLI, and Codex or Gemini without a usable CLI). The
 *    entry is written by `add-mcp`, the skills are copied into the shared
 *    `.agents/skills` folder most agents read. No hooks: those agents have no
 *    plugin runtime to run them from.
 *
 * **This is the only module that loads `add-mcp`**, and only through a dynamic
 * import on the install path. The hooks and the credential code never load it,
 * so the one third-party dependency never runs while a session's transcript
 * or a token is in hand. `check-gateway-imports.mjs` enforces the file.
 *
 * Everything an install did is recorded in `~/.context/installs.json`, and
 * `uninstall` reverses exactly that record and nothing else.
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfig } from "./config.js";
import { workspaceUrl } from "./settings.js";

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_SOURCE = "Supa-Media/context";
const PLUGIN_ID = "context@context";
const SKILLS = ["context", "context-save"];

/** Agents the MCP-entry path covers, as `add-mcp` names them. */
export const MCP_AGENTS = {
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
  vscode: "VS Code",
  windsurf: "Windsurf",
  "github-copilot-cli": "Copilot CLI",
};

export function installsPath(home = homedir()) {
  return join(home, ".context", "installs.json");
}

export async function readInstalls(path = installsPath()) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed?.installs) ? parsed.installs : [];
  } catch {
    return [];
  }
}

export function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  return { code: result.error ? 127 : result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

async function loadAddMcp() {
  return import("add-mcp");
}

/**
 * Which agents are on this machine, and how each can take Context.
 *
 * Detection is a guess (a leftover config folder looks like an installed app),
 * which is why the caller confirms the list with the person before acting.
 */
export async function detectAgents({ run = defaultRun, addMcp, cwd = process.cwd() } = {}) {
  const found = [];
  if (run("claude", ["plugin", "--help"]).code === 0) found.push({ id: "claude-code", name: "Claude Code", method: "claude-plugin" });
  if (run("gemini", ["extensions", "--help"]).code === 0) {
    found.push({ id: "gemini-cli", name: "Gemini CLI", method: "gemini-extension" });
  }
  const codexHelp = run("codex", ["plugin", "--help"]);
  if (codexHelp.code === 0 && /marketplace/i.test(codexHelp.stdout + codexHelp.stderr)) {
    found.push({ id: "codex", name: "Codex", method: "codex-plugin" });
  }
  const library = addMcp || (await loadAddMcp());
  const mcpDetected = new Set([...(await library.detectGlobalAgents()), ...library.detectProjectAgents(cwd)]);
  for (const [id, name] of Object.entries(MCP_AGENTS)) {
    if (found.some((agent) => agent.id === id)) continue;
    if (mcpDetected.has(id)) found.push({ id, name, method: "mcp" });
  }
  return found;
}

/**
 * Install into each chosen agent. Returns the records written.
 *
 * `scope` is `user`, `project` or `local`. For an MCP entry at project or local
 * scope the URL names the project's workspace (`/@slug/mcp`), since nothing
 * else in those agents can tell the server which workspace this folder uses.
 */
export async function installInto(
  agents,
  { scope = "user", endpoint, workspace = null, cwd = process.cwd(), home = homedir(), source = DEFAULT_SOURCE, run = defaultRun, addMcp, log = console.log }
) {
  const records = [];
  const project = scope !== "user";
  for (const agent of agents) {
    const record = { agent: agent.id, method: agent.method, scope, cwd: project ? cwd : null, at: new Date().toISOString() };
    try {
      if (agent.method === "claude-plugin") {
        const marketplace = run("claude", ["plugin", "marketplace", "add", source, "--scope", scope], { cwd });
        record.addedMarketplace = marketplace.code === 0;
        const installed = run("claude", ["plugin", "install", PLUGIN_ID, "--scope", scope], { cwd });
        if (installed.code !== 0) throw new Error(firstLine(installed) || "claude plugin install failed");
      } else if (agent.method === "gemini-extension") {
        const staged = await stageGeminiExtension();
        const installed = run("gemini", ["extensions", "install", staged, "--consent"], { cwd });
        if (installed.code !== 0) throw new Error(firstLine(installed) || "gemini extensions install failed");
      } else if (agent.method === "codex-plugin") {
        const marketplace = run("codex", ["plugin", "marketplace", "add", source], { cwd });
        if (marketplace.code !== 0) throw new Error(firstLine(marketplace) || "codex plugin marketplace add failed");
        record.finishInAgent = "In Codex, run /plugins and install context.";
      } else {
        const library = addMcp || (await loadAddMcp());
        const url = workspaceUrl(endpoint, project ? workspace : null);
        // What does not exist yet is what uninstall may remove again, once empty.
        const known = library.agents?.[agent.id];
        const expected = known ? (project ? join(cwd, known.localConfigPath) : known.configPath) : null;
        const createdConfig = expected ? missingPaths(expected) : [];
        const result = library.upsertServer(agent.id, "context", { type: "http", url }, { local: project, cwd });
        if (!result.success) throw new Error(result.error || `could not write ${agent.name}'s MCP config`);
        record.configPath = result.path;
        if (createdConfig[0] === result.path) record.createdConfig = createdConfig;
        const skillsTarget = project ? join(cwd, ".agents", "skills") : join(home, ".agents", "skills");
        record.createdSkills = missingPaths(skillsTarget);
        record.skillsPath = await copySkills(skillsTarget);
      }
      record.ok = true;
      log(`  ✓ ${agent.name}${record.finishInAgent ? ` (${record.finishInAgent})` : ""}`);
    } catch (error) {
      record.ok = false;
      record.error = error.message;
      log(`  ✗ ${agent.name}: ${error.message}`);
    }
    records.push(record);
  }
  return records;
}

/** Undo recorded installs. Returns the records that could not be undone. */
export async function uninstallRecords(records, { run = defaultRun, addMcp, log = console.log } = {}) {
  const remaining = [];
  for (const record of records) {
    const cwd = record.cwd || process.cwd();
    try {
      if (record.method === "claude-plugin") {
        run("claude", ["plugin", "uninstall", PLUGIN_ID, "--scope", record.scope], { cwd });
        if (record.addedMarketplace) run("claude", ["plugin", "marketplace", "remove", "context"], { cwd });
      } else if (record.method === "gemini-extension") {
        run("gemini", ["extensions", "uninstall", "context"], { cwd });
      } else if (record.method === "codex-plugin") {
        log("  Codex: run /plugins in Codex and uninstall context.");
      } else if (record.method === "mcp") {
        const library = addMcp || (await loadAddMcp());
        const local = record.scope !== "user";
        library.removeServer(record.agent, "context", { local, cwd });
        if (record.createdConfig?.length && library.listInstalledServers) {
          // The file install created goes only when it holds no server at all.
          const listed = await library.listInstalledServers({ agents: [record.agent], global: !local, cwd }).catch(() => null);
          const servers = listed?.find((entry) => entry.configPath === record.configPath)?.servers;
          if (Array.isArray(servers) && servers.length === 0) await removeCreated(record.createdConfig, true);
        }
        if (record.skillsPath) {
          for (const name of SKILLS) await rm(join(record.skillsPath, name), { recursive: true, force: true });
          await removeCreated(record.createdSkills || [], false);
        }
      }
      log(`  ✓ removed from ${record.agent}${record.scope !== "user" ? ` (${record.cwd})` : ""}`);
    } catch (error) {
      log(`  ✗ ${record.agent}: ${error.message}`);
      remaining.push(record);
    }
  }
  return remaining;
}

export async function saveInstalls(installs, path = installsPath()) {
  await writeConfig({ installs }, path);
}

/**
 * `path` and each missing parent above it, deepest first, stopping at the
 * first that exists: exactly what writing `path` will create.
 */
function missingPaths(path) {
  const missing = [];
  let current = path;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

/**
 * Remove what install created, deepest first. The first entry is a file when
 * `firstIsFile`; every folder goes only if empty, so anything added to it since
 * install stays.
 */
async function removeCreated(paths, firstIsFile) {
  for (const [index, path] of paths.entries()) {
    if (index === 0 && firstIsFile) await rm(path, { force: true });
    else if (!(await rmdir(path).then(() => true, () => false))) return;
  }
}

async function copySkills(target) {
  await mkdir(target, { recursive: true });
  for (const name of SKILLS) {
    await cp(join(PLUGIN_ROOT, "skills", name), join(target, name), { recursive: true, force: true });
  }
  return target;
}

/**
 * The Gemini extension, assembled in a temporary folder named `context`.
 *
 * Gemini installs from GitHub only with its manifest at the repository root, and
 * its `hooks/hooks.json` has a different shape from the one Claude Code and
 * Codex read from this same folder, so its copy is built here from `gemini/`.
 */
export async function stageGeminiExtension() {
  const target = join(await mkdtemp(join(tmpdir(), "context-gemini-")), "context");
  for (const entry of ["bin", "src", "skills", "hooks", "package.json", "LICENSE", "README.md"]) {
    const from = join(PLUGIN_ROOT, entry);
    if (existsSync(from)) await cp(from, join(target, entry), { recursive: true });
  }
  await cp(join(PLUGIN_ROOT, "gemini", "gemini-extension.json"), join(target, "gemini-extension.json"));
  await cp(join(PLUGIN_ROOT, "gemini", "hooks", "hooks.json"), join(target, "hooks", "hooks.json"));
  return target;
}

function firstLine(result) {
  return `${result.stderr}\n${result.stdout}`.trim().split("\n")[0];
}

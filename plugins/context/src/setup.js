/**
 * `install`, `uninstall`, and the gateway's tools as terminal commands: the
 * CLI's setup path, kept apart from the sign-in and hook commands in
 * commands.js (which re-exports these). Loads the installer, and with it
 * add-mcp and @clack/prompts, only through dynamic imports.
 */

import { homedir } from "node:os";
import { isAbsolute as isAbsolutePath, relative as relativePath, sep } from "node:path";
import { baseEndpoint, defaultConfigPath, loadEndpoint } from "./config.js";
import { uninstallHook } from "./install.js";
import { callTool, listTools, listWorkspaces } from "./mcp.js";
import { normalizeWorkspace, resolveSettings, workspaceUrl, writeSetting } from "./settings.js";
import { accessTokenFor, excludeFromGit, link, login } from "./commands.js";

/**
 * `install`: sign in, pick the agents, install the plugin (or an MCP entry and
 * the skills) into each, and record what was done.
 *
 * `scope` is `user` (every folder), `project` (this folder, `.context.json`
 * committed for the team) or `local` (this folder, kept out of git). The
 * installer module, and with it `add-mcp`, is loaded only here.
 */
export async function install({
  scope,
  agents: agentIds,
  yes = false,
  workspace,
  endpoint,
  source,
  configPath = defaultConfigPath(),
  cwd = process.cwd(),
  home = homedir(),
  run,
  addMcp,
  openBrowser,
  fetchImpl = fetch,
  prompts,
  log = console.log,
}) {
  if (scope !== undefined && !["user", "project", "local"].includes(scope)) {
    throw new Error(`scope must be user, project or local, not "${scope}"`);
  }
  const installer = await import("./installer.js");
  // The wizard asks only what no flag answered, and nothing at all with -y.
  const prompt = yes ? null : prompts || (await import("./prompt.js"));
  const { settings } = await resolveSettings({ flags: { endpoint }, cwd });
  const base = baseEndpoint(settings.endpoint);

  const signedIn = await loadEndpoint(base, configPath).catch(() => null);
  if (!String(signedIn?.scope || "").includes("context:write")) {
    await login({ endpoint: base, configPath, fetchImpl, openBrowser, log });
  }

  scope = scope ?? (prompt ? await prompt.chooseScope() : "user");
  let chosen = normalizeWorkspace(workspace);
  let workspacesUnavailable = false;
  if (scope !== "user" && !chosen) {
    const token = await accessTokenFor({ endpoint: base, configPath, fetchImpl });
    const listed = await listWorkspaces({ url: base, token, fetchImpl });
    // An older server cannot list them: the project is left unbound and uses
    // the sign-in's default, and the summary says so.
    workspacesUnavailable = listed === null;
    const list = listed || [];
    const fallback = settings.workspace || list.find((entry) => entry.kind === "personal")?.slug || list[0]?.slug || null;
    chosen =
      prompt && list.length > 1
        ? await prompt.chooseWorkspace([...list].sort((a, b) => (a.slug === fallback ? -1 : b.slug === fallback ? 1 : 0)))
        : fallback;
  }

  const detected = await installer.detectAgents({ run, addMcp, cwd });
  let selected = detected;
  if (agentIds?.length) {
    selected = agentIds.map(
      (id) =>
        detected.find((agent) => agent.id === id) ||
        (installer.MCP_AGENTS[id] ? { id, name: installer.MCP_AGENTS[id], method: "mcp" } : null)
    );
    const unknown = agentIds.filter((_, index) => !selected[index]);
    if (unknown.length) throw new Error(`unknown agent: ${unknown.join(", ")}`);
  } else if (prompt) {
    selected = await prompt.chooseAgents(detected);
  }
  if (!selected.length) {
    log("No coding agents found. Name one with --agent, for example --agent cursor.");
    return { records: [] };
  }

  const capture = prompt ? await prompt.chooseCapture(settings.capture) : settings.capture;
  if (prompt && !(await prompt.confirmPlan({ scope, workspace: chosen, workspacesUnavailable, agents: selected.map((agent) => agent.name), capture }))) {
    log("Nothing was changed.");
    return { records: [], cancelled: true };
  }

  // Up to here only the sign-in was stored (the workspace question needs it);
  // settings, the folder link and the installs happen only after confirmation.
  if (capture !== settings.capture) await writeSetting("capture", capture);
  if (scope !== "user" && chosen) {
    await link({ workspace: chosen, cwd, private: scope === "local", endpoint: base, configPath, fetchImpl, log });
  }

  // Hooks the old @supa-media/context-hook wrote into settings files would run
  // beside the plugin's own and save every session twice.
  for (const agent of selected) {
    if (!["claude-code", "codex", "gemini-cli"].includes(agent.id)) continue;
    const removed = await uninstallHook({ clientId: agent.id }).catch(() => ({ removed: 0 }));
    if (removed.removed) log(`  removed ${removed.removed} old context-hook entr${removed.removed === 1 ? "y" : "ies"} from ${agent.name}'s settings`);
  }

  log(`Installing Context (${scope} scope)${chosen ? ` for @${chosen}` : ""}:`);
  const records = await installer.installInto(selected, { scope, endpoint: base, workspace: chosen, cwd, home, source, run, addMcp, log });
  const path = installer.installsPath(home);
  const kept = (await installer.readInstalls(path)).filter(
    (old) => !records.some((fresh) => fresh.ok && fresh.agent === old.agent && fresh.scope === old.scope && fresh.cwd === old.cwd)
  );
  await installer.saveInstalls([...kept, ...records.filter((record) => record.ok)], path);
  if (scope === "local") {
    // "Just for me": whatever this wrote inside the project stays out of git
    // too, not only .context.json.
    const inside = new Set();
    for (const record of records.filter((entry) => entry.ok)) {
      for (const written of [record.configPath, record.skillsPath]) {
        const relative = written ? relativePath(cwd, written) : "";
        if (relative && !relative.startsWith("..") && !isAbsolutePath(relative)) inside.add(`/${relative.split(sep)[0]}/`);
      }
    }
    for (const entry of inside) await excludeFromGit(cwd, entry);
  }

  log("");
  if (capture === "off") {
    log("Sessions are not saved. Turn that on with: npx @supa-media/context config set capture on");
  } else {
    log("When a session ends, its messages are saved to your Context inbox.");
    log("Turn that off with: npx @supa-media/context config set capture off");
  }
  if (scope !== "user" && selected.some((agent) => ["claude-code", "codex", "gemini-cli"].includes(agent.id))) {
    log("Claude Code, Codex and Gemini ignore a project's settings until you trust the folder: open it in each and accept.");
  }
  return { records };
}

/** `uninstall`: reverse what `install` recorded, for every agent or the named ones. */
export async function uninstall({ agents: agentIds, home = homedir(), run, addMcp, log = console.log }) {
  const installer = await import("./installer.js");
  const path = installer.installsPath(home);
  const installs = await installer.readInstalls(path);
  const target = agentIds?.length ? installs.filter((record) => agentIds.includes(record.agent)) : installs;
  if (!target.length) {
    log("Nothing installed by this CLI was found.");
    return { removed: 0 };
  }
  const remaining = await installer.uninstallRecords(target, { run, addMcp, log });
  await installer.saveInstalls([...installs.filter((record) => !target.includes(record)), ...remaining], path);
  log("Your sign-in is kept; remove it with: npx @supa-media/context logout");
  return { removed: target.length - remaining.length };
}


/**
 * Run one of the gateway's tools from the terminal: `context-lc search-notes
 * --query pricing`.
 *
 * The commands are the gateway's own tool list, read at run time, so a tool
 * added to the gateway is a command here with no release of this package, and
 * `--help` text is the tool's own description. Flags are typed from each
 * tool's input schema, so `--limit 5` arrives as a number. The workspace comes
 * from settings (the folder's `.context.json`, or the default), exactly as for
 * an agent.
 */
export async function runTool({ name, flags = {}, endpoint, configPath = defaultConfigPath(), cwd = process.cwd(), fetchImpl = fetch, log = console.log }) {
  const { settings } = await resolveSettings({ flags: { endpoint }, cwd });
  const url = workspaceUrl(settings.endpoint, settings.workspace);
  const token = await accessTokenFor({ endpoint: settings.endpoint, configPath, fetchImpl });
  const tools = await listTools({ url, token, fetchImpl });
  if (!tools) throw new Error("could not read the tool list from the server");
  const dashed = (tool) => tool.replace(/_/g, "-");

  if (name === "tools") {
    for (const tool of tools) log(`${dashed(tool.name).padEnd(24)} ${String(tool.description || "").split(/(?<=\.)\s/)[0]}`);
    return { ok: true };
  }
  const wanted = String(name).replace(/-/g, "_");
  const tool = tools.find((entry) => entry.name === wanted);
  if (!tool) throw new Error(`no tool "${wanted}". Tools: ${tools.map((entry) => entry.name).join(", ")}`);
  const properties = tool.inputSchema?.properties || {};

  if (flags.help) {
    log(tool.description || tool.name);
    for (const [key, schema] of Object.entries(properties)) {
      const required = (tool.inputSchema.required || []).includes(key) ? " (required)" : "";
      log(`  --${key.padEnd(20)} ${schema.type || "json"}${required}  ${schema.description || ""}`);
    }
    return { ok: true };
  }

  const args = {};
  for (const [key, raw] of Object.entries(flags)) {
    const schema = properties[key];
    if (!schema) throw new Error(`unknown flag --${key}. ${tool.name} takes: ${Object.keys(properties).map((p) => `--${p}`).join(", ")}`);
    args[key] = coerce(raw, schema, key);
  }
  for (const key of tool.inputSchema?.required || []) {
    if (!(key in args)) throw new Error(`--${key} is required for ${tool.name}`);
  }
  const answer = await callTool({ url, token, name: tool.name, args, fetchImpl });
  if (!answer) throw new Error(`${tool.name} returned no answer`);
  log(answer.text);
  return { ok: !answer.isError };
}

function coerce(raw, schema, key) {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "boolean") return raw === true || raw === "true";
  if (type === "number" || type === "integer") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
    return value;
  }
  if (type === "string") return String(raw);
  if (type === "array" && schema.items?.type === "string" && !String(raw).trim().startsWith("[")) {
    return String(raw).split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error(`--${key} must be JSON`);
  }
}

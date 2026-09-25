/**
 * The plugin as the agents load it: manifests, hook wiring, and the session-end
 * hook's timing.
 *
 * The timing check is the one that matters. Claude Code gives SessionEnd hooks
 * 1.5 seconds between them and a plugin cannot raise that, so `capture.mjs`
 * must return long before the save finishes, and the save must still happen.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hookClient } from "../src/hookClient.js";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const json = async (path) => JSON.parse(await readFile(join(ROOT, path), "utf8"));
const pkg = await json("package.json");

// -- manifests

const claude = await json(".claude-plugin/plugin.json");
const agentPlugins = await json("plugin.json");
const gemini = await json("gemini/gemini-extension.json");
const claudeMcp = await json(".mcp.json");
const agentMcp = await json("mcp.json");

check("every manifest names the plugin `context`", [claude, agentPlugins, gemini].every((m) => m.name === "context"));
check("every manifest carries the npm package's version", [claude, agentPlugins, gemini].every((m) => m.version === pkg.version));
const AP_KEYS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
check(
  "the Agent Plugins manifest uses only the keys its closed schema allows",
  Object.keys(agentPlugins).every((key) => AP_KEYS.includes(key)) &&
    agentPlugins.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" &&
    Object.keys(agentPlugins.author).every((key) => ["name", "email", "url"].includes(key))
);
const url = claudeMcp.mcpServers.context.url;
check("the MCP server is the hosted endpoint at its root, with no workspace in it", url === "https://mcp.context.lc/mcp");
check(
  "all three formats point at the same server, each in its own spelling",
  claudeMcp.mcpServers.context.type === "http" &&
    agentMcp.mcpServers.context.type === "streamable-http" &&
    agentMcp.mcpServers.context.url === url &&
    gemini.mcpServers.context.httpUrl === url
);
check(
  "the npm package ships everything the plugin loads",
  ["hooks", "skills", ".claude-plugin", "plugin.json", ".mcp.json", "mcp.json", "gemini"].every((entry) => pkg.files.includes(entry))
);

// -- hook wiring

const hookTargets = (config, root) =>
  Object.values(config.hooks)
    .flat()
    .flatMap((matcher) => matcher.hooks)
    .map((hook) => /"([^"]+)"/.exec(hook.command)?.[1]?.replace(root, ROOT.replace(/\/$/, "")));
const claudeHooks = await json("hooks/hooks.json");
const geminiHooks = await json("gemini/hooks/hooks.json");
check("Claude Code and Codex get SessionStart and SessionEnd", Boolean(claudeHooks.hooks.SessionStart && claudeHooks.hooks.SessionEnd));
check("every Claude/Codex hook points at a file the plugin ships", hookTargets(claudeHooks, "${CLAUDE_PLUGIN_ROOT}").every((path) => path && existsSync(path)));
check("every Gemini hook points at a file the plugin ships", hookTargets(geminiHooks, "${extensionPath}").every((path) => path && existsSync(path)));
check(
  "Gemini's timeouts are milliseconds, because that is its unit",
  Object.values(geminiHooks.hooks).flat().flatMap((m) => m.hooks).every((hook) => hook.timeout >= 1000)
);
check("no hook goes through npx, which cannot start inside the session-end budget", !JSON.stringify([claudeHooks, geminiHooks]).includes("npx"));

// -- marketplaces at the repository root

const claudeMarket = JSON.parse(await readFile(join(REPO, ".claude-plugin", "marketplace.json"), "utf8"));
const codexMarket = JSON.parse(await readFile(join(REPO, ".agents", "plugins", "marketplace.json"), "utf8"));
check("the Claude marketplace lists context from plugins/context", claudeMarket.plugins[0].name === "context" && claudeMarket.plugins[0].source === "./plugins/context");
check(
  "the Codex marketplace lists it too, with the fields Codex requires",
  codexMarket.plugins[0].source.path === "./plugins/context" &&
    codexMarket.plugins[0].policy?.installation &&
    codexMarket.plugins[0].policy?.authentication &&
    codexMarket.plugins[0].category
);

// -- which agent ran the hook

check("an explicit --client wins", hookClient(["node", "x", "--client", "gemini-cli"], {}) === "gemini-cli");
check("Codex is recognised by PLUGIN_ROOT, which Claude Code does not set", hookClient(["node", "x"], { PLUGIN_ROOT: "/p", CLAUDE_PLUGIN_ROOT: "/p" }) === "codex");
check("otherwise it is Claude Code", hookClient(["node", "x"], { CLAUDE_PLUGIN_ROOT: "/p" }) === "claude-code");

// -- the session-end hook returns at once, and the save still happens

const received = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  received.push({ path: request.url, body: Buffer.concat(chunks).toString("utf8") });
  // Slower than the whole session-end budget, as a real network can be: a hook
  // that waited for this answer would be cancelled before it came.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;

const home = await mkdtemp(join(tmpdir(), "context-plugin-"));
await mkdir(join(home, ".context"), { recursive: true });
await writeFile(
  join(home, ".context", "credentials.json"),
  JSON.stringify({ endpoints: { [endpoint]: { clientId: "c", accessToken: "cat_fake", expiresAt: Date.now() + 3_600_000 } } })
);
await writeFile(join(home, ".context", "config.json"), JSON.stringify({ endpoint, personal: "me" }));
const transcript = join(home, "session.jsonl");
await writeFile(
  transcript,
  [
    { type: "user", message: { role: "user", content: "Decide the plugin layout." } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "One folder for both." }] } },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")
);

const started = Date.now();
const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, "hooks", "capture.mjs")], {
    env: { ...process.env, HOME: home, CONTEXT_CONFIG: join(home, ".context", "config.json"), CONTEXT_HOOK_CONFIG: "" },
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.on("exit", resolve);
  child.stdin.end(JSON.stringify({ session_id: "plugin-1", transcript_path: transcript, cwd: home }));
});
const elapsed = Date.now() - started;
check(`the session-end hook exits 0 well inside the budget (${elapsed} ms)`, exitCode === 0 && elapsed < 1000);

const deadline = Date.now() + 10_000;
while (!received.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
check("...and the session still reaches the personal inbox afterwards", received[0]?.path === "/@me/inbox");
check("...with the conversation in it", (received[0]?.body || "").includes("Decide the plugin layout."));

let last = null;
while (!last && Date.now() < deadline) {
  last = await readFile(join(home, ".context", "last-capture.json"), "utf8").then(JSON.parse).catch(() => null);
  if (!last) await new Promise((resolve) => setTimeout(resolve, 50));
}
check("the worker records its outcome for status", last?.saved === true && last?.client === "claude-code");
check("...and that record holds no transcript", !JSON.stringify(last || {}).includes("Decide the plugin layout."));

server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

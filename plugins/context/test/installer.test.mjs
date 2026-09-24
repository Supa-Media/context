/**
 * `install` and `uninstall` against a fake machine.
 *
 * Every agent CLI call goes through an injected `run`, and `add-mcp` is replaced
 * by a recorder, so this checks the exact commands and config writes without
 * touching anybody's real agents. The gateway half (workspace list) is a small
 * local server.
 */

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

// -- a gateway that answers scope_info { workspaces: true }

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const workspaces = [
    { slug: "me", role: "owner", kind: "personal", current: true },
    { slug: "team", role: "editor", kind: "shared", current: false },
  ];
  const text = `## Workspaces\n\n\`\`\`json\n${JSON.stringify(workspaces)}\n\`\`\``;
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text }] } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;

// -- a machine of its own

const home = await mkdtemp(join(tmpdir(), "context-installer-"));
process.env.HOME = home;
process.env.CONTEXT_CONFIG = join(home, ".context", "config.json");
process.env.CONTEXT_HOOK_CONFIG = join(home, ".context", "credentials.json");
process.env.CONTEXT_HOOK_CLAUDE_SETTINGS = join(home, ".claude", "settings.json");
process.env.CONTEXT_HOOK_CODEX_SETTINGS = join(home, ".codex", "hooks.json");
process.env.CONTEXT_HOOK_GEMINI_SETTINGS = join(home, ".gemini", "settings.json");
await mkdir(join(home, ".context"), { recursive: true });
await mkdir(join(home, ".claude"), { recursive: true });
await writeFile(
  process.env.CONTEXT_HOOK_CONFIG,
  JSON.stringify({
    endpoints: {
      [endpoint]: { clientId: "c", accessToken: "cat_fake", expiresAt: Date.now() + 3_600_000, scope: "context:read context:write" },
    },
  })
);
// A hook the old package left behind, beside one of the person's own.
await writeFile(
  process.env.CONTEXT_HOOK_CLAUDE_SETTINGS,
  JSON.stringify({
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "npx -y @supa-media/context-hook capture --client claude-code" }] },
        { hooks: [{ type: "command", command: "echo mine" }] },
      ],
    },
  })
);

const { install, uninstall } = await import("../src/commands.js");

const calls = [];
const run = (command, args) => {
  calls.push([command, ...args].join(" "));
  if (command === "gemini") return { code: 127, stdout: "", stderr: "not found" };
  // An older Codex: it runs, but has no `plugin` command.
  if (command === "codex") return { code: 0, stdout: "Usage: codex [OPTIONS]\nCommands:\n  exec\n  mcp", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};
const upserts = [];
const removals = [];
const addMcp = {
  detectGlobalAgents: async () => ["codex", "cursor"],
  detectProjectAgents: () => [],
  upsertServer: (agent, name, config, options) => {
    upserts.push({ agent, name, config, options });
    return { success: true, path: `/fake/${agent}` };
  },
  removeServer: (agent, name, options) => {
    removals.push({ agent, name, options });
    return { success: true, removed: true };
  },
};
const said = [];
const log = (line = "") => said.push(String(line));

// -- user scope, every detected agent

await install({ scope: "user", yes: true, endpoint, home, cwd: home, run, addMcp, log });
check(
  "Claude Code gets the plugin from the marketplace, at user scope",
  calls.includes("claude plugin marketplace add Supa-Media/context --scope user") &&
    calls.includes("claude plugin install context@context --scope user")
);
check("an older Codex with no plugin command is not asked to install a plugin", !calls.some((call) => call.startsWith("codex plugin marketplace")));
const codexEntry = upserts.find((entry) => entry.agent === "codex");
check(
  "...it gets an MCP entry at the root URL instead, globally",
  codexEntry?.name === "context" && codexEntry.config.url === endpoint && codexEntry.config.type === "http" && codexEntry.options.local === false
);
check("Cursor gets an MCP entry too", upserts.some((entry) => entry.agent === "cursor"));
check("the skills are copied where those agents read them", existsSync(join(home, ".agents", "skills", "context", "SKILL.md")));
const claudeSettings = JSON.parse(await readFile(process.env.CONTEXT_HOOK_CLAUDE_SETTINGS, "utf8"));
check(
  "the old package's hook is removed, so sessions are not saved twice",
  !JSON.stringify(claudeSettings).includes("context-hook") && JSON.stringify(claudeSettings).includes("echo mine")
);
let installs = JSON.parse(await readFile(join(home, ".context", "installs.json"), "utf8")).installs;
check("every install is recorded", installs.map((entry) => entry.agent).sort().join(",") === "claude-code,codex,cursor");
check("install says sessions are captured, and how to stop it", said.join("\n").includes("config set capture off"));

// -- project scope names the workspace

const repo = join(home, "work", "repo");
await mkdir(repo, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: repo });
calls.length = 0;
upserts.length = 0;
await install({ scope: "project", yes: true, workspace: "@team", agents: ["claude-code", "cursor"], endpoint, home, cwd: repo, run, addMcp, log });
check("a project install writes the workspace to .context.json", JSON.parse(await readFile(join(repo, ".context.json"), "utf8")).workspace === "team");
check("...and installs the Claude plugin at project scope", calls.includes("claude plugin install context@context --scope project"));
const cursorEntry = upserts.find((entry) => entry.agent === "cursor");
check(
  "...and gives an MCP-only agent the workspace's own URL, in the project",
  cursorEntry?.config.url === endpoint.replace("/mcp", "/@team/mcp") && cursorEntry.options.local === true && cursorEntry.options.cwd === repo
);
check("...with the skills in the project", existsSync(join(repo, ".agents", "skills", "context-save", "SKILL.md")));
check("a project install is committed, so it is not added to git's exclude", !(await readFile(join(repo, ".git", "info", "exclude"), "utf8").catch(() => "")).includes(".context.json"));

// -- local scope keeps the binding out of git

const mine = join(home, "work", "private-repo");
await mkdir(mine, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: mine });
await install({ scope: "local", yes: true, workspace: "me", agents: ["cursor"], endpoint, home, cwd: mine, run, addMcp, log });
const excluded = (await readFile(join(mine, ".git", "info", "exclude"), "utf8")).split("\n");
check("a local install keeps .context.json out of git", excluded.includes(".context.json"));
check("...and the skills folder it wrote into the project, too", excluded.includes("/.agents/"));

// -- refusals

let refusal = null;
try {
  await install({ scope: "user", yes: true, agents: ["notepad"], endpoint, home, cwd: home, run, addMcp, log });
} catch (error) {
  refusal = error.message;
}
check("an unknown agent is refused by name", /unknown agent: notepad/.test(refusal || ""));
refusal = null;
try {
  await install({ scope: "everywhere", yes: true, endpoint, home, cwd: home, run, addMcp, log });
} catch (error) {
  refusal = error.message;
}
check("an unknown scope is refused", /scope must be user, project or local/.test(refusal || ""));

// -- uninstall reverses exactly the record

calls.length = 0;
const before = JSON.parse(await readFile(join(home, ".context", "installs.json"), "utf8")).installs.length;
await uninstall({ home, run, addMcp, log });
check(
  "uninstall removes the Claude plugin at each scope it was installed at",
  calls.includes("claude plugin uninstall context@context --scope user") && calls.includes("claude plugin uninstall context@context --scope project")
);
check("...and each MCP entry it wrote", removals.length === before - 2 && removals.every((entry) => entry.name === "context"));
check("...and the skills it copied", !existsSync(join(home, ".agents", "skills", "context")) && !existsSync(join(repo, ".agents", "skills", "context")));
installs = JSON.parse(await readFile(join(home, ".context", "installs.json"), "utf8")).installs;
check("...and the record is empty afterwards", installs.length === 0);
check("...and the sign-in is kept", (await readFile(process.env.CONTEXT_HOOK_CONFIG, "utf8")).includes("cat_fake"));

// -- the wizard: every question a flag does not answer, then a confirmation

/*
  A stand-in for src/prompt.js that answers from a script and records which
  questions were asked. The real module draws @clack/prompts menus, which need
  a terminal; what matters here is which questions install asks, in what
  order, and that nothing changes before the person confirms.
*/
function scripted(answers) {
  const asked = [];
  const answer = (name) => async (...args) => {
    asked.push(name);
    if (!(name in answers)) throw new Error(`unexpected question: ${name}`);
    const value = answers[name];
    return typeof value === "function" ? value(...args) : value;
  };
  return {
    asked,
    prompts: {
      chooseScope: answer("scope"),
      chooseWorkspace: answer("workspace"),
      chooseAgents: answer("agents"),
      chooseCapture: answer("capture"),
      confirmPlan: answer("confirm"),
    },
  };
}

const wizardRepo = join(home, "work", "wizard-repo");
await mkdir(wizardRepo, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: wizardRepo });
upserts.length = 0;
let plan = null;
let script = scripted({
  scope: "project",
  workspace: (list) => list.find((entry) => entry.slug === "team").slug,
  agents: (detected) => detected.filter((agent) => agent.id === "cursor"),
  capture: "off",
  confirm: (summary) => {
    plan = summary;
    return true;
  },
});
await install({ endpoint, home, cwd: wizardRepo, run, addMcp, log, prompts: script.prompts });
check(
  "with no flags, the wizard asks scope, workspace, agents and capture, then confirms",
  script.asked.join(",") === "scope,workspace,agents,capture,confirm"
);
check(
  "the confirmation shows what will happen before it happens",
  plan?.scope === "project" && plan?.workspace === "team" && plan?.agents.join(",") === "Cursor" && plan?.capture === "off"
);
check(
  "...and then it does exactly that",
  JSON.parse(await readFile(join(wizardRepo, ".context.json"), "utf8")).workspace === "team" &&
    upserts.some((entry) => entry.agent === "cursor" && entry.options.cwd === wizardRepo)
);
check("the capture answer is saved", JSON.parse(await readFile(process.env.CONTEXT_CONFIG, "utf8")).capture === "off");
check(
  "...and the closing message says capture is off and how to turn it on, not off",
  said.join("\n").includes("config set capture on") && !said.slice(-4).join("\n").includes("config set capture off")
);

const declinedRepo = join(home, "work", "declined-repo");
await mkdir(declinedRepo, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: declinedRepo });
upserts.length = 0;
const recordBefore = await readFile(join(home, ".context", "installs.json"), "utf8");
script = scripted({ scope: "local", workspace: "me", agents: (detected) => detected, capture: "on", confirm: false });
const declined = await install({ endpoint, home, cwd: declinedRepo, run, addMcp, log, prompts: script.prompts });
check(
  "answering no at the confirmation changes nothing",
  declined.records.length === 0 &&
    upserts.length === 0 &&
    !existsSync(join(declinedRepo, ".context.json")) &&
    (await readFile(join(home, ".context", "installs.json"), "utf8")) === recordBefore &&
    JSON.parse(await readFile(process.env.CONTEXT_CONFIG, "utf8")).capture === "off"
);

script = scripted({ capture: "on", confirm: true });
await install({ scope: "user", agents: ["cursor"], endpoint, home, cwd: home, run, addMcp, log, prompts: script.prompts });
check("a flag answers its question, so only the rest are asked", script.asked.join(",") === "capture,confirm");

// A server that cannot list workspaces: the project question is skipped, and
// the summary has to say which workspace that leaves rather than nothing.
const listless = createServer(async (request, response) => {
  for await (const _ of request);
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "unknown argument" }] } }));
});
await new Promise((resolve) => listless.listen(0, "127.0.0.1", resolve));
const listlessEndpoint = `http://127.0.0.1:${listless.address().port}/mcp`;
const credentialsNow = JSON.parse(await readFile(process.env.CONTEXT_HOOK_CONFIG, "utf8"));
credentialsNow.endpoints[listlessEndpoint] = credentialsNow.endpoints[endpoint];
await writeFile(process.env.CONTEXT_HOOK_CONFIG, JSON.stringify(credentialsNow));
const listlessRepo = join(home, "work", "listless-repo");
await mkdir(listlessRepo, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: listlessRepo });
let listlessPlan = null;
script = scripted({ scope: "local", agents: (detected) => detected.filter((agent) => agent.id === "cursor"), capture: "off", confirm: (summary) => ((listlessPlan = summary), false) });
await install({ endpoint: listlessEndpoint, home, cwd: listlessRepo, run, addMcp, log, prompts: script.prompts });
check(
  "when the server cannot list workspaces, the summary says the default is used",
  !script.asked.includes("workspace") && listlessPlan?.workspace === null && listlessPlan?.workspacesUnavailable === true
);
listless.close();

script = scripted({});
await install({ yes: true, agents: ["cursor"], endpoint, home, cwd: home, run, addMcp, log, prompts: script.prompts });
check("-y asks nothing at all, so scripts and CI need no terminal", script.asked.length === 0);

// -- the dependency stays on the install path

const src = new URL("../src/", import.meta.url);
const commandsText = await readFile(new URL("commands.js", src), "utf8");
const importers = [];
for (const file of await readdir(src)) {
  const text = await readFile(new URL(file, src), "utf8");
  if (/from\s+["']add-mcp["']|import\(\s*["']add-mcp["']\s*\)/.test(text)) importers.push(file);
}
check("installer.js is the only file that loads add-mcp", importers.join(",") === "installer.js");
const clackImporters = [];
for (const file of await readdir(src)) {
  const text = await readFile(new URL(file, src), "utf8");
  if (/["']@clack\/prompts["']/.test(text)) clackImporters.push(file);
}
check("prompt.js is the only file that loads @clack/prompts", clackImporters.join(",") === "prompt.js");
check(
  "commands.js reaches the wizard only through a dynamic import, so the hooks never load it",
  !/^import .*prompt\.js/m.test(commandsText) && commandsText.includes('await import("./prompt.js")')
);
check(
  "commands.js reaches the installer only through a dynamic import, so the hooks never load it",
  !/^import .*installer\.js/m.test(commandsText) && commandsText.includes('await import("./installer.js")')
);

server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

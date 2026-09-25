/**
 * The CLI proper: workspace-aware capture, login, link, use, config, the
 * refresh lock, tools from the terminal and the sign-in landing page. Split
 * from test.mjs.
 */


import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import * as commands from "../src/commands.js";
import { transcriptToMarkdown, messageFromEntry } from "../src/transcript.js";
import {
  createPkce,
  stateMatches,
  discover,
  registerClient,
  listenForCode,
  HOOK_SCOPE,
  ORIENT_SCOPE,
  LOGIN_SCOPE,
} from "../src/oauth.js";
import { endpointKey, credentialEndpointKey, saveEndpoint } from "../src/config.js";
import { clientById, installHook, uninstallHook, HOOK_MARKER } from "../src/install.js";
import { callTool, listWorkspaces } from "../src/mcp.js";
import { readSettings, writeSetting } from "../src/settings.js";
import { STUB_TOOLS, base64Url, startStubServer, SECRETS, TRANSCRIPT } from "./support.mjs";


let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

/* ---------------------------------- run ---------------------------------- */

const server = await startStubServer();
const home = await mkdtemp(join(tmpdir(), "context-hook-"));
// Settings are read from the home folder and a project file under it, so the
// suite gets a home of its own rather than the person's running it.
process.env.HOME = home;
process.env.CONTEXT_CONFIG = join(home, ".context", "config.json");
const configPath = join(home, "hook.json");
const settingsPath = join(home, "claude-settings.json");
process.env.CONTEXT_HOOK_CLAUDE_SETTINGS = settingsPath;

const said = [];
const log = (line = "") => said.push(String(line));


// Every section below assumes the capture-only sign-in test.mjs makes first.
await commands.installHooks({
  endpoint: server.endpoint,
  client: "claude-code",
  configPath,
  openBrowser: (href) => server.state.approve(href),
  log,
});

// Sections split from hooks.test.mjs, which they followed: a session log to
// capture, and a sink for what session start injects.
const transcriptPath = join(home, "session.jsonl");
await writeFile(transcriptPath, TRANSCRIPT);
let injected = "";
const emit = (text) => {
  injected = text;
};

// -- which workspace a capture lands in

/*
  Captures go to the person's own inbox unless they chose otherwise, even in a
  project bound to a shared workspace: a session transcript is theirs, and the
  gateway files a capture in whichever workspace the URL names. The slug has to
  survive into the URL, which `new URL("/inbox", endpoint)` used to throw away.
*/
const projectDir = join(home, "work", "shared-repo");
await mkdir(projectDir, { recursive: true });
await writeFile(join(projectDir, ".context.json"), JSON.stringify({ workspace: "@team" }));
await writeSetting("personal", "me");
const captureIn = async (cwd) => {
  const before = server.state.captures.length;
  const result = await commands.capture({
    endpoint: server.endpoint,
    client: "claude-code",
    configPath,
    stdin: [JSON.stringify({ session_id: `s-${cwd.length}-${Date.now()}`, transcript_path: transcriptPath, cwd })],
    log,
  });
  return { result, posted: server.state.captures.length - before, path: server.state.paths.at(-1) };
};
let landed = await captureIn(projectDir);
check("in a project bound to a shared workspace, a capture still goes to the personal inbox", landed.posted === 1 && landed.path === "/@me/inbox");
await writeFile(join(projectDir, ".context.json"), JSON.stringify({ workspace: "@team", captureTo: "workspace" }));
landed = await captureIn(projectDir);
check("...unless the project says captures go to its workspace", landed.posted === 1 && landed.path === "/@team/inbox");
await writeFile(join(projectDir, ".context.json"), JSON.stringify({ workspace: "@team", capture: "off" }));
landed = await captureIn(projectDir);
check("a project that turns capture off sends nothing", landed.posted === 0 && landed.result.reason === "off");
await writeFile(join(projectDir, ".context.json"), JSON.stringify({ workspace: "@team" }));
await writeSetting("captureExclude", [join(home, "work")]);
landed = await captureIn(projectDir);
check("a folder this person excluded sends nothing, subfolders included", landed.posted === 0 && landed.result.reason === "excluded");
await writeSetting("captureExclude", null);

// -- session start names the project's workspace

const inProject = await commands.sessionStart({
  endpoint: server.endpoint,
  configPath,
  stdin: [JSON.stringify({ session_id: "s2", source: "startup", cwd: projectDir })],
  emit,
});
check(
  "in a bound project, session start tells the agent which workspace to pass",
  inProject.injected.includes('context: "@team"')
);
const elsewhere = await commands.sessionStart({
  endpoint: server.endpoint,
  configPath,
  stdin: [JSON.stringify({ session_id: "s3", source: "startup", cwd: home })],
  emit,
});
check("...and outside one it names none", !elsewhere.injected.includes('context: "@'));

// -- the MCP helpers

const helperToken = await commands.accessTokenFor({ endpoint: server.endpoint, configPath });
const listedWorkspaces = await listWorkspaces({ url: server.endpoint, token: helperToken });
check("listWorkspaces reads the gateway's JSON block", listedWorkspaces?.map((entry) => entry.slug).join(",") === "me,team");
server.state.workspaces = null;
check("...and an older gateway that refuses the argument gives null", (await listWorkspaces({ url: server.endpoint, token: helperToken })) === null);
server.state.workspaces = [{ slug: "me", role: "owner", kind: "personal", current: true }];
const called = await callTool({ url: server.endpoint, token: helperToken, name: "orient" });
check("callTool returns the tool's text", called?.text.includes("12 notes visible") && called.isError === false);
server.state.orientFails = true;
check("...and null when nothing usable came back", (await callTool({ url: server.endpoint, token: helperToken, name: "orient" })) === null);
server.state.orientFails = false;

// -- login: read and write, never private, and the personal workspace recorded

server.state.workspaces = [
  { slug: "me", role: "owner", kind: "personal", current: true },
  { slug: "team", role: "editor", kind: "shared", current: false },
];
said.length = 0;
const loginRegistrations = server.state.registered.length;
await commands.login({
  endpoint: server.endpoint,
  configPath,
  openBrowser: (href) => server.state.approve(href),
  log,
});
const loginScope = server.state.lastAuthorize.searchParams.get("scope");
check(
  "login asks for read, write and the owner's private notes",
  loginScope === LOGIN_SCOPE && LOGIN_SCOPE === "context:read context:write context:private"
);
/*
  Asking is not getting. The approval screen still lets the person grant team
  only, and the gateway clamps private to owners; what the CLI stores is what
  was granted, never what it asked for.
*/
check("login registers a client that declares the scope it asks for", server.state.registered.length === loginRegistrations + 1 && server.state.registered.at(-1).scope === LOGIN_SCOPE);
check("login records which workspace is personal", (await readSettings()).personal === "me");
check(
  "login remembers the server it signed in to, so the hooks use it too",
  (await readSettings()).endpoint === server.endpoint
);
check("login lists the workspaces it reaches", said.join("\n").includes("@me") && said.join("\n").includes("@team"));
check("login prints no token", !said.join("\n").includes("access_") && !said.join("\n").includes("refresh_"));

server.state.workspaces = null;
said.length = 0;
await commands.login({ endpoint: server.endpoint, configPath, openBrowser: (href) => server.state.approve(href), log });
check("against an older gateway login still succeeds and says what it could not learn", /could not list your workspaces/i.test(said.join("\n")));
server.state.workspaces = [
  { slug: "me", role: "owner", kind: "personal", current: true },
  { slug: "team", role: "editor", kind: "shared", current: false },
];

// -- link and unlink

const linkDir = join(home, "work", "linked");
await mkdir(linkDir, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: linkDir });
await commands.link({ workspace: "@team", cwd: linkDir, endpoint: server.endpoint, configPath, log });
check("link writes the project file with the workspace", JSON.parse(await readFile(join(linkDir, ".context.json"), "utf8")).workspace === "team");
let linkRefusal = null;
try {
  await commands.link({ workspace: "@stranger", cwd: linkDir, endpoint: server.endpoint, configPath, log });
} catch (error) {
  linkRefusal = error.message;
}
check("link refuses a workspace this sign-in does not reach", /does not reach @stranger/.test(linkRefusal || ""));
await commands.link({ workspace: "team", cwd: linkDir, private: true, endpoint: server.endpoint, configPath, log });
check(
  "a private link keeps the file out of git through .git/info/exclude",
  (await readFile(join(linkDir, ".git", "info", "exclude"), "utf8")).split("\n").includes(".context.json")
);
/*
  A worktree (or a submodule) has a `.git` FILE pointing at its git directory,
  not a `.git` folder. Asking git where the exclude file is covers both; the
  first version looked for a folder, found none, skipped the exclude, and
  still said "kept out of git".
*/
const mainRepo = join(home, "work", "main-repo");
await mkdir(mainRepo, { recursive: true });
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
git(["init", "-q"], mainRepo);
git(["-c", "user.email=t@example.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], mainRepo);
const worktree = join(home, "work", "a-worktree");
git(["worktree", "add", "-q", worktree], mainRepo);
said.length = 0;
await commands.link({ workspace: "team", cwd: worktree, private: true, endpoint: server.endpoint, configPath, log });
const ignored = git(["check-ignore", "-q", ".context.json"], worktree).status === 0;
check("a private link inside a git worktree is really ignored by git", ignored);
const plainDir = join(home, "work", "not-a-repo");
await mkdir(plainDir, { recursive: true });
said.length = 0;
await commands.link({ workspace: "team", cwd: plainDir, private: true, endpoint: server.endpoint, configPath, log });
check("outside a git repository, a private link says it could not keep the file out of git", /not a git repository/i.test(said.join("\n")));

await commands.unlink({ cwd: linkDir, log });
check("unlink removes the binding", (await readFile(join(linkDir, ".context.json"), "utf8").catch(() => "{}")).includes("team") === false);

// -- use: this person's default workspace

said.length = 0;
await commands.use({ workspace: "@team", endpoint: server.endpoint, configPath, log });
check("use sets the default workspace", (await readSettings()).workspace === "team");
let useRefusal = null;
try {
  await commands.use({ workspace: "@stranger", endpoint: server.endpoint, configPath, log });
} catch (error) {
  useRefusal = error.message;
}
check("use refuses a workspace this sign-in does not reach", /does not reach @stranger/.test(useRefusal || "") && (await readSettings()).workspace === "team");
said.length = 0;
await commands.use({ endpoint: server.endpoint, configPath, log });
check("use with no name lists the workspaces and marks the default", said.some((line) => /@team.*default/.test(line)) && said.some((line) => line.includes("@me")));
await writeSetting("workspace", null);

// -- config

await commands.config({ action: "set", key: "capture", value: "off", log });
said.length = 0;
await commands.config({ action: "list", cwd: home, log });
check("config list shows each value and where it came from", said.some((line) => /capture\s+off\s+\(user\)/.test(line)));
let configRefusal = null;
try {
  await commands.config({ action: "set", key: "endpoint", value: "ftp://nope", log });
} catch (error) {
  configRefusal = error.message;
}
check("config refuses an invalid value", /invalid value for endpoint/.test(configRefusal || ""));
await commands.config({ action: "set", key: "capture", value: null, log });

// -- two hooks refreshing at once

/*
  Refresh tokens rotate, and the stub, like the gateway, refuses a spent one.
  Two session-end hooks for two sessions closing together both find the
  access token expired; without a lock the second spends the refresh token
  the first just rotated and the sign-in is lost.
*/
const agedAgain = JSON.parse(await readFile(configPath, "utf8"));
agedAgain.endpoints[`${server.origin}/mcp`].expiresAt = Date.now() - 1000;
await writeFile(configPath, JSON.stringify(agedAgain));
const parallel = await Promise.allSettled([
  commands.accessTokenFor({ endpoint: server.endpoint, configPath }),
  commands.accessTokenFor({ endpoint: server.endpoint, configPath }),
]);
check(
  "two parallel refreshes both succeed with one usable token",
  parallel.every((outcome) => outcome.status === "fulfilled") && parallel[0].value === parallel[1].value
);

// -- a read+write sign-in does not turn on live orientation by itself

/*
  login's grant can read, so the start hook COULD inject the orientation. It
  does only when the person chose it (orient: live): the default is the
  instruction to call orient, the same as before.
*/
const loginStart = await commands.sessionStart({
  endpoint: server.endpoint,
  configPath,
  stdin: [JSON.stringify({ session_id: "s4", source: "startup", cwd: home })],
  emit,
});
check("after login, session start still injects the instruction by default", loginStart.live === false);
await writeSetting("orient", "live");
const chosenLiveStart = await commands.sessionStart({
  endpoint: server.endpoint,
  configPath,
  stdin: [JSON.stringify({ session_id: "s5", source: "startup", cwd: home })],
  emit,
});
check("...and the live orientation once orient is set to live", chosenLiveStart.live === true);
await writeSetting("orient", null);

// -- tools from the terminal, built from the gateway's own list

said.length = 0;
const ran = await commands.runTool({
  name: "search-notes",
  flags: { query: "pricing", limit: "5", exact: true },
  endpoint: server.endpoint,
  configPath,
  cwd: home,
  log,
});
const sent = server.state.mcpCalls.at(-1).params;
check("a tool runs by its name, with dashes accepted for underscores", ran.ok === true && sent.name === "search_notes");
check("flags are typed from the tool's schema", sent.arguments.query === "pricing" && sent.arguments.limit === 5 && sent.arguments.exact === true);
check("the tool's answer is printed", said.join("\n").includes('searched {"query":"pricing","limit":5,"exact":true}'));
let toolRefusal = null;
try {
  await commands.runTool({ name: "search_notes", flags: { query: "x", colour: "blue" }, endpoint: server.endpoint, configPath, cwd: home, log });
} catch (error) {
  toolRefusal = error.message;
}
check("a flag the tool does not take is refused, naming the ones it does", /unknown flag --colour.*--query/.test(toolRefusal || ""));
toolRefusal = null;
try {
  await commands.runTool({ name: "search_notes", flags: {}, endpoint: server.endpoint, configPath, cwd: home, log });
} catch (error) {
  toolRefusal = error.message;
}
check("a missing required flag is refused", /--query is required/.test(toolRefusal || ""));
toolRefusal = null;
try {
  await commands.runTool({ name: "delete_everything", flags: {}, endpoint: server.endpoint, configPath, cwd: home, log });
} catch (error) {
  toolRefusal = error.message;
}
check("an unknown tool is refused with the list of real ones", /no tool "delete_everything".*search_notes/.test(toolRefusal || ""));
said.length = 0;
await commands.runTool({ name: "tools", flags: {}, endpoint: server.endpoint, configPath, cwd: home, log });
check("`tools` lists what this sign-in can run", said.join("\n").includes("search-notes"));

// -- logout

said.length = 0;
await commands.logout({ endpoint: server.endpoint, configPath, log });
check("logout forgets the stored sign-in", (await readFile(configPath, "utf8")).includes("refresh_") === false);

// -- the page the browser lands on after approving

/*
  The CLI serves the OAuth callback on a loopback port, so that page cannot use
  the app's components. When the server names the app, the page sends the
  browser on to the app's own /connect/cli screen instead, carrying only the
  outcome: the code stays on the loopback URL, and the redirect leaves no
  referrer behind.
*/
const landing = async (options, query) => {
  const listener = await listenForCode(options);
  const response = await fetch(`${listener.redirectUri}?${query}`, { redirect: "manual" });
  await listener.waitForCode().catch(() => {});
  listener.close();
  return { status: response.status, location: response.headers.get("location"), referrer: response.headers.get("referrer-policy"), body: await response.text() };
};
let page = await landing({}, "code=c1&state=s1");
check("with no app named, the callback page says the sign-in worked", page.status === 200 && /signed in to Context/i.test(page.body));
check("...and no longer talks about a hook", !/hook/i.test(page.body));
page = await landing({ appOrigin: "https://app.example.test" }, "code=c1&state=s1");
check(
  "with the app named, the browser is sent to the app's connected page",
  page.status === 302 && page.location === "https://app.example.test/connect/cli?result=connected"
);
check("...carrying the outcome and never the code", !page.location.includes("c1") && page.referrer === "no-referrer");
page = await landing({ appOrigin: "https://app.example.test" }, "error=access_denied&state=s1");
check("a refusal is sent to the same page, as refused", page.location === "https://app.example.test/connect/cli?result=refused");

server.state.appOrigin = "https://app.example.test/";
check("discovery reads the app's origin from the metadata", (await discover(server.endpoint)).appOrigin === "https://app.example.test");
server.state.appOrigin = "http://app.example.test";
check("...and ignores one that is not https", (await discover(server.endpoint)).appOrigin === null);
server.state.appOrigin = null;
check("...and a server that names none gives none", (await discover(server.endpoint)).appOrigin === null);


server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

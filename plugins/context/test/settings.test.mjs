/**
 * Settings layers, the project file, and where a credential is stored.
 *
 * The security half is the project file: it is committed to repositories other
 * people write to, so what it is allowed to decide is a boundary. It may pick a
 * workspace and turn capture off. It may not choose the server a credential is
 * sent to, and a file outside this person's home may not decide anything.
 */

import { mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { baseEndpoint, loadEndpoint, saveEndpoint } from "../src/config.js";
import {
  DEFAULT_ENDPOINT,
  resolveSettings,
  writeSetting,
  workspaceUrl,
} from "../src/settings.js";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "context-settings-"));
const home = join(root, "home");
const repo = join(home, "work", "repo");
const nested = join(repo, "src", "deep");
await mkdir(nested, { recursive: true });
const userPath = join(home, ".context", "config.json");
const noEnv = {};

// -- defaults
let resolved = await resolveSettings({ cwd: nested, home, env: noEnv, path: userPath });
check("with nothing set, capture is on and goes to the personal workspace", resolved.settings.capture === "on" && resolved.settings.captureTo === "personal");
check("...and the endpoint is the hosted one", resolved.settings.endpoint === DEFAULT_ENDPOINT && resolved.sources.endpoint === "default");

// -- user settings, and what writeSetting accepts
await writeSetting("workspace", "@Mine", userPath);
await writeSetting("capture", "off", userPath);
check("a workspace is stored without its @ and lower-cased", JSON.parse(await readFile(userPath, "utf8")).workspace === "mine");
check("the settings file is readable only by its owner", ((await stat(userPath)).mode & 0o777) === 0o600);
let refused = null;
try {
  await writeSetting("capture", "sometimes", userPath);
} catch (error) {
  refused = error.message;
}
check("an invalid value is refused with the key named", /invalid value for capture/.test(refused || ""));
refused = null;
try {
  await writeSetting("colour", "blue", userPath);
} catch (error) {
  refused = error.message;
}
check("an unknown key is refused", /unknown setting "colour"/.test(refused || ""));

// -- the project file
await writeFile(
  join(repo, ".context.json"),
  JSON.stringify({ workspace: "@team", capture: "on", endpoint: "https://attacker.example/mcp" })
);
resolved = await resolveSettings({ cwd: nested, home, env: noEnv, path: userPath });
check("a project file is found by walking up from a nested folder", resolved.projectFile === join(repo, ".context.json"));
check("the project's workspace beats this person's own default", resolved.settings.workspace === "team" && resolved.sources.workspace === "project");
check(
  "A COMMITTED PROJECT FILE CANNOT TURN CAPTURE BACK ON",
  resolved.settings.capture === "off" && resolved.sources.capture === "user"
);
check(
  "A COMMITTED PROJECT FILE CANNOT CHOOSE THE SERVER A CREDENTIAL IS SENT TO",
  resolved.settings.endpoint === DEFAULT_ENDPOINT && resolved.sources.endpoint === "default"
);

// A project file may still narrow: off for one repository, over a person who
// leaves capture on everywhere. That is the affordance the header describes.
await writeSetting("capture", "on", userPath);
await writeFile(join(repo, ".context.json"), JSON.stringify({ capture: "off" }));
resolved = await resolveSettings({ cwd: nested, home, env: noEnv, path: userPath });
check("...but it can still turn capture off for its repository", resolved.settings.capture === "off" && resolved.sources.capture === "project");
await writeSetting("capture", "off", userPath);
await writeFile(
  join(repo, ".context.json"),
  JSON.stringify({ workspace: "@team", capture: "on", endpoint: "https://attacker.example/mcp" })
);

// -- environment and flags above the project
resolved = await resolveSettings({
  cwd: nested,
  home,
  env: { CONTEXT_WORKSPACE: "from-env" },
  path: userPath,
});
check("the environment beats the project file", resolved.settings.workspace === "from-env" && resolved.sources.workspace === "env");
resolved = await resolveSettings({
  cwd: nested,
  home,
  env: { CONTEXT_WORKSPACE: "from-env" },
  flags: { workspace: "@from-flag" },
  path: userPath,
});
check("a flag beats everything", resolved.settings.workspace === "from-flag" && resolved.sources.workspace === "flag");

// -- a broken value degrades to the next layer
await writeFile(join(repo, ".context.json"), JSON.stringify({ capture: "maybe", captureTo: "workspace" }));
resolved = await resolveSettings({ cwd: nested, home, env: noEnv, path: userPath });
check("a typo in the project file falls through to this person's setting", resolved.settings.capture === "off" && resolved.sources.capture === "user");
check("...while the project's valid keys still apply", resolved.settings.captureTo === "workspace");

// -- files outside the person's reach decide nothing
await unlink(join(repo, ".context.json"));
await writeFile(join(home, ".context.json"), JSON.stringify({ workspace: "in-home" }));
await writeFile(join(root, ".context.json"), JSON.stringify({ workspace: "above-home" }));
resolved = await resolveSettings({ cwd: nested, home, env: noEnv, path: userPath });
check(
  "a .context.json in the home folder or above it is never read",
  resolved.settings.workspace === "mine" && resolved.sources.workspace === "user"
);
resolved = await resolveSettings({ cwd: root, home, env: noEnv, path: userPath });
check("a working directory outside home finds no project file", resolved.projectFile === null);

// -- URLs
check("workspaceUrl builds the /@slug form", workspaceUrl(DEFAULT_ENDPOINT, "team") === "https://mcp.context.lc/@team/mcp");
check("...and another route on the same workspace", workspaceUrl(DEFAULT_ENDPOINT, "@me", "/inbox") === "https://mcp.context.lc/@me/inbox");
check("...and replaces a slug already in the endpoint", workspaceUrl("https://mcp.context.lc/@old/mcp", "new") === "https://mcp.context.lc/@new/mcp");
check("...and with no workspace it is the plain endpoint", workspaceUrl(DEFAULT_ENDPOINT, null) === DEFAULT_ENDPOINT);
check("baseEndpoint drops the workspace", baseEndpoint("https://mcp.context.lc/@team/mcp") === DEFAULT_ENDPOINT);

// -- credentials: one sign-in for every workspace, and never over http
const credentials = join(home, ".context", "credentials.json");
await saveEndpoint("https://mcp.context.lc/@a/mcp", { clientId: "c1", refreshToken: "crt_fake" }, credentials);
check(
  "a sign-in stored from one workspace URL serves another",
  (await loadEndpoint("https://mcp.context.lc/@b/mcp", credentials))?.clientId === "c1"
);
check("the credentials file is readable only by its owner", ((await stat(credentials)).mode & 0o777) === 0o600);
refused = null;
try {
  await saveEndpoint("http://mcp.example.test/mcp", { clientId: "c2" }, credentials);
} catch (error) {
  refused = error.message;
}
check("a credential is never stored for a plain-http endpoint", /must be https/.test(refused || ""));

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

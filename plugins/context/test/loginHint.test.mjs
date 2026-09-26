/**
 * The one-time "sign in to save sessions" message at session start.
 *
 * A plugin installed from a repository or a directory brings the connection
 * and the skills, but the session-end hook saves only with the CLI's own
 * sign-in, which nothing in that install makes. Without a word, capture fails
 * silently forever. So session start tells the person once, in the message
 * Claude Code shows the user (`systemMessage`), and never again.
 */

import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
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

const home = await mkdtemp(join(tmpdir(), "context-hint-"));
process.env.HOME = home;
process.env.CONTEXT_CONFIG = join(home, ".context", "config.json");
const configPath = join(home, ".context", "credentials.json");
const { sessionStart } = await import("../src/commands.js");
const { writeSetting } = await import("../src/settings.js");
const ENDPOINT = "https://mcp.example.test/mcp";

async function start() {
  let out = "";
  await sessionStart({ endpoint: ENDPOINT, configPath, stdin: [JSON.stringify({ session_id: "s", cwd: home })], emit: (text) => (out = text) });
  return JSON.parse(out);
}

let first = await start();
check("not signed in, capture on: the user is told how to turn saving on", /\/context:login/.test(first.systemMessage || ""));
check("...with the terminal alternative for agents without the skill", (first.systemMessage || "").includes("npx @supa-media/context login"));
check("...and the agent still gets its orientation instruction", /orient/.test(first.hookSpecificOutput?.additionalContext || ""));
check("...and the hint is remembered", existsSync(join(home, ".context", "login-hint-shown")));
const second = await start();
check("it is said once, not every session", second.systemMessage === undefined);

const quiet = await mkdtemp(join(tmpdir(), "context-hint-off-"));
process.env.HOME = quiet;
process.env.CONTEXT_CONFIG = join(quiet, ".context", "config.json");
await writeSetting("capture", "off");
check("with capture off there is nothing to sign in for, so nothing is said", (await start()).systemMessage === undefined);

const signedIn = await mkdtemp(join(tmpdir(), "context-hint-in-"));
process.env.HOME = signedIn;
process.env.CONTEXT_CONFIG = join(signedIn, ".context", "config.json");
const signedInCredentials = join(signedIn, "credentials.json");
await writeFile(signedInCredentials, JSON.stringify({ endpoints: { [ENDPOINT]: { clientId: "c", refreshToken: "r", scope: "context:read context:write" } } }));
let out = "";
await sessionStart({ endpoint: ENDPOINT, configPath: signedInCredentials, stdin: [JSON.stringify({ session_id: "s", cwd: signedIn })], emit: (text) => (out = text) });
check("once signed in, nothing is said", JSON.parse(out).systemMessage === undefined);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

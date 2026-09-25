/**
 * The hook commands after sign-in: the other two clients, capture, refresh,
 * session start and state. Split from test.mjs, which it continues.
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


// -- the login

let approved = null;
await commands.installHooks({
  endpoint: server.endpoint,
  client: "claude-code",
  configPath,
  openBrowser: async (href) => {
    approved = href;
    await server.state.approve(href);
  },
  log,
});

// Snapshotted before anything else clears `said`: the capture-only install is
// where the wider option has to be offered, and by the time the orient install
// runs below this log is long gone.
const firstInstallLog = said.join("\n");

const authorize = server.state.lastAuthorize;
check("the hook registers itself as its own client", server.state.registered.length === 1);
check(
  "it registers a portless loopback redirect, per RFC 8252",
  server.state.registered[0].redirect_uris[0] === "http://127.0.0.1/context-hook/callback"
);
check("it asks for capture access and nothing else", authorize.searchParams.get("scope") === "context:capture");
check(
  "the request is PKCE S256, never plain",
  authorize.searchParams.get("code_challenge_method") === "S256" &&
    (authorize.searchParams.get("code_challenge") || "").length > 20
);
check("the request names the resource it is for", authorize.searchParams.get("resource") === `${server.origin}/mcp`);
check(
  "the redirect it actually listens on is loopback with a real port",
  /^http:\/\/127\.0\.0\.1:\d+\/context-hook\/callback$/.test(authorize.searchParams.get("redirect_uri"))
);
check("the browser was sent to the authorization endpoint", (approved || "").startsWith(`${server.origin}/oauth/authorize`));

// -- the credential at rest

const stored = JSON.parse(await readFile(configPath, "utf8"));
const record = stored.endpoints[`${server.origin}/mcp`];
check("the refresh token is stored for this endpoint", typeof record.refreshToken === "string");
check(
  "the credential file is not readable by anyone else",
  ((await stat(configPath)).mode & 0o777) === 0o600
);
check("nothing printed during install was a token", !said.join("\n").includes(record.refreshToken));

said.length = 0;
await commands.status({ endpoint: server.endpoint, configPath, log });
check(
  "status reports the scope without printing the credential",
  said.join("\n").includes("context:capture") &&
    !said.join("\n").includes(record.refreshToken) &&
    !said.join("\n").includes(record.accessToken)
);


// -- the other two clients
//
// The first version of this package claimed Claude Code was the only client
// with a documented end-of-session hook. That was asserted from memory and is
// false: Codex and Gemini CLI both ship hook systems of the same shape, with
// `transcript_path` on stdin and `additionalContext` at session start. What
// each one differs in is the file it lives in and what it calls the end of a
// session — which is exactly what these check.
const codexSettings = join(home, "codex-hooks.json");
const geminiSettings = join(home, "gemini-settings.json");
process.env.CONTEXT_HOOK_CODEX_SETTINGS = codexSettings;
process.env.CONTEXT_HOOK_GEMINI_SETTINGS = geminiSettings;

await writeFile(codexSettings, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo theirs" }] }] } }));
await installHook({ clientId: "codex", endpoint: server.endpoint });
const codex = JSON.parse(await readFile(codexSettings, "utf8"));
/**
 * Read defensively, and that is not fussiness.
 *
 * The first version of these read `codex.hooks.Stop[0].hooks[0].command`
 * directly, so sabotaging the event name threw a TypeError instead of failing
 * a check — which stops the run and leaves every later check unreported. A
 * crash is not a pass, but it is not a usable failure either.
 */
const commandFor = (config, event) =>
  String(config?.hooks?.[event]?.[0]?.hooks?.[0]?.command || "");

check(
  "Codex gets its end-of-session hook on Stop, which is what it calls it",
  commandFor(codex, "Stop").includes("@supa-media/context capture") &&
    codex.hooks.SessionEnd === undefined
);
check("Codex gets the session-start hook too", commandFor(codex, "SessionStart").includes("session-start"));
check("and their own Codex hooks survive", commandFor(codex, "PreToolUse") === "echo theirs");

await installHook({ clientId: "gemini-cli", endpoint: server.endpoint });
const gemini = JSON.parse(await readFile(geminiSettings, "utf8"));
check(
  "Gemini CLI gets SessionStart and SessionEnd, which is what it calls it",
  commandFor(gemini, "SessionStart").includes("session-start") &&
    commandFor(gemini, "SessionEnd").includes("capture") &&
    gemini.hooks.Stop === undefined
);
check(
  "the installed command names the client, so capture attributes correctly",
  commandFor(gemini, "SessionEnd").includes("--client gemini-cli") &&
    commandFor(codex, "Stop").includes("--client codex")
);
// `timeout` means seconds in Claude Code and Codex and MILLISECONDS in Gemini
// CLI. Writing a number that means two different things depending on which file
// it lands in is how a 5-second timeout becomes 5 milliseconds, so none is
// written and every client's own default stands.
check(
  "no timeout is written, because the unit differs between these files",
  [codex, gemini, JSON.parse(await readFile(settingsPath, "utf8"))].every((config) =>
    Object.values(config.hooks).every((matchers) =>
      matchers.every((matcher) => matcher.hooks.every((hook) => hook.timeout === undefined))
    )
  )
);
check(
  "installing one client does not touch another's file",
  JSON.parse(await readFile(codexSettings, "utf8")).hooks.SessionEnd === undefined
);
said.length = 0;
await commands.installHooks({
  endpoint: server.endpoint,
  client: "codex",
  configPath,
  openBrowser: (href) => server.state.approve(href),
  log,
});
// The parser was written against one client's transcript shape. Saying so is
// the whole difference between a hook that under-captures and one that lies:
// the session-start half needs no transcript at all, and a capture that finds
// nothing announces it rather than going quiet.
check(
  "installing an unverified client says which half is unproven",
  said.join("\n").includes("transcript parser") && said.join("\n").includes("Claude Code")
);
check(
  "and the verified client is not given that caveat",
  !firstInstallLog.includes("transcript parser")
);

const codexRemoval = await uninstallHook({ clientId: "codex" });
check("uninstalling Codex removes both of ours and leaves theirs", codexRemoval.removed === 2);
check(
  "an unsupported client is refused by name, before anything is written",
  (() => {
    try {
      clientById("chatgpt");
      return false;
    } catch (error) {
      return error.message.includes("claude-code") && error.message.includes("codex");
    }
  })()
);
await uninstallHook({ clientId: "gemini-cli" });

// -- the capture itself

await installHook({ clientId: "claude-code", endpoint: server.endpoint });
const transcriptPath = join(home, "session.jsonl");
await writeFile(transcriptPath, TRANSCRIPT);

said.length = 0;
const captured = await commands.capture({
  endpoint: server.endpoint,
  client: "claude-code",
  configPath,
  stdin: [JSON.stringify({ session_id: "abc123", transcript_path: transcriptPath, cwd: "/work/context" })],
  log,
});
check("a session at its end is posted to the inbox", captured.saved === true);
const posted = server.state.captures.at(-1);
check("the capture is attributed to the hook", posted.source === "hook:claude-code");
check("it carries the session id so a re-run is not a second note", posted.external_id === "claude-code:abc123");
check("it says what was deliberately left out", posted.text.includes("no system prompts, reasoning, tool calls"));
for (const [name, secret] of Object.entries(SECRETS)) {
  check(`the posted body carries no ${name}`, !JSON.stringify(posted).includes(secret));
}
check("it was posted with a bearer token", server.state.seenTokens.at(-1).startsWith("Bearer "));

// -- refresh, and the rotation that has to be written back

await commands.installHooks({
  endpoint: server.endpoint,
  configPath,
  openBrowser: (href) => server.state.approve(href),
  log,
});
const before = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];
// Age the stored access token by hand — the alternative is waiting an hour.
const aged = JSON.parse(await readFile(configPath, "utf8"));
aged.endpoints[`${server.origin}/mcp`].expiresAt = Date.now() - 1000;
await writeFile(configPath, JSON.stringify(aged));

const refreshed = await commands.accessTokenFor({ endpoint: server.endpoint, configPath });
const after = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];
check("an expired access token is refreshed rather than used", refreshed !== before.accessToken);
check(
  "a rotated refresh token is written back before it is needed again",
  after.refreshToken !== before.refreshToken && typeof after.refreshToken === "string"
);
check("and the refreshed token still works", (await commands.accessTokenFor({ endpoint: server.endpoint, configPath })) === refreshed);

// -- the ways a capture is allowed to do nothing

said.length = 0;
const noPayload = await commands.capture({ endpoint: server.endpoint, configPath, stdin: [""], log });
check("a session end with no transcript saves nothing and says so", noPayload.saved === false && said.join("").includes("nothing saved"));

const emptyPath = join(home, "empty.jsonl");
await writeFile(emptyPath, "");
const emptyCapture = await commands.capture({
  endpoint: server.endpoint,
  configPath,
  stdin: [JSON.stringify({ transcript_path: emptyPath })],
  log,
});
check("a session with nothing user-visible in it saves nothing", emptyCapture.saved === false);

// -- session start: orientation that does not depend on the agent asking

let injected = "";
const emit = (text) => {
  injected = text;
};
const startWith = async (stdinValue = JSON.stringify({ session_id: "s1", source: "startup" })) => {
  injected = "";
  const result = await commands.sessionStart({
    endpoint: server.endpoint,
    configPath,
    stdin: [stdinValue],
    emit,
  });
  return { result, payload: JSON.parse(injected) };
};

// The install so far is capture-only, which cannot read a note — so the start
// hook must not even try, and must still say something useful.
const capturedStart = await startWith();
check(
  "a start hook emits the documented additionalContext envelope",
  capturedStart.payload.hookSpecificOutput.hookEventName === "SessionStart" &&
    typeof capturedStart.payload.hookSpecificOutput.additionalContext === "string"
);
check(
  "a capture-only install injects the instruction to orient",
  capturedStart.result.live === false &&
    capturedStart.payload.hookSpecificOutput.additionalContext.includes("call the `orient` tool")
);
check(
  "and it does not spend a request finding out it cannot read",
  server.state.mcpCalls.length === 0
);

// Opting in to reading is a new authorization, not a settings change.
const beforeOptIn = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];
said.length = 0;
await commands.installHooks({
  endpoint: server.endpoint,
  orient: true,
  configPath,
  openBrowser: (href) => server.state.approve(href),
  log,
});
const optedIn = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];
check("opting in to orientation asks for read access", optedIn.scope.includes("context:read"));
check(
  "it never asks for the private tier",
  !optedIn.scope.includes("context:private") &&
    !server.state.lastAuthorize.searchParams.get("scope").includes("context:private")
);
check(
  "a scope change re-registers rather than reusing a client that asked for less",
  optedIn.clientId !== beforeOptIn.clientId
);
check(
  "the capture-only install tells you the wider option exists and what it costs",
  firstInstallLog.includes("--orient") && firstInstallLog.includes("unattended")
);

const liveStart = await startWith();
check("with read access the orientation itself is injected", liveStart.result.live === true);
check(
  "and it is the gateway's own orient output",
  liveStart.payload.hookSpecificOutput.additionalContext.includes("12 notes visible.")
);
check(
  "it is labelled as a snapshot rather than passed off as live",
  /as of the moment this session started/.test(
    liveStart.payload.hookSpecificOutput.additionalContext
  )
);
check(
  "it was fetched with one plain tools/call and no handshake",
  server.state.mcpCalls.length === 1 &&
    server.state.mcpCalls[0].method === "tools/call" &&
    server.state.mcpCalls[0].params.name === "orient"
);

// The failure that matters: this runs before the person has typed anything.
server.state.orientFails = true;
const failedStart = await startWith();
check(
  "a gateway that will not answer falls back to the instruction",
  failedStart.result.live === false &&
    failedStart.payload.hookSpecificOutput.additionalContext.includes("call the `orient` tool")
);
server.state.orientFails = false;

const emptyStart = await startWith("");
check("a start hook with no payload still injects something", emptyStart.result.injected.length > 0);

// -- state, the CSRF defence
//
// The unit checks below pass whether or not anything calls the function, which
// is how the first version of this file let a sabotage through: `stateMatches`
// was covered and its *use* was not. So the flow is driven with a browser that
// comes back with somebody else's state, and the login must fail and leave the
// stored credential alone.
const goodRecord = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];
let rejected = null;
try {
  await commands.authorize({
    endpoint: server.endpoint,
    configPath,
    log,
    openBrowser: async (href) => {
      const url = new URL(href);
      server.state.lastAuthorize = url;
      const code = `code_forged_${server.state.codes.size + 1}`;
      server.state.codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        redirectUri: url.searchParams.get("redirect_uri"),
        scope: url.searchParams.get("scope"),
      });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", "not-the-state-we-sent");
      await fetch(back.href);
    },
  });
} catch (error) {
  rejected = error;
}
check("a login that comes back with the wrong state is refused", rejected !== null);
check(
  "and the refusal happens before the code is exchanged",
  rejected !== null && /state/i.test(rejected.message)
);
check(
  "a refused login leaves the working credential untouched",
  JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`].refreshToken ===
    goodRecord.refreshToken
);

check("a state mismatch is not equal", !stateMatches("abc", "abd"));
check("a state of a different length is not equal", !stateMatches("abc", "abcd"));
check("the right state matches", stateMatches("abc", "abc"));
const pkce = createPkce();
check("a fresh verifier and challenge differ and are long", pkce.verifier !== pkce.challenge && pkce.verifier.length >= 43);

/**
 * **A CLIENT MUST DECLARE THE SCOPE IT IS ABOUT TO ASK FOR.**
 *
 * `install` picks `ORIENT_SCOPE` or `HOOK_SCOPE`, refuses to reuse a client
 * registered for the other one, and says why: "re-using a client registered for
 * the narrower one would ask for something it never declared. Widening silently
 * is the thing this whole flow exists to not do."
 *
 * The re-registration it then performs did not carry the scope. `registerClient`
 * named `context:capture` whatever the caller wanted, so an `--orient` install
 * registered a capture-only client and immediately asked it to authorize
 * `context:read` — asking for something it never declared, which is the sentence
 * above.
 *
 * Not an escalation today: the consent screen governs what is granted, and the
 * gateway does not currently refuse an authorize request wider than the client
 * record. It costs the two things that record is for. A person auditing their
 * registered clients — the reason each machine registers its own, so revoking
 * the laptop you lost does not sign out the one on your desk — sees "capture"
 * beside a client that holds read. And the day the gateway does enforce the
 * registered scope, every `--orient` install breaks.
 */
const registrationScopes = [];
async function registrationScopeFor(scope) {
  const captured = { scope: null };
  await registerClient(
    { registrationEndpoint: "https://ctx.example/oauth/register" },
    {
      clientName: "Context hook (test)",
      scope,
      fetchImpl: async (_url, init) => {
        captured.scope = JSON.parse(init.body).scope;
        return { ok: true, json: async () => ({ client_id: "cid" }) };
      },
    }
  );
  registrationScopes.push(captured.scope);
  return captured.scope;
}
check(
  "a capture-only install registers a capture-only client",
  (await registrationScopeFor(HOOK_SCOPE)) === HOOK_SCOPE
);
check(
  "an orienting install registers a client that declares the read scope",
  (await registrationScopeFor(ORIENT_SCOPE)) === ORIENT_SCOPE
);
check(
  "and with no scope named it still declares the narrow one, never the menu",
  (await registrationScopeFor(undefined)) === HOOK_SCOPE
);

/**
 * ...AND THE PRODUCTION CALLER MUST BE THE ONE PASSING IT.
 *
 * The three checks above drive `registerClient` directly, which is exactly the
 * gap the `state` section twenty lines up records: a unit check passes whether
 * or not anything calls the function. Measured -- deleting the `scope,` line
 * from `commands.authorize` leaves all three of them green, because they never
 * go through it, and that is the line the whole section exists to protect.
 *
 * So the flow itself is driven, twice, with a browser that approves, and the
 * assertion is made against the registration body the fake gateway actually
 * received. `state.registered` is appended to by `/oauth/register`, so this
 * cannot pass without a real request having been made.
 *
 * A fresh config path each time, because `authorize` reuses a stored client
 * whose scope already matches and would then register nothing at all.
 */
async function registrationBodyFrom(orient) {
  const before = server.state.registered.length;
  await commands.authorize({
    endpoint: server.endpoint,
    orient,
    configPath: join(await mkdtemp(join(tmpdir(), "context-hook-scope-")), "config.json"),
    log,
    openBrowser: (href) => server.state.approve(href),
  });
  const registered = server.state.registered.slice(before);
  if (registered.length !== 1) throw new Error(`expected one registration, got ${registered.length}`);
  return registered[0];
}
const captureRegistration = await registrationBodyFrom(false);
check(
  "the install flow registers a capture-only client",
  captureRegistration.scope === HOOK_SCOPE
);
const orientRegistration = await registrationBodyFrom(true);
check(
  "and --orient registers one that declares the read scope it then asks for",
  orientRegistration.scope === ORIENT_SCOPE &&
    server.state.lastAuthorize.searchParams.get("scope") === ORIENT_SCOPE
);


server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

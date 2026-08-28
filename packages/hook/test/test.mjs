/**
 * The hook, end to end, against a stub authorization server and gateway.
 *
 * Offline and dependency-free, like the gateway's own suite. The stub speaks
 * the real contract — discovery, dynamic registration, PKCE S256, an
 * authorization code bound to its challenge, refresh-token rotation — so a
 * client that passes here is a client that would pass against the worker.
 *
 * ## What this is actually guarding
 *
 * Two things, and they are not the OAuth dance:
 *
 *  1. **What leaves the machine.** `transcript.js` decides which parts of a
 *     session log get posted, and the log holds system prompts, reasoning, tool
 *     calls and every file the agent read. Most of the checks below are one
 *     shape of secret-bearing line, asserted absent.
 *  2. **Somebody else's settings file.** Installing merges into a file the
 *     person owns. It must add exactly one entry, keep everything else, and
 *     replace rather than stack on a second install.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *  1. **`textFromContent` fishing for any `.text`** instead of switching on
 *     `block.type`. 3 checks failed — tool results, tool inputs and thinking
 *     all arrived in the capture. This is the bug the function exists to not
 *     have, and it passes any test written with plain string messages.
 *  2. **State compared with `==` and the mismatch warned rather than thrown.**
 *     1 check failed.
 *  3. **The install merge replacing `hooks.SessionEnd` wholesale.** 1 check
 *     failed — the person's own hook was deleted. Note that the "installing
 *     twice does not stack" check stays green under this sabotage, because
 *     clobbering everything is idempotent too; the two checks look like a pair
 *     and only one of them is load-bearing here.
 *
 *  4. **The start hook attempting a read on a capture-only grant** (the scope
 *     gate removed). 3 checks failed: the injection stopped falling back to the
 *     directive, and a request was spent being told no on every session.
 *  5. **Reusing the registered client across a scope change.** 1 check failed —
 *     an install that widens to read would otherwise authorize through a client
 *     that declared it wanted less.
 *
 *  6. **Codex's end-of-session event renamed to `SessionEnd`** (it calls it
 *     `Stop`). 3 checks failed — but only after those checks were rewritten to
 *     read defensively. The first version indexed straight into
 *     `codex.hooks.Stop[0]`, so the sabotage threw a TypeError, stopped the
 *     run, and left every later check unreported: a crash is not a pass, and it
 *     is not a usable failure either. A wrong event name is the exact shape of
 *     "installed and never fires" this package refuses to ship, so it has to
 *     fail by name.
 *
 * Sabotage 2 originally failed *nothing*: `stateMatches` had unit checks and
 * its use in the flow had none, which is the shape of hole this project has
 * been caught by before. The login is now driven with a browser that comes back
 * with the wrong state.
 */

import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import * as commands from "../src/commands.js";
import { transcriptToMarkdown, messageFromEntry } from "../src/transcript.js";
import { createPkce, stateMatches } from "../src/oauth.js";
import { clientById, installHook, uninstallHook, HOOK_MARKER } from "../src/install.js";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

/* ------------------------- a stub authorization server ------------------- */

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function startStubServer() {
  const state = {
    registered: [],
    codes: new Map(),
    refreshTokens: new Map(),
    captures: [],
    mcpCalls: [],
    orientFails: false,
    /** Every Authorization header the gateway half was shown. */
    seenTokens: [],
    rotate: true,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, body, type = "application/json") => {
      response.writeHead(status, { "Content-Type": type });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    };
    const origin = `http://127.0.0.1:${server.address().port}`;

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/oauth/register") {
      const body = JSON.parse(await readBody());
      state.registered.push(body);
      return send(201, { client_id: `client_${state.registered.length}` });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await readBody());
      if (form.get("grant_type") === "refresh_token") {
        const record = state.refreshTokens.get(form.get("refresh_token"));
        if (!record) return send(400, { error: "invalid_grant" });
        state.refreshTokens.delete(form.get("refresh_token"));
        const next = `refresh_${state.refreshTokens.size + 2}`;
        state.refreshTokens.set(next, record);
        return send(200, {
          access_token: `access_${next}`,
          refresh_token: state.rotate ? next : form.get("refresh_token"),
          expires_in: 3600,
          scope: record.scope,
        });
      }
      const issued = state.codes.get(form.get("code"));
      if (!issued) return send(400, { error: "invalid_grant" });
      state.codes.delete(form.get("code"));
      // The real thing verifies the challenge; so does this, or the test would
      // pass for a client that sent no verifier at all.
      const presented = base64Url(createHash("sha256").update(form.get("code_verifier") || "").digest());
      if (presented !== issued.challenge) return send(400, { error: "invalid_grant" });
      if (form.get("redirect_uri") !== issued.redirectUri) return send(400, { error: "invalid_grant" });
      state.refreshTokens.set("refresh_1", { scope: issued.scope });
      return send(200, {
        access_token: "access_1",
        refresh_token: "refresh_1",
        expires_in: 3600,
        scope: issued.scope,
      });
    }
    if (url.pathname === "/mcp") {
      state.seenTokens.push(request.headers.authorization || "");
      const rpc = JSON.parse(await readBody());
      state.mcpCalls.push(rpc);
      if (state.orientFails) return send(500, { error: "boom" });
      return send(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: "# Orientation\n\n12 notes visible." }] },
      });
    }
    if (url.pathname === "/inbox") {
      state.seenTokens.push(request.headers.authorization || "");
      state.captures.push(JSON.parse(await readBody()));
      return send(200, { ok: true });
    }
    return send(404, { error: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  /** Stand in for the person and their browser. */
  state.approve = async (href) => {
    const url = new URL(href);
    const code = `code_${state.codes.size + 1}`;
    state.codes.set(code, {
      challenge: url.searchParams.get("code_challenge"),
      redirectUri: url.searchParams.get("redirect_uri"),
      scope: url.searchParams.get("scope"),
    });
    state.lastAuthorize = url;
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    await fetch(back.href);
  };

  return { origin, endpoint: `${origin}/mcp`, state, close: () => server.close() };
}

/* --------------------------------- fixtures ------------------------------ */

/**
 * A session log shaped like the real thing: a system line, a sidechain, a
 * thinking block, a tool call and its result, and two messages a person
 * actually saw. Every line but the last two is something that must not travel.
 */
const SECRETS = {
  systemPrompt: "SYSTEM-PROMPT-DO-NOT-CAPTURE",
  thinking: "INTERNAL-REASONING-DO-NOT-CAPTURE",
  toolInput: "cat /home/someone/.aws/credentials",
  toolResult: "AKIA-FAKE-KEY-DO-NOT-CAPTURE",
  sidechain: "SUBAGENT-CHATTER-DO-NOT-CAPTURE",
  meta: "REPLAYED-META-LINE-DO-NOT-CAPTURE",
};

const TRANSCRIPT = [
  { type: "system", content: SECRETS.systemPrompt },
  { type: "user", isMeta: true, message: { role: "user", content: SECRETS.meta } },
  { type: "user", message: { role: "user", content: "Rename the orient tool." } },
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: SECRETS.thinking },
        { type: "text", text: "I will rename it and update the tests." },
        { type: "tool_use", name: "Bash", input: { command: SECRETS.toolInput } },
      ],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: [{ type: "text", text: SECRETS.toolResult }] }],
    },
  },
  {
    type: "assistant",
    isSidechain: true,
    message: { role: "assistant", content: [{ type: "text", text: SECRETS.sidechain }] },
  },
  { type: "assistant", message: { role: "assistant", content: "Done — 484 checks pass." } },
  "{ this line is half written",
]
  .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
  .join("\n");

/* ---------------------------------- run ---------------------------------- */

const server = await startStubServer();
const home = await mkdtemp(join(tmpdir(), "context-hook-"));
const configPath = join(home, "hook.json");
const settingsPath = join(home, "claude-settings.json");
process.env.CONTEXT_HOOK_CLAUDE_SETTINGS = settingsPath;

const said = [];
const log = (line = "") => said.push(String(line));

// -- what leaves the machine

const converted = transcriptToMarkdown(TRANSCRIPT);
check("only user-visible messages survive the transcript", converted.messages === 3);
for (const [name, secret] of Object.entries(SECRETS)) {
  check(`the ${name} never reaches the capture`, !converted.markdown.includes(secret));
}
check(
  "what the person did say is kept, on both sides",
  converted.markdown.includes("Rename the orient tool.") &&
    converted.markdown.includes("I will rename it and update the tests.") &&
    converted.markdown.includes("Done — 484 checks pass.")
);
check(
  "a half-written last line is skipped rather than failing the capture",
  converted.markdown.includes("Done —")
);
check(
  "a tool_result's nested text is not mistaken for a message",
  messageFromEntry({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "x" }] }] },
  }) === null
);

// -- the login

let approved = null;
await commands.install({
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

// -- the settings file

const settings = JSON.parse(await readFile(settingsPath, "utf8"));
check(
  "the hook is installed as a SessionEnd command",
  settings.hooks.SessionEnd[0].hooks[0].command.includes("@context-lc/hook capture")
);
check(
  "and as a SessionStart command, so orientation does not depend on the agent",
  settings.hooks.SessionStart[0].hooks[0].command.includes("@context-lc/hook session-start")
);
check(
  "the installed command carries the endpoint but never the credential",
  settings.hooks.SessionEnd[0].hooks[0].command.includes(server.endpoint) &&
    !JSON.stringify(settings).includes(record.refreshToken)
);

// Somebody else's hook, and then a second install over the top of it.
await writeFile(
  settingsPath,
  JSON.stringify({
    model: "opus",
    hooks: {
      SessionEnd: [{ hooks: [{ type: "command", command: "echo mine" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo also mine" }] }],
    },
  })
);
await installHook({ clientId: "claude-code", endpoint: server.endpoint });
await installHook({ clientId: "claude-code", endpoint: server.endpoint });
const merged = JSON.parse(await readFile(settingsPath, "utf8"));
check("an unrelated setting survives the merge", merged.model === "opus");
check("the person's own SessionEnd hook survives", merged.hooks.SessionEnd.some((entry) => entry.hooks[0].command === "echo mine"));
check("their other hook events are untouched", merged.hooks.PreToolUse.length === 1);
// Ours is identified by the command, not by a marker property. We stopped
// writing one: an unknown key inside somebody else's config schema is a risk
// across three parsers whose strictness this package cannot test, and the cost
// of being wrong is their whole settings file failing to load.
const isOurEntry = (entry) =>
  entry.hooks.some((hook) => String(hook.command || "").includes("@context-lc/hook"));
check(
  "installing twice replaces our entry rather than stacking a duplicate",
  merged.hooks.SessionEnd.filter(isOurEntry).length === 1 &&
    merged.hooks.SessionStart.filter(isOurEntry).length === 1
);
check(
  "nothing we write carries a property outside the client's own schema",
  merged.hooks.SessionEnd.filter(isOurEntry).every((entry) =>
    entry.hooks.every((hook) =>
      Object.keys(hook).every((key) => ["type", "command"].includes(key))
    )
  ) && !JSON.stringify(merged).includes(HOOK_MARKER)
);
// An entry written by an older version carried the marker. It must still be
// recognised, or an upgrade stacks a second hook beside the first and every
// session gets posted twice.
await writeFile(
  settingsPath,
  JSON.stringify({
    // Carries the person's own hooks too, because the checks below this one
    // assert what survives an uninstall — a fixture that quietly dropped them
    // would make those pass for the wrong reason.
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "npx -y @context-lc/hook capture --old", [HOOK_MARKER]: true }] },
        { hooks: [{ type: "command", command: "echo mine" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo also mine" }] }],
    },
  })
);
await installHook({ clientId: "claude-code", endpoint: server.endpoint });
const upgraded = JSON.parse(await readFile(settingsPath, "utf8"));
check(
  "an entry from an older version is replaced, not stacked beside",
  upgraded.hooks.SessionEnd.filter(isOurEntry).length === 1 &&
    upgraded.hooks.SessionEnd.some((entry) => entry.hooks[0].command === "echo mine")
);

const removal = await uninstallHook({ clientId: "claude-code" });
const afterRemoval = JSON.parse(await readFile(settingsPath, "utf8"));
check("uninstall removes both of ours", removal.removed === 2);
check(
  "and leaves theirs exactly as it was",
  afterRemoval.hooks.SessionEnd.length === 1 &&
    afterRemoval.hooks.SessionEnd[0].hooks[0].command === "echo mine" &&
    afterRemoval.hooks.PreToolUse.length === 1
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
  commandFor(codex, "Stop").includes("@context-lc/hook capture") &&
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
await commands.install({
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

await commands.install({
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
await commands.install({
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

server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

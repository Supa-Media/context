/**
 * The three supported clients, the capture itself, token refresh, the ways a
 * capture is allowed to do nothing, and session-start orientation. See
 * `test.mjs` for the suite's overall shape and the sabotage record.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as commands from "../src/commands.js";
import { clientById, installHook, uninstallHook } from "../src/install.js";

import { check, SECRETS, TRANSCRIPT } from "./harness.mjs";

export async function runClientsAndCaptureChecks(ctx) {
  const { server, home, configPath, settingsPath, said, log, firstInstallLog } = ctx;

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
    commandFor(codex, "Stop").includes("@supa-media/context-hook capture") &&
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
}

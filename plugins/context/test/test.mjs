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


/**
 * This org publishes exactly one npm scope, `@supa-media`, through
 * `supa-framework`'s own pipeline — see docs/decisions/repository-and-review.md,
 * "Every package this org publishes is `@supa-media/*`, through the
 * framework's pipeline". A product-specific scope (this package's own name,
 * for one PR, before anyone asked) is the simplification that section names
 * and the cost it names for reversing it. This is the test that fails if it
 * is reversed: rename the package back to `@context-lc/hook`, or to any
 * other scope, and this is red — in the same suite `prepublishOnly` runs
 * before every publish, not silently in a registry nobody checks until an
 * install breaks.
 */
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
check(
  "the package publishes under the org's one npm scope, @supa-media",
  pkg.name.startsWith("@supa-media/")
);


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


// -- what leaves the machine

// -- an authorization server may not arrive over plain http
//
// `discover` follows RFC 9728: the resource names the authorization server,
// and that server's metadata names where the code and the token go. Every one
// of those is a string off the wire, and the credential at the end of it is
// the one that sits unattended on a laptop. Loopback stays permitted — the
// suite's own stub is `http://127.0.0.1`, and RFC 8252 carves it out — but a
// routable `http://` host means the code and the PKCE verifier cross the
// network in the clear.
const discoveryError = async (servers, metadata) => {
  const fetchImpl = async (target) =>
    String(target).includes("oauth-protected-resource")
      ? { ok: true, json: async () => ({ resource: "https://ctx.example/mcp", authorization_servers: servers }) }
      : { ok: true, json: async () => metadata };
  return discover("https://ctx.example/mcp", { fetchImpl }).then(
    () => null,
    (error) => error
  );
};
const discoveryResult = async (metadata) => {
  const fetchImpl = async (target) =>
    String(target).includes("oauth-protected-resource")
      ? { ok: true, json: async () => ({ resource: "https://ctx.example/mcp", authorization_servers: ["https://ctx.example"] }) }
      : { ok: true, json: async () => metadata };
  return discover("https://ctx.example/mcp", { fetchImpl });
};
const httpsMeta = (origin) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
});
// The metadata here is entirely https, so ONLY the issuer check can refuse
// this. Written with http endpoints too, the endpoint check caught it and the
// issuer check could be deleted with the suite still green.
// -- the endpoint the PERSON hands in is a credential URL too
//
// The checks below cover what DISCOVERY names. They do not cover the endpoint
// discovery starts from, and that is the one the access token is sent to on
// every capture: `capture` POSTs `Authorization: Bearer <token>` to
// `new URL("/inbox", endpoint)`. It usually gets there without touching
// `discover` at all — `accessTokenFor` returns a cached, unexpired token
// before the discovery call — so a check living only in `discover` would miss
// the common path. `endpointKey` is the choke point instead: save, load,
// forget and the not-signed-in message all resolve through it.
const endpointRefused = (value) => {
  try {
    credentialEndpointKey(value);
    return false;
  } catch {
    return true;
  }
};
// THE PLACEMENT IS THE CLAIM, AND THE THREE CHECKS BELOW DO NOT PROVE IT.
// They exercise the predicate directly. What this fix actually asserts is that
// the credential-bearing paths RESOLVE THROUGH it — and that is enforced only
// by call-graph structure, so a `loadEndpoint` that canonicalises inline
// instead of calling the guarded key passes every one of them while the token
// goes out in the clear. This drives the real path end to end, and asserts the
// shape that matters: refused AND zero network calls, because a refusal after
// the POST would be worthless.
{
  const httpEndpoint = "http://evil.example/mcp";
  const leakHome = await mkdtemp(join(tmpdir(), "context-hook-http-"));
  const leakConfig = join(leakHome, "hook.json");
  await writeFile(
    leakConfig,
    JSON.stringify({
      endpoints: {
        [httpEndpoint]: { accessToken: "SECRET-TOKEN", expiresAt: Date.now() + 3_600_000 },
      },
    }),
    "utf8"
  );
  const seen = [];
  const recordingFetch = async (target, init) => {
    seen.push({ target: String(target), auth: init?.headers?.Authorization || null });
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  };
  const transcript = join(leakHome, "t.jsonl");
  await writeFile(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), "utf8");
  let refused = false;
  try {
    await commands.capture({
      endpoint: httpEndpoint,
      configPath: leakConfig,
      stdin: [JSON.stringify({ transcript_path: transcript })],
      fetchImpl: recordingFetch,
      log: () => {},
    });
  } catch {
    refused = true;
  }
  check(
    "capture refuses an http endpoint without putting the token on the wire",
    refused && seen.length === 0
  );
}

// `authorize` checks before it discovers, and only a CALL COUNT can see that:
// remove the guard and install still refuses — `loadEndpoint` and the metadata
// checks both backstop it — but only after two cleartext `.well-known`
// requests have told a passive observer that this machine is installing
// against that endpoint. No token is involved in any variant, which is why
// this is metadata rather than credential; it is asserted because otherwise
// nothing at all notices the line going away.
{
  const seen = [];
  let refused = false;
  try {
    await commands.authorize({
      endpoint: "http://evil.example/mcp",
      configPath: join(home, "unused.json"),
      fetchImpl: async (target) => {
        seen.push(String(target));
        return { ok: false, status: 404, json: async () => ({}) };
      },
      log: () => {},
    });
  } catch {
    refused = true;
  }
  check(
    "install refuses an http endpoint before it makes any request at all",
    refused && seen.length === 0
  );
}

check(
  "a plain-http endpoint is refused before a token can ever be sent to it",
  endpointRefused("http://evil.example/mcp")
);
check("an https endpoint is accepted", !endpointRefused("https://ctx.example/mcp"));
check(
  "and a loopback endpoint is accepted, because self-hosting runs on it",
  !endpointRefused("http://127.0.0.1:8787/mcp")
);

check(
  "a routable http authorization server is refused",
  Boolean(await discoveryError(["http://evil.example"], httpsMeta("https://ctx.example")))
);
// The carve-out is by resolved HOST, not by substring. This hostname is
// routable and merely contains the loopback digits; a `includes("127.0.0.1")`
// carve-out accepts it, and nothing else in this file would notice.
check(
  "a routable host that merely contains the loopback address is refused",
  Boolean(
    await discoveryError(
      ["http://127.0.0.1.evil.example"],
      httpsMeta("https://ctx.example")
    )
  )
);
// One assertion per endpoint, because a loop that checks N keys is proven by
// N assertions and not by one: with only the token case, `authorization_endpoint`
// could be dropped from the walk and the whole suite stayed green.
check(
  "an https server that names an http authorization endpoint is refused",
  Boolean(
    await discoveryError(["https://ctx.example"], {
      ...httpsMeta("https://ctx.example"),
      authorization_endpoint: "http://evil.example/oauth/authorize",
    })
  )
);
// Not in the original two-key list, and part of the same walk: `registerClient`
// POSTs the machine name here and trusts the `client_id` that comes back.
check(
  "an http registration endpoint is refused too, though it carries no token",
  Boolean(
    await discoveryError(["https://ctx.example"], {
      ...httpsMeta("https://ctx.example"),
      registration_endpoint: "http://evil.example/oauth/register",
    })
  )
);
// The carve-out is "http on loopback", not "anything on loopback". Without the
// protocol gate this passes: the host is fine and the scheme is never checked.
check(
  "a non-http scheme is refused even on loopback",
  Boolean(
    await discoveryError(["https://ctx.example"], {
      ...httpsMeta("https://ctx.example"),
      token_endpoint: "ftp://127.0.0.1/oauth/token",
    })
  )
);
check(
  "an https server that names an http token endpoint is refused",
  Boolean(
    await discoveryError(["https://ctx.example"], {
      ...httpsMeta("https://ctx.example"),
      token_endpoint: "http://evil.example/oauth/token",
    })
  )
);
// The scheme loop SKIPS a non-string rather than refusing it, so the refusal
// has to live elsewhere — and these two pin the two places it lives. Without
// them, wrapping a URL in brackets walks past every check above: `fetch`
// stringifies `["http://evil.example/x"]` back into that exact URL.
check(
  "a non-string token endpoint is refused, not stringified into the credential path",
  Boolean(
    await discoveryError(["https://ctx.example"], {
      ...httpsMeta("https://ctx.example"),
      token_endpoint: ["http://evil.example/oauth/token"],
    })
  )
);
check(
  "a non-string registration endpoint never reaches the network",
  (
    await discoveryResult({
      ...httpsMeta("https://ctx.example"),
      registration_endpoint: ["http://evil.example/register"],
    })
  ).registrationEndpoint === null
);
check(
  "and loopback http still works, because the carve-out is what self-hosting runs on",
  (await discoveryError(["http://127.0.0.1:8787"], httpsMeta("http://127.0.0.1:8787"))) === null
);

const converted = transcriptToMarkdown(TRANSCRIPT);
check("only user-visible messages survive the transcript", converted.messages === 4);
check(
  "a turn the person actually typed still travels, origin and all",
  converted.markdown.includes("And keep the tests honest.")
);
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

// The capture-only sign-in (checked in hooks.test.mjs) writes the settings
// file the checks below read.
await commands.installHooks({ endpoint: server.endpoint, client: "claude-code", configPath, openBrowser: (href) => server.state.approve(href), log });
const record = JSON.parse(await readFile(configPath, "utf8")).endpoints[`${server.origin}/mcp`];

// -- the settings file

const settings = JSON.parse(await readFile(settingsPath, "utf8"));
check(
  "the hook is installed as a SessionEnd command",
  settings.hooks.SessionEnd[0].hooks[0].command.includes("@supa-media/context capture")
);
check(
  "and as a SessionStart command, so orientation does not depend on the agent",
  settings.hooks.SessionStart[0].hooks[0].command.includes("@supa-media/context session-start")
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
  entry.hooks.some((hook) => String(hook.command || "").includes("@supa-media/context "));
check(
  "installing twice replaces our entry rather than stacking a duplicate",
  merged.hooks.SessionEnd.filter(isOurEntry).length === 1 &&
    merged.hooks.SessionStart.filter(isOurEntry).length === 1
);
// The package once published as `@supa-media/context-hook`, so a command
// string it wrote legitimately contains the substring "context-hook", and a
// retired name stays recognised forever. Checking the whole serialized file for that substring
// would flag our own, correct, command line. What this check actually
// guards is narrower: no hook object carries a property KEYED `HOOK_MARKER`
// (the old boolean marker we stopped writing), regardless of what the
// command string itself says.
const noMarkerProperty = (value) => {
  if (Array.isArray(value)) return value.every(noMarkerProperty);
  if (value && typeof value === "object") {
    return !(HOOK_MARKER in value) && Object.values(value).every(noMarkerProperty);
  }
  return true;
};
check(
  "nothing we write carries a property outside the client's own schema",
  merged.hooks.SessionEnd.filter(isOurEntry).every((entry) =>
    entry.hooks.every((hook) =>
      Object.keys(hook).every((key) => ["type", "command"].includes(key))
    )
  ) && noMarkerProperty(merged)
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
        /*
          THE MARKER IS THE ONLY THING IDENTIFYING THIS ENTRY, deliberately.

          It used to carry the current package name as well, so the name match
          covered it and the marker never decided anything — MEASURED: deleting
          the `HOOK_MARKER` arm from `isOurs` reddened nothing at all. A guard
          with no case that reaches it is not a guard.

          A path command rather than an `npx` one, because that is the shape
          that can carry no package name: `hookCommand`'s own note says `npx`
          was chosen over "a path into `node_modules`", so the alternative it
          rejected is what an entry identified by nothing else looks like.
        */
        { hooks: [{ type: "command", command: "node /opt/hook/bin/context-hook.mjs capture", [HOOK_MARKER]: true }] },
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
check(
  "...and the marker-only entry is GONE, which is what makes that a replacement",
  /*
    The count above uses this file's own `isOurEntry`, which matches the
    current package name — so it reads 1 whether the old entry was replaced or
    left sitting beside the new one, and MEASURED, it did: deleting the
    `HOOK_MARKER` arm from `isOurs` reddened nothing until this line existed.
    A count of what we recognise cannot see what we failed to recognise.
  */
  !JSON.stringify(upgraded).includes("/opt/hook/bin/context-hook.mjs")
);

/*
  AND AN ENTRY FROM BEFORE THE RENAME, WHICH CARRIES NO MARKER AT ALL.

  The fixture above pairs the marker with the CURRENT package name, so it
  proves the marker path and says nothing about the name. But the marker is
  "no longer written" — this file's own words — so an install made in the
  window between the marker being dropped and the package being renamed is
  identified by its command string alone, and that string is the OLD name.

  Unrecognised, such an entry is not replaced and not removed: `install`
  leaves it and adds a second hook beside it, `uninstall` reports it as
  somebody else's and walks past. The person is then running a session-end
  hook they cannot remove with this tool, invoking a package name this project
  no longer publishes — and `npx -y` will fetch whatever is at that name.
*/
await writeFile(
  settingsPath,
  JSON.stringify({
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "npx -y @context-lc/hook capture --client claude-code" }] },
        { hooks: [{ type: "command", command: "echo mine" }] },
      ],
    },
  })
);
await installHook({ clientId: "claude-code", endpoint: server.endpoint });
const renamed = JSON.parse(await readFile(settingsPath, "utf8"));
check(
  "an entry written under the old package name is replaced, not stacked beside",
  /*
    THE TOTAL, and then how many of them are ours — in that order, because the
    second number alone cannot see this bug.

    `filter(isOurEntry).length === 1` was the whole of this check and it was
    dead: `isOurEntry` matches the CURRENT name, so it reads 1 whether the
    legacy entry was replaced or left sitting beside the new one, and it stayed
    green with `isOurs` hard-wired to `false`. That is the same "a count of
    what we recognise cannot see what we failed to recognise" the marker
    fixture two blocks up was rewritten for, shipped again one block later.

    The length of the list is the number this test can compute without using
    the thing under test: two entries, ours and the person's. Stacked, it is
    three.
  */
  renamed.hooks.SessionEnd.length === 2 &&
    renamed.hooks.SessionEnd.filter(isOurEntry).length === 1
);
check(
  "...and the person's own hook is still there",
  renamed.hooks.SessionEnd.some((entry) => entry.hooks[0].command === "echo mine")
);
check(
  "...and nothing is left invoking the name we stopped publishing",
  !JSON.stringify(renamed).includes("@context-lc/hook")
);

/*
  The second rename, same rule: `@supa-media/context-hook` became
  `@supa-media/context` when the package grew from two hooks into the installer
  for the whole plugin. An entry written under the hook-only name is ours, and
  an install replaces it rather than adding a second session-end hook beside it.
*/
await writeFile(
  settingsPath,
  JSON.stringify({
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "npx -y @supa-media/context-hook capture --client claude-code" }] },
        { hooks: [{ type: "command", command: "echo mine" }] },
      ],
    },
  })
);
await installHook({ clientId: "claude-code", endpoint: server.endpoint });
const renamedAgain = JSON.parse(await readFile(settingsPath, "utf8"));
check(
  "an entry written as @supa-media/context-hook is replaced, not stacked beside",
  renamedAgain.hooks.SessionEnd.length === 2 &&
    renamedAgain.hooks.SessionEnd.filter(isOurEntry).length === 1
);
check(
  "...and nothing is left invoking @supa-media/context-hook",
  !JSON.stringify(renamedAgain).includes("@supa-media/context-hook")
);

/*
  AND SOMEBODY ELSE'S HOOK THAT MERELY CONTAINS ONE OF OUR NAMES IS NOT OURS.

  `uninstall` deletes what it matches, out of a file the person owns, so the
  matcher decides what this tool is allowed to destroy. An unanchored
  `includes` reads `@supa-media/context-hook-extras` and `@context-lc/hooks-lint`
  as us — different packages, published by whoever registered those names — and
  a person's own `echo` mentioning the retired name in prose as us too.
  MEASURED against the unanchored version: three of the four below were
  deleted.

  Recognising a retired name forever widens the blast radius of a loose match,
  so the match is a whole token: preceded by a space or the start of the
  command, followed by a space or the end of it — which is exactly how
  `hookCommand` writes it and is not how any of these spell it.
*/
const NOT_OURS = [
  "npx -y @context-lc/hooks-lint check",
  "npx -y @supa-media/context-hook-extras run",
  "echo 'migrated off @context-lc/hook'",
  "npx -y @somebody-else/hook run",
];
await writeFile(
  settingsPath,
  JSON.stringify({
    hooks: { SessionEnd: NOT_OURS.map((command) => ({ hooks: [{ type: "command", command }] })) },
  })
);
/*
  Installed first, so the same `uninstall` has to tell OUR OWN command apart
  from four that merely contain one of our names. Asserting the strangers
  survive on their own would leave the anchor free to match nothing at all;
  this way the one number covers both directions.
*/
await installHook({ clientId: "claude-code", endpoint: server.endpoint });
const strangers = await uninstallHook({ clientId: "claude-code" });
const survivors = JSON.parse(await readFile(settingsPath, "utf8"));
check(
  "UNINSTALL DELETES NOBODY ELSE'S HOOK, INCLUDING ONES OUR NAMES ARE A SUBSTRING OF",
  /*
    Two, because `installHook` writes one entry per event in the client's map —
    `SessionStart` and `SessionEnd`.

    MEASURED: this line is NOT the one that catches an unanchored match, and
    the pair below it only looks like a second opinion. `mergeHooks` filters on
    the same `isOurs`, so an over-matching install has already deleted the
    strangers before `uninstall` is reached, and `removed` is back to 2 —
    green, over a file three hooks lighter. The `every` check underneath is the
    load-bearing one. Kept anyway, because it is what would catch the opposite
    failure: an anchor so tight that it stops recognising our own command.
  */
  strangers.removed === 2
);
check(
  "...and all four are still in the file, which is the half `removed` cannot say",
  NOT_OURS.every((command) =>
    (survivors.hooks?.SessionEnd ?? []).some((entry) => entry.hooks[0].command === command)
  )
);

await writeFile(
  settingsPath,
  JSON.stringify({
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "npx -y @context-lc/hook capture --client claude-code" }] },
      ],
    },
  })
);
const legacyRemoval = await uninstallHook({ clientId: "claude-code" });
check("uninstall removes an old-name entry rather than walking past it", legacyRemoval.removed === 1);

await writeFile(
  settingsPath,
  JSON.stringify({
    hooks: {
      SessionEnd: [
        { hooks: [{ type: "command", command: "npx -y @supa-media/context-hook capture --old", [HOOK_MARKER]: true }] },
        { hooks: [{ type: "command", command: "echo mine" }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: "echo also mine" }] }],
    },
  })
);
await installHook({ clientId: "claude-code", endpoint: server.endpoint });

const removal = await uninstallHook({ clientId: "claude-code" });
const afterRemoval = JSON.parse(await readFile(settingsPath, "utf8"));
check("uninstall removes both of ours", removal.removed === 2);
check(
  "and leaves theirs exactly as it was",
  afterRemoval.hooks.SessionEnd.length === 1 &&
    afterRemoval.hooks.SessionEnd[0].hooks[0].command === "echo mine" &&
    afterRemoval.hooks.PreToolUse.length === 1
);


server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

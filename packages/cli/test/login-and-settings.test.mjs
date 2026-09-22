/**
 * The login flow, the credential at rest, and merging the hook into
 * somebody else's settings file (install, upgrade, uninstall). See
 * `test.mjs` for the suite's overall shape and the sabotage record.
 */

import { readFile, writeFile, stat } from "node:fs/promises";

import * as commands from "../src/commands.js";
import { installHook, uninstallHook, HOOK_MARKER } from "../src/install.js";

import { check } from "./harness.mjs";

export async function runLoginAndSettingsChecks(ctx) {
  const { server, configPath, settingsPath, said, log } = ctx;

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
  ctx.firstInstallLog = firstInstallLog;

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
    settings.hooks.SessionEnd[0].hooks[0].command.includes("@supa-media/context-hook capture")
  );
  check(
    "and as a SessionStart command, so orientation does not depend on the agent",
    settings.hooks.SessionStart[0].hooks[0].command.includes("@supa-media/context-hook session-start")
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
    entry.hooks.some((hook) => String(hook.command || "").includes("@supa-media/context-hook"));
  check(
    "installing twice replaces our entry rather than stacking a duplicate",
    merged.hooks.SessionEnd.filter(isOurEntry).length === 1 &&
      merged.hooks.SessionStart.filter(isOurEntry).length === 1
  );
  // The package now publishes as `@supa-media/context-hook`, so the command
  // string this package writes legitimately contains the substring
  // "context-hook" — checking the whole serialized file for that substring
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
}

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
 *
 * ## File layout
 *
 * The checks run in the order below, against shared state (the stub server, a
 * temp home directory, and what was last printed) threaded through `ctx`.
 * Splitting this by subject keeps that order: each file below is one section
 * of what used to be a single script, called here in its original sequence.
 *  - `transport-and-transcript.test.mjs` — publish scope, run setup, transport
 *    security, transcript-to-markdown.
 *  - `login-and-settings.test.mjs` — the login, the credential at rest,
 *    merging into somebody else's settings file.
 *  - `clients-and-capture.test.mjs` — the three supported clients, the
 *    capture itself, refresh, and session-start orientation.
 *  - `state-and-scope.test.mjs` — the CSRF `state` defence and the scope a
 *    client declares when it registers.
 */

import { failures } from "./harness.mjs";
import { runSetupAndTransportChecks } from "./transport-and-transcript.test.mjs";
import { runLoginAndSettingsChecks } from "./login-and-settings.test.mjs";
import { runClientsAndCaptureChecks } from "./clients-and-capture.test.mjs";
import { runStateAndScopeChecks } from "./state-and-scope.test.mjs";

const ctx = {};
await runSetupAndTransportChecks(ctx);
await runLoginAndSettingsChecks(ctx);
await runClientsAndCaptureChecks(ctx);
await runStateAndScopeChecks(ctx);

ctx.server.close();
console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);

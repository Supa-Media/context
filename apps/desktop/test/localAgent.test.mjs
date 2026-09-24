/**
 * Driving the `claude` this machine already has, instead of spending a key.
 *
 * Three properties carry this file, and each is here because the cheaper
 * version of the code passes without it:
 *
 *  - **The token is never an argument.** `--mcp-config` accepts a JSON string,
 *    which is one line shorter and puts the grant in `ps` output.
 *  - **The working directory is ours.** Without `--bare` — which this must not
 *    pass, because bare mode does not read the subscription login — a `-p` run
 *    executes the hooks in whatever directory it starts in, with no trust
 *    prompt.
 *  - **The tool list is closed.** #713's finding, in the other harness: the
 *    key export answers `readOnlyHint: true` and must still never be offered.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing checks:
 *
 *   passing the config as a JSON string instead of a path                      2
 *   `--allowedTools` built from CONTEXT_TOOLS + the withheld names            10
 *   `scratchDir: ""` defaulting to "." instead of throwing                     1
 *   adding `--bare` to the argv                                                1
 *   `readLocalAnswer` trusting `result` when `is_error` is true                2
 *   a not-logged-in run answering the generic sentence                         1
 *   `localAgentFor` treating "" as present                                     1
 *
 * Two predictions were wrong and are corrected above rather than quietly
 * fixed. The JSON-string sabotage fails 2, not 1: the token check and the
 * "travels as a path" check are genuinely independent, and a version of this
 * file with only the first would pass while `--mcp-config` carried something
 * else entirely. The withheld-names sabotage fails 10 rather than 2, which is
 * the loop doing its job — each withheld name is its own named check, so the
 * failure says *which* tool got onto the list instead of that one did.
 *
 * The fourth is the one worth recording. `--bare` is what the headless docs
 * *recommend* for scripted calls, so the sabotage is the mistake a careful
 * reader makes on purpose — and it fails a check that names the reason rather
 * than an argv snapshot, so the next person to add it is told why not.
 *
 * The fifth was predicted to fail 1 and failed 2: an errored run whose result
 * happens to be empty also stops being read as `empty`, which is the right
 * answer and not the one the test was written for.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOWED_TOOLS,
  LOCAL_MESSAGES,
  MCP_SERVER_NAME,
  SCRATCH_PREFIX,
  WITHHELD_LOCALLY,
  abandonedRuns,
  askPlan,
  localAgentFor,
  mcpConfigFor,
  readLocalAnswer,
} from "../src/core/agent/localCli.ts";
import { sweepAbandonedRuns } from "../src/main/localAgent.ts";

const TOKEN = "fake-grant-token-not-a-real-one";
const ENDPOINT = "https://gateway.invalid/mcp";

const input = {
  question: "what did I decide about pricing?",
  configPath: "/ours/run-1/mcp.json",
  scratchDir: "/ours/run-1",
  appendSystemPrompt: "They are reading 1-projects/pricing.md.",
};

export async function runLocalAgentChecks(check) {
  // -- is there one at all ---------------------------------------------------
  {
    check(
      "a machine with claude installed has a local agent",
      localAgentFor({ claudePath: "/usr/local/bin/claude" }) === "claude",
    );
    check("a machine without it has none, and that is a state", localAgentFor({ claudePath: null }) === null);
    check("an empty path is not an install", localAgentFor({ claudePath: "" }) === null);
  }

  // -- the token is never in argv --------------------------------------------
  {
    const plan = askPlan("claude", "/usr/local/bin/claude", input);
    const carries = plan.args.some((arg) => arg.includes(TOKEN));
    check("no argument carries the grant token", carries === false);
    check("the config travels as a path", plan.args.includes(input.configPath));

    // The token really is in the document, so the check above is about where
    // it went rather than about it not existing.
    const config = JSON.stringify(mcpConfigFor(ENDPOINT, TOKEN));
    check("...and the document it points at does carry it", config.includes(TOKEN));
    check("...mounted under the name the tool list is built from", config.includes(`"${MCP_SERVER_NAME}"`));
  }

  // -- the working directory is a boundary -----------------------------------
  {
    const plan = askPlan("claude", "/usr/local/bin/claude", input);
    check("the run happens in the directory it was given", plan.cwd === "/ours/run-1");

    let threw = false;
    try {
      askPlan("claude", "/usr/local/bin/claude", { ...input, scratchDir: "" });
    } catch {
      threw = true;
    }
    check("no directory of ours is a refusal, never a default", threw);

    check(
      "never --bare: it does not read the subscription login, which is the whole point",
      plan.args.includes("--bare") === false,
    );
  }

  // -- the tool list is a closed gate ----------------------------------------
  {
    const plan = askPlan("claude", "/usr/local/bin/claude", input);
    const allowed = plan.args[plan.args.indexOf("--allowedTools") + 1];
    check("the gate is a flag the CLI enforces", typeof allowed === "string" && allowed.length > 0);

    for (const name of WITHHELD_LOCALLY) {
      check(`${name} is not offered`, allowed.includes(name) === false);
    }
    check("reading the context is", allowed.includes(`mcp__${MCP_SERVER_NAME}__read_note`));
    check("proposing a change is", allowed.includes(`mcp__${MCP_SERVER_NAME}__propose_note`));
    check(
      "every allowed name is one of this server's",
      ALLOWED_TOOLS.every((name) => name.startsWith(`mcp__${MCP_SERVER_NAME}__`)),
    );
    check("the loop is bounded", plan.args.includes("--max-turns"));
  }

  // -- reading what it printed -----------------------------------------------
  {
    const ok = readLocalAnswer(true, JSON.stringify({ result: "You chose usage-based.", is_error: false }));
    check("a good run answers", typeof ok === "object" && ok.answer === "You chose usage-based.");
    check("...named as the local runner", typeof ok === "object" && ok.provider === "claude-code");

    const notJson = readLocalAnswer(true, "claude: command produced nothing");
    check("output that is not JSON is not an answer", notJson === LOCAL_MESSAGES.empty);

    const failed = readLocalAnswer(false, JSON.stringify({ result: "something broke", is_error: true }));
    check("an errored run is never read as its result", failed === LOCAL_MESSAGES.failed);

    const loggedOut = readLocalAnswer(
      false,
      JSON.stringify({ result: "Invalid API key · Please run /login", is_error: true }),
    );
    check("a signed-out CLI says so, because that is fixable", loggedOut === LOCAL_MESSAGES.notLoggedIn);

    const blank = readLocalAnswer(true, JSON.stringify({ result: "   ", is_error: false }));
    check("a blank answer is not an answer", blank === LOCAL_MESSAGES.empty);
  }

  /*
    -- A RUN THAT NEVER CAME BACK DOES NOT LEAVE ITS GRANT BEHIND -------------

    `main/localAgent.ts` writes the bearer token for this context to a 0600 file
    so `--mcp-config` can be given a path rather than the JSON, and unlinks it
    in a `finally` — *"including when the run throws or times out, because a
    credential left on disk after a crash is the same credential whether or not
    the crash was our fault."*

    That sentence names a case the mechanism cannot reach. A `finally` runs on a
    throw and on a timeout; it does not run when the process is killed. A
    force-quit, a main-process crash or a machine losing power during a turn —
    up to three minutes of window — leaves `<userData>/context-agent-XXXX/mcp.json`
    holding a live grant, and nothing ever looked for one: `context-agent-`
    appeared in exactly one place in the tree, the `mkdtemp` that creates it.

    The temp file is a weaker store than the keychain the token normally lives
    in, which is the point of the keychain, so a leftover makes that weakening
    permanent.

    Two halves, for the reason the rest of this file splits: the name rule is
    pure and the removal is the filesystem's.
  */
  {
    check(
      "the scratch prefix is one constant, so the sweep and the mkdtemp cannot drift",
      typeof SCRATCH_PREFIX === "string" && SCRATCH_PREFIX.length > 0,
    );
    check(
      "a directory left by a run of ours is recognised by name",
      typeof abandonedRuns === "function" &&
        JSON.stringify(abandonedRuns([`${SCRATCH_PREFIX}a1b2`, "mirror", `${SCRATCH_PREFIX}c3`])) ===
          JSON.stringify([`${SCRATCH_PREFIX}a1b2`, `${SCRATCH_PREFIX}c3`]),
    );
    check(
      "...and nothing else under userData is, including a near miss",
      typeof abandonedRuns === "function" &&
        abandonedRuns(["mirror", "Cache", "settings.json", "context-agentless", ""]).length === 0,
    );
  }

  {
    const root = await mkdtemp(join(tmpdir(), "context-sweep-check-"));
    const abandoned = join(root, `${SCRATCH_PREFIX}crashed`);
    await mkdir(abandoned);
    /*
      The real shape, not a marker file: this is the document a killed run
      leaves, and it carries the grant. Asserting on the token rather than on
      the directory is what makes the check about the credential.
    */
    await writeFile(join(abandoned, "mcp.json"), JSON.stringify(mcpConfigFor(ENDPOINT, TOKEN)));
    const keep = join(root, "mirror");
    await mkdir(keep);
    await writeFile(join(keep, "index.json"), "{}");

    try {
      if (typeof sweepAbandonedRuns === "function") await sweepAbandonedRuns(root);
    } catch {
      // Reported by the checks below rather than by aborting the run: a suite
      // that dies names nothing, which is worse than a suite that fails.
    }

    check("a grant left behind by a killed run is gone", !existsSync(abandoned));
    check("...and the rest of userData is untouched", existsSync(join(keep, "index.json")));

    await rm(root, { recursive: true, force: true });
  }

  {
    /*
      AND SOMETHING CALLS IT.

      `main/index.ts` is Electron and this suite is not, so the sweep's one call
      site is in the half no check here can mount — which is precisely how a
      guard ends up existing and doing nothing. The lesson is one this review
      wrote down a week ago in the console: a check that mounts the thing cannot
      see the call site that does not mount it.

      So the source is read. Comments are stripped first rather than matched
      around: a guard that a sentence in a docblock can satisfy is a guard a
      deletion leaves green, and the sentence above this one names the function.
    */
    // The startup path is `main/startup.ts` now, called first thing in `main()`.
    const source = await readFile(new URL("../src/main/startup.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check(
      "the startup path calls the sweep, not merely imports it",
      /\bsweepAbandonedRuns\s*\(/.test(code),
    );
  }

  {
    // A root that is not there is the ordinary first launch, not a failure.
    let threw = false;
    try {
      if (typeof sweepAbandonedRuns === "function") {
        await sweepAbandonedRuns(join(tmpdir(), "context-sweep-absent-root-xyz"));
      }
    } catch {
      threw = true;
    }
    check("a userData that does not exist yet is not an error", threw === false);
  }
}

/**
 * Asking the coding CLI already logged in on this machine, instead of a key.
 *
 * The console's agent (`/agent`, `apps/mcp/src/agent/turn.js`) spends an API
 * key the customer pasted into Settings → Model. That works and it bills them
 * per call. Most people asking for this already pay Anthropic every month and
 * would rather that subscription answered — and the only way a third party may
 * reach it is the one Anthropic writes down:
 *
 *   > "Unless previously approved, Anthropic does not allow third party
 *   > developers to offer claude.ai login or rate limits for their products,
 *   > including agents built on the Claude Agent SDK."
 *   > — code.claude.com/docs/en/agent-sdk/quickstart
 *
 * We are not approved and this does not try to be. What it does instead is run
 * **the customer's own `claude`**, on their machine, under the login they made
 * themselves. We never see a token, never offer a login, and never hold a
 * credential of theirs — the CLI reads its own from its own keychain entry. The
 * subscription is spent by its owner, which is the only arrangement that needs
 * nobody's permission.
 *
 * That is also why this lives in the desktop app and can never move into the
 * gateway: a Cloudflare Worker has no `claude` to run and no keychain to read.
 *
 * ## Two things about `-p` that decide this whole file
 *
 * **1. `--bare` is the documented mode for scripts, and it is exactly wrong
 * here.** The headless docs: *"bare mode doesn't use your subscription
 * login"*, and *"In bare mode, Claude Code never reads OAuth credentials or
 * the system keychain."* Passing it would leave us asking for an
 * `ANTHROPIC_API_KEY` — the thing we came here to avoid. So this does not pass
 * it, deliberately, against the docs' own recommendation.
 *
 * **2. Not passing it means the working directory is executable input.** Same
 * page: *"a `-p` session runs the hooks in a project's `.claude/settings.json`
 * and connects the servers in its `.mcp.json`, even in a folder you've never
 * trusted. A `-p` session shows no workspace trust dialog and no per-server
 * approval prompt."*
 *
 * So the directory this runs in is a security boundary, and `askPlan` refuses
 * to build a command without one it was told is ours. Run it in the customer's
 * project and a `.claude/settings.json` that arrived with a cloned repository
 * executes its hooks, silently, because they asked their notes a question. The
 * caller passes a scratch directory under the app's own `userData`; `main/`
 * owns creating it and it holds nothing.
 *
 * ## The token is never an argument
 *
 * `--mcp-config` takes "file paths or JSON strings". The JSON string form is
 * one line shorter and it puts the gateway token in `argv`, where `ps` shows
 * it to every process on the machine and a crash reporter files it. So the
 * config is written to a file with mode `0600` and this passes the *path*.
 * `test/localAgent.test.mjs` plants a sentinel token and asserts no element of
 * `argv` contains it — the check that keeps the shorter version from coming
 * back as a cleanup.
 *
 * ## The tool list is a flag, not a sentence
 *
 * #713 landed the gateway's version of this lesson: its tool list was advice
 * in a prompt, and `export_encryption_keys` was on the menu — export, then
 * `propose_note`, and the key that opens every encrypted note in the context is
 * sitting in plaintext in the bucket beside the notes it opens. Here the gate
 * is `--allowedTools`, which is the CLI's own enforcement rather than ours, and
 * `-p` denies anything not on it because a print-mode run has nobody to ask.
 *
 * `ALLOWED_TOOLS` is therefore a **closed list of names**, not a filter over
 * what the server offers. The gateway can derive its list live from
 * `toolsForSession`; a CLI wants the names before the server has spoken. The
 * cost of that is real and worth stating: a tool added to the gateway is not
 * offered here until somebody adds it here too. That fails closed, which is the
 * right direction for a list whose job is to keep two specific tools off it.
 */

/**
 * What a per-run scratch directory is called, under the app's `userData`.
 *
 * One constant because two readers need it and they must not drift: `mkdtemp`
 * makes the name and the startup sweep recognises it. A sweep looking for a
 * prefix nothing creates is a guard that silently does nothing, which is the
 * worse half of that pair — it reports success while a grant sits on disk.
 */
export const SCRATCH_PREFIX = "context-agent-";

/**
 * Which entries under `userData` are runs that never finished.
 *
 * `main/localAgent.ts` unlinks its directory in a `finally`, which covers a
 * throw and a timeout and **cannot cover being killed** — a force-quit, a crash
 * in the main process, a machine losing power inside the three minutes a turn
 * may take. What is left is `mcp.json`, holding this context's bearer grant, in
 * a file rather than in the keychain the token normally lives in. That is the
 * weaker of the two stores by design, and a leftover makes the weakening
 * permanent.
 *
 * Pure, and exact rather than fuzzy: an entry *is* the prefix plus something,
 * or it is somebody else's. `context-agentless` is not one of ours, and neither
 * is the prefix on its own — this decides what gets deleted out of a directory
 * that also holds the mirror, the settings and the caches.
 */
export function abandonedRuns(entries: readonly string[]): string[] {
  return entries.filter(
    (entry) => entry.startsWith(SCRATCH_PREFIX) && entry.length > SCRATCH_PREFIX.length,
  );
}

/** Which CLI to drive, when one is present. */
export type LocalAgentKind = "claude";

/** What the main process found on this machine. */
export interface CliPresence {
  /** Absolute path to `claude`, or null when it is not installed. */
  claudePath: string | null;
}

/**
 * The CLI this build can drive, or `null`.
 *
 * `null` is a **state, not a failure**: a machine with no `claude` is the
 * ordinary case, and the console falls back to the gateway and the key. Nobody
 * is shown an error for not having installed a developer tool.
 *
 * Only Claude Code for now. `codex exec` would fit the same shape, but Codex
 * takes its MCP servers from a global `~/.codex/config.toml` rather than a
 * per-run flag, so pointing it at one context means writing into a file the
 * customer owns and shares with their other work. That is a different and
 * worse thing to do to somebody's machine, and it is not done here rather than
 * done badly.
 */
export function localAgentFor(presence: CliPresence): LocalAgentKind | null {
  return typeof presence.claudePath === "string" && presence.claudePath.length > 0
    ? "claude"
    : null;
}

/**
 * The MCP server name this build mounts the context under.
 *
 * It decides the tool names the CLI sees (`mcp__context__read_note`), so it is
 * a constant and `ALLOWED_TOOLS` is built from it — the two cannot drift into
 * an allow-list that matches nothing, which would be an agent with no tools
 * rather than a loud failure.
 */
export const MCP_SERVER_NAME = "context";

/** The context tools the local agent may call, by their bare names. */
const CONTEXT_TOOLS = [
  "orient",
  "search",
  "search_notes",
  "list_notes",
  "list_changes",
  "read_note",
  "list_meetings",
  "read_meeting",
  "list_contacts",
  "read_contact",
  "scope_info",
  // The one write, and it is a proposal: it lands in the review queue the
  // console already has and the person says yes. `turn.js` argues this at
  // length — an edit somebody did not read is a different product.
  "propose_note",
] as const;

/**
 * Tools that must never appear on the list above, named so a test can say so.
 *
 * `export_encryption_keys` answers `readOnlyHint: true` truthfully and is still
 * the most dangerous call in the set — see the header, and `turn.js`'s
 * `WITHHELD_FROM_AGENT`, which this mirrors. `rotate_encryption_keys` is named
 * for the same reason it is named there: a list of "the key tools" that omitted
 * one would read as a ruling that the other is fine to automate.
 */
export const WITHHELD_LOCALLY = Object.freeze([
  "export_encryption_keys",
  "rotate_encryption_keys",
  "write_note",
  "move_note",
  "move_notes",
  "move_folder",
  "archive_note",
  "set_visibility",
  "set_folder_visibility",
  "set_encryption",
]);

/** The `--allowedTools` value: the context's read tools and `propose_note`. */
export const ALLOWED_TOOLS: readonly string[] = Object.freeze(
  CONTEXT_TOOLS.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`),
);

/** How many agentic turns one question may take before the CLI gives up. */
const MAX_TURNS = 12;

export interface AskInput {
  /** The person's question. Passed as one argument, never through a shell. */
  question: string;
  /** Path to the MCP config written for this run. Never its contents. */
  configPath: string;
  /**
   * The directory the CLI runs in. **Ours, empty, and never the customer's
   * project** — see the header: without `--bare` this directory's hooks and
   * `.mcp.json` run with no trust prompt.
   */
  scratchDir: string;
  /** Extra guidance for this turn — where the person is, what note is open. */
  appendSystemPrompt: string;
}

export interface AskPlan {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * The exact command for one question.
 *
 * Every flag here is load-bearing:
 *
 *  - `-p` and `--output-format json` — one turn in, one object out.
 *  - `--mcp-config <path>` — the context, mounted; the path rather than the
 *    JSON, because the JSON holds the token. See the header.
 *  - `--allowedTools` — the gate. `-p` has nobody to ask, so a call that is not
 *    on this list is denied rather than queued.
 *  - `--max-turns` — a question that cannot be answered in a dozen steps is a
 *    question that should come back unanswered rather than spend somebody's
 *    month on a loop.
 *  - `--append-system-prompt` — added to Claude Code's own prompt rather than
 *    replacing it, because the CLI's prompt is what makes its MCP tool use good
 *    and we are a guest in it.
 *
 * And what is deliberately absent: `--bare`, `--permission-mode`, and
 * `--permission-prompts`. The first would cost us the subscription. The other
 * two are newer than the CLIs people have installed — `--permission-prompts`
 * is documented as v2.1.259 or later, and an unknown option is a hard failure
 * before the run starts, so a flag that makes an old CLI refuse to answer at
 * all is worse than the default it would have tightened. `-p` already denies
 * what is not allowed.
 */
export function askPlan(kind: LocalAgentKind, claudePath: string, input: AskInput): AskPlan {
  if (kind !== "claude") throw new Error("unsupported local agent");
  if (input.scratchDir.length === 0) {
    // Refusing rather than defaulting to `process.cwd()`: the default would be
    // whatever directory Electron happened to start in, which on a packaged
    // app is `/` and in development is the repository. Both are somebody's
    // files, and this flag set executes what it finds there.
    throw new Error("a local agent needs a working directory of ours");
  }
  return {
    command: claudePath,
    cwd: input.scratchDir,
    args: [
      "-p",
      input.question,
      "--output-format",
      "json",
      "--mcp-config",
      input.configPath,
      "--allowedTools",
      ALLOWED_TOOLS.join(","),
      "--max-turns",
      String(MAX_TURNS),
      "--append-system-prompt",
      input.appendSystemPrompt,
    ],
  };
}

/**
 * The `--mcp-config` document, as an object for the caller to serialize.
 *
 * One remote server: this person's own context, at the endpoint the desktop app
 * is already connected to, with the grant the main process holds. The CLI
 * reaches the same gateway, the same privacy engine and the same scope clamp
 * the console does — so "the agent can see my notes" means exactly what it
 * means everywhere else in this product, and a note held back by `privacy.md`
 * is held back from this too.
 */
export function mcpConfigFor(endpoint: string, token: string): object {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: endpoint,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

/** What a local turn produces, in the shape the panel already reads. */
export interface LocalAnswer {
  answer: string;
  provider: string;
  steps: { tool: string; ok: boolean }[];
}

/**
 * The sentences a person is shown when a local turn does not answer.
 *
 * Each names something they can act on, because unlike the gateway's refusals
 * these failures are on their own machine and they can fix every one.
 */
export const LOCAL_MESSAGES = Object.freeze({
  notLoggedIn:
    "Claude Code is installed but not signed in. Run `claude` once in a terminal and log in, then ask me again.",
  failed: "Claude Code could not answer that. Try again, or switch to your API key in Settings → Model.",
  empty: "Claude Code finished without an answer. Try asking again.",
});

/**
 * Read what the CLI printed.
 *
 * Returns the answer, or a sentence. Throws nothing: a caller here is a panel
 * with somebody waiting at it, and every outcome has to be something to read.
 *
 * `is_error: true` with a `result` string is the documented shape for a failure
 * *inside* the run — the headless docs: *"When a failure happens inside the
 * run, such as missing authentication, Claude Code prints the failure as the
 * result on stdout."* The commonest one by far is a CLI that was never logged
 * in, and it is worth its own sentence because "sign in once" is a thing a
 * person can do, while the generic sentence sends them to Settings to paste a
 * key they came here to avoid needing.
 */
export function readLocalAnswer(exitOk: boolean, stdout: string): LocalAnswer | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return exitOk ? LOCAL_MESSAGES.empty : LOCAL_MESSAGES.failed;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return LOCAL_MESSAGES.failed;
  }

  const body = parsed as { result?: unknown; is_error?: unknown };
  const result = typeof body.result === "string" ? body.result : "";

  if (body.is_error === true || !exitOk) {
    return /not logged in|\/login|authentication|log in/i.test(result)
      ? LOCAL_MESSAGES.notLoggedIn
      : LOCAL_MESSAGES.failed;
  }
  if (result.trim().length === 0) return LOCAL_MESSAGES.empty;

  return { answer: result, provider: "claude-code", steps: [] };
}

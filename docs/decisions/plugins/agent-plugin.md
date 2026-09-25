# Plugins: the Context agent plugin and its installer

## The agent plugin: one folder, three manifests, and an installer that asks each agent what it can do

A third meaning of "plugin", and a different direction from the two above:
not code that runs inside Context, but Context packaged to run inside
somebody's coding agent. `plugins/context/` is at once the `context` plugin
and the `@supa-media/context` npm package that installs it (decided with a
maintainer, 2026-09-23).

**One folder, because the hooks have to run the package's own code.** Claude
Code gives SessionEnd hooks 1.5 seconds in total and a plugin cannot raise it;
Codex allows at most 3. `npx` does not start in that time, so the hooks run
`node` on the installed plugin's files, and `hooks/capture.mjs` hands the
session to a detached worker and exits. The worker writes its outcome, never
the transcript, to `~/.context/last-capture.json` for `status`.

**Three manifests over one set of files**, because the ecosystem split:
`.claude-plugin/` for Claude Code (and VS Code, which detects it), Agent
Plugins 1.0 `plugin.json` + `mcp.json` for Codex, Cursor and VS Code, and
`gemini/` for Gemini CLI, which the installer stages into a folder of its own:
Gemini installs from GitHub only with the manifest at the repository root,
and its hooks file has another shape.

**The installer asks each agent what it can do.** A plugin where the agent's
CLI can install one (Claude Code; Gemini CLI; Codex where `codex plugin`
exists); otherwise an MCP entry written by `add-mcp` and the skills copied to
`.agents/skills`, with no hooks, because those agents have no plugin runtime
to run them from. Every install is recorded and `uninstall` reverses the
record, nothing more.

**One MCP server at the root URL; the folder's workspace travels as a hint.**
A project binds to a workspace with `.context.json` (committed by default;
`--private` keeps it out of git). Plugin agents keep the root URL, and session
start tells the agent to pass `context: "@slug"`, because a second,
slug-specific server would give Claude Code two copies of every tool and a
second sign-in. MCP-only agents get the `/@slug/mcp` URL at project scope,
since nothing else can carry it there. **Cost accepted:** an agent that leaves
the argument out acts on the default workspace.

**A committed file cannot move the credential.** `.context.json` may set
`workspace`, `capture` and `captureTo`, never `endpoint`, and a file in or
above the home folder is never read: it is written by whoever can commit to
the repository, and the endpoint is where this machine's token is sent.

**`login` asks for private, and the approval page decides.** A person's own
notes are private by default, so a sign-in without `context:private` reaches
almost nothing in their own workspace: the first live run against staging
found `orient` returning no front page and search finding none of the
persona's notes. The gateway already grants private only to owners and the
approval page already lets the person choose team only, so asking is not
widening anything they did not approve. The cost is real and accepted: the
credential the hooks use unattended can read the owner's private notes. (The
old hook-only install, and its capture-only grant, are unchanged.) `use @slug`
picks the default workspace for commands, as `vercel switch` does; one command
names another with the tools' own `--context`, so there is no `--workspace`
flag.

**Captures go to the personal inbox unless someone chose otherwise**
(`captureTo: "workspace"`). A session transcript is its author's, and the
gateway files a capture in whichever workspace the URL names.

**Two dependencies, and only `install` loads them.** `add-mcp` writes other
agents' MCP entries; `@clack/prompts` draws the setup wizard (decided with a
maintainer, 2026-09-23, over a numbered-list prompt on Node's readline: the
wizard is the first thing every user sees, and arrow-key menus are what
`npx skills` and similar installers have taught people to expect). Both are
pinned exactly and imported dynamically, from `src/installer.js` and
`src/prompt.js` respectively, and never by the hooks or the credential code.
A runtime dependency rather than a bundled one, because the package has no
build step and adding one for a menu library is the larger change. `cli.yml`
fails any other dependency or a loose pin; `check-gateway-imports.mjs
--allow-import` fails an import of either from any other file.

**The wizard asks everything, then acts.** Running the package with no
command at a terminal starts it (piped or in CI it prints help, so nothing
waits on input). Each flag answers one question and `-y` answers them all.
Nothing is written, linked or installed until the summary is confirmed, so
Ctrl-C or "no" leaves the machine as it was. Test: `installer.test.mjs`,
"answering no at the confirmation changes nothing"; moving the folder link
ahead of the confirmation fails it.

**What a "simplification" would cost.** Hooks through `npx` are cancelled
before they save. Letting the project file set the endpoint hands a
repository's committers this machine's token. A second MCP server per
workspace doubles every tool in Claude Code. Reading `hook.json`'s refresh
token would put two clients on one rotating token, which the gateway treats
as a replay and answers by revoking the grant.

**The tests that fail if it is reversed:** `plugins/context/test/plugin.test.mjs`
("the session-end hook exits 0 well inside the budget", against a gateway
slower than the budget), `settings.test.mjs` ("A COMMITTED PROJECT FILE CANNOT
CHOOSE THE SERVER A CREDENTIAL IS SENT TO", "a .context.json in the home folder
or above it is never read"), `cli.test.mjs` ("in a project bound to a shared
workspace, a capture still goes to the personal inbox", "two parallel refreshes
both succeed with one usable token") and `installer.test.mjs` ("installer.js is
the only file that loads add-mcp").

# @supa-media/context

Your [Context](https://context.lc) in every coding agent you use, and your notes
from the terminal. One command:

```sh
npx -y @supa-media/context
```

It signs you in once in your browser, then asks four questions with arrow-key
menus (where to install, which workspace a project belongs to, which of the
coding agents it found, and whether to save sessions to your inbox), shows a
summary, and changes nothing until you confirm. Each flag on `install`
answers one question (`--scope`, `--workspace`, `--agent`), and `-y` takes
every default without asking, for scripts and CI. It adds Context to each
agent like this:

- **Claude Code** and **Gemini CLI**, and **Codex** where its `plugin` command
  exists: the `context` plugin, which brings the MCP server, two skills, and two
  session hooks.
- **Cursor, OpenCode, VS Code, Windsurf, Copilot CLI**, and Codex or Gemini
  without that command: the MCP server and the skills. Those agents have no
  plugin runtime, so no hooks.

This folder is both that plugin and this npm package.

## What the plugin does in a session

- **The skills** tell the agent when to read your notes (`orient` first) and
  how to write back (`write_note`, `save_context`), and give it a
  `context-save` command.
- **Session start** tells the agent your notes exist and to call `orient`
  before answering. With `orient` set to `live` it injects the orientation
  itself. In a folder bound to a workspace, it also says which one to pass.
- **Session end** saves the session to your Context inbox. It hands the work to
  a background process and returns at once, because Claude Code gives these
  hooks 1.5 seconds in total and Codex at most 3.

Capture is on by default. Turn it off everywhere with
`npx @supa-media/context config set capture off`, in one project with
`"capture": "off"` in its `.context.json`, or for a folder tree with
`config set captureExclude ~/work/client`.

## Why this exists

A connected client can call `save_context` when it finishes. Sometimes it does.
The failure is not that agents refuse — it is that a long session ends without
one, and the thing worth keeping was in the part nobody wrote down. This is the
safety net for that, and it does not depend on the agent choosing to cooperate.

It is not a replacement for `save_context`. An agent that files its own
decisions into the right project folder produces something far better than a
transcript in an inbox. This catches the sessions where that did not happen.

## What it sends, and what it does not

**User-visible user and assistant messages. Nothing else.**

A session log on disk holds much more than the conversation: the system prompt,
the model's own reasoning, every tool call and its full result, the contents of
files read along the way, whatever was in the environment when a command ran.
None of that is sent. The rule is an allow-list — a message travels only if its
role is `user` or `assistant` and its content block is declared `text` — rather
than a filter that strips things that look sensitive, because that kind of
filter fails silently and only in the direction that matters.

That is deliberately lossy. A session whose substance was all tool output comes
out thin, and thin is the right failure.

## Scopes and workspaces

```sh
npx -y @supa-media/context install                          # every folder (user scope)
npx -y @supa-media/context install --scope project          # this folder, shared with the team
npx -y @supa-media/context install --scope local            # this folder, only for you
npx -y @supa-media/context install --agent claude-code,cursor --workspace @team -y
```

A project or local install binds the folder to a workspace in `.context.json`
(`link @slug` and `unlink` do the same on their own). Project scope commits
that file so the team shares it; local scope keeps it out of git through
`.git/info/exclude`. The file may set `workspace`, `capture` and `captureTo`.
It may never set the server: it is written by whoever can commit to the
repository, and the server is where your sign-in is sent.

Captures go to your **personal** workspace's inbox even in a project bound to
a shared one, unless you set `captureTo` to `workspace`.

## Settings

`npx @supa-media/context config list` shows every setting and the layer that set
it: a flag, the environment (`CONTEXT_ENDPOINT`, `CONTEXT_WORKSPACE`,
`CONTEXT_CAPTURE`), the nearest `.context.json`, `~/.context/config.json`, or the
default.

| Setting | Default | |
|---|---|---|
| `endpoint` | `https://mcp.context.lc/mcp` | your own gateway if you self-host |
| `workspace` | the sign-in's default | usually set per folder |
| `capture` | `on` | save sessions at their end |
| `captureExclude` | none | folders never captured |
| `captureTo` | `personal` | or `workspace` |
| `orient` | `instruction` | or `live` |

## Your notes from the terminal

Every tool your sign-in can use is a command, read from the server's own list:

```sh
npx @supa-media/context tools
npx @supa-media/context search-notes --query pricing
npx @supa-media/context read-note --path 1-projects/launch.md
npx @supa-media/context search-notes --help
```

## What your sign-in can do

`login` asks for read, write and your private notes, because a person's own
notes are private by default. The approval page lets you grant team notes
only instead, and private is only ever granted where you are the owner:
another owner's private notes stay out of reach. It appears in
Connections in the Context console as `Context CLI (<your hostname>)` and is
revoked there on its own.

The credential lives in `~/.context/credentials.json`, created `0600` inside a
`0700` directory and written atomically. It is never printed, never passed on a
command line, and never written into an agent's settings. Refreshes happen one
at a time, so two sessions closing together cannot spend one rotating refresh
token twice.

## Commands

```sh
npx -y @supa-media/context install      # sign in, then add Context to your agents
npx -y @supa-media/context uninstall    # remove exactly what install added
npx -y @supa-media/context status       # sign-in, workspace, capture, installs, last capture
npx -y @supa-media/context login        # sign in again
npx -y @supa-media/context use @slug    # the workspace commands act on by default
npx -y @supa-media/context logout       # delete this machine's stored sign-in
```

`--endpoint <url>` points any of them at your own gateway.

## Moving from `@supa-media/context-hook`

This package replaces it. `install` removes the hooks the old package wrote into
`~/.claude/settings.json`, `~/.codex/hooks.json` and `~/.gemini/settings.json`,
so sessions are not saved twice. Its `~/.context/hook.json` is not read: sign in
once with `login` (or `install`).

## Dependencies

Two, each pinned to an exact version: `add-mcp`, which writes the MCP entry
into the config files of agents with no plugin system (Cursor, OpenCode, VS
Code, Windsurf, Copilot CLI), and `@clack/prompts`, which draws the setup
wizard's menus. Everything else is Node built-ins.

`add-mcp` is loaded only by `src/installer.js` and `@clack/prompts` only by
`src/prompt.js`, and only when `install` or `uninstall` runs. The session hooks
and the code that holds your credential load neither, so no third-party code
runs while a token or a transcript is in hand. CI fails a pull request that
adds any other dependency, loosens a pin, or imports either from any other
file.

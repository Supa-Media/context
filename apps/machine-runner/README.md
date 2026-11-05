# context-machine

The runner that lets Tex run jobs on a person's own computer, with the
`claude` and `codex` CLIs they are already signed in to, inside the folders
and limits they set. One Rust binary for headless Linux and macOS; the Mac app
ships the same binary inside it.

It only dials out: one WebSocket to the workspace object, nothing listening on
the machine. The protocol is `packages/shared/src/machineProtocol.schema.json`,
and `src/protocol.rs` mirrors it field for field (a test round-trips every
example in `machineProtocol.examples.json`).

## Install

```sh
npx @supa-media/context machine          # downloads the binary for this machine
# or
curl -fsSL https://raw.githubusercontent.com/Supa-Media/context/main/apps/machine-runner/install.sh | sh
```

Then:

```sh
context-machine pair                 # prints a link and a code; approve it in Context
context-machine service install      # systemd --user or launchd, starts at login
context-machine status
```

### Updates

A runner put in place by `install.sh` keeps itself up to date: five minutes
after it starts and then every six hours it looks for a newer
`machine-runner-v<x.y.z>` release, checks the download against its `.sha256`,
swaps the binary in, and once no job or install is under way restarts into it
with the same arguments. The Mac app's runner never does (the app updates as a
whole). `CONTEXT_MACHINE_AUTO_UPDATE=off` turns it off; `context-machine update`
does it at once.

## Commands

| Command | What it does |
| --- | --- |
| `pair [--endpoint URL] [--name NAME]` | Pairs with a short code. Every poll is signed with the machine key. |
| `run` | Connects and takes jobs in the foreground. |
| `status [--json]` | Pairing, tools, slots, today's and this week's use. |
| `service install\|uninstall`, `stop` | The background service. |
| `update` | Updates to the newest release now and restarts the background service onto it. |
| `forget` | Removes the service, the key, the grant and every run's files. |
| `key [--json]` | Prints the public key (made on first use); with `--json`, `{publicKey, facts}`. |
| `hook <event>` | What Claude Code's hooks run: joins as a mail-only device and shows its mail to the session. Always exits 0. |
| `join` | Joins as a mail-only device in the background; prints the code the session approves with `manage pair_device`. |
| `mail wait [--timeout S]`, `mail read` | Ends the moment mail arrives (exit 3 on timeout); prints unread mail. |

### A Claude Code cloud session as a mail-only device

In this repository, `.claude/settings.json` runs `scripts/context-machine-hook.sh`
on SessionStart, UserPromptSubmit, PostToolUse, Stop and SessionEnd, only in
Claude Code on the web (`CLAUDE_CODE_REMOTE=true`). It installs the runner if it
is missing, and the session approves the printed code with its own Context
connection (`manage pair_device`). The device takes note mail and never jobs, and
leaves when the session ends. `CONTEXT_MACHINE_HOOKS=off` turns it off. See
`docs/decisions/texting-assistant/machines.md`, "A cloud VM as a mail-only device".

`--dir` (alias `--data-dir`) moves the runner's own folder from
`~/.context-machine`; so does `CONTEXT_MACHINE_DIR`.

### For the Mac app

The app pairs itself, then starts:

```sh
context-machine key --data-dir DIR --json
context-machine run --data-dir DIR --grant-file FILE --socket-url wss://… \
  --machine-id ID --status-json --no-keep-awake
```

The grant file must be mode 0600. With `--status-json`, stdout carries one
JSON line per change: `state` is `starting`, `online`, `offline`, `paused`,
`notReady` or `failed`, with `busy`, `slots`, `recommended`, `most`,
`notReady`, `pausedUntil` and `freeMemoryMb` (`failed` carries `error`).
SIGTERM exits 0. A `goodbye` exits non-zero; `revoked` also deletes the grant.

Release assets: `context-machine-<target>.tar.gz` with a `.sha256`, for
`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`,
`x86_64-apple-darwin` and `aarch64-apple-darwin`, from the
`Release machine runner` workflow (tag `machine-runner-v<version>`).

## What the machine enforces itself

The gateway checks the rules too, but the runner never trusts it to: every
`assign` is checked locally first and refused with a schema refusal code.

- **Folders.** A run starts only under an allowed folder, compared after
  resolving symlinks and `..`; never `/` or a home folder itself. Inside it a
  run is plain Claude Code or Codex (owner, 2026-11-04): it starts in the
  checkout the job names when that is under the folder, or in the folder
  itself, told to clone the repo, when it is not. Nothing is copied, no branch
  is made, and nothing is removed when the part ends.
- **Limits.** Agent time per day and week, others' share and runs per day,
  the longest run, an optional weekly token ceiling, slots (one kept for the
  owner if asked), free memory of at least 1 GB, and a pause while a plan is
  at 95% or rejected, until it resets. Days are the owner's time zone.
- **Owner only.** Computer use. Full permission and the folder's own
  `.claude` settings, hooks and MCP servers are every run's, the owner's and
  anyone's they let in: who may send work is the control.
- **Credentials.** The machine key and grant are 0600 files in a 0700 folder.
  A run's grant goes into a 0600 file (Claude's `--mcp-config`, or the
  `mcp-proxy` Codex starts), never argv, the environment or a log, and is
  deleted when the part ends; any left by a crash are swept at start.

`~/.context-machine/local.json` can only narrow what Context allows:

```json
{ "folders": ["/home/me/code"], "tools": ["claude"], "maxSlots": 1,
  "dayMs": 3600000, "ownerOnly": true, "allowedCommands": ["git", "cargo"] }
```

## How it runs the CLIs

- **Claude Code**: `-p --input-format stream-json --output-format stream-json
  --verbose --strict-mcp-config --mcp-config FILE`, with a session id the
  runner chooses (`--session-id`, or `--resume` for a later part or after a
  restart). Permission `read` allows only Read, Glob and Grep; `edits` uses
  `acceptEdits` plus `Bash(<cmd>:*)` for the allowed commands; `full` is
  `bypassPermissions`. With network off, a sandbox settings file (bubblewrap
  on Linux; a no-network run refuses to start without it). Mail and
  interrupts go into the same stdin session.
- **Codex**: `codex exec [resume ID] --json --skip-git-repo-check --cd DIR`
  with `--sandbox read-only|workspace-write` and the network setting, one
  process per turn.

Each run's process group is killed on cancel, deadline or exit.

## Spikes and checks

- Claude Code headless: about 210 MB per session; stream-json gives the
  session id, each tool call, token usage and rate-limit events (status,
  window, utilization, reset time), which drive the plan pause.
- A dropped socket does not stop a run: the next hello lists it with its
  session and last step, and the workspace object's `welcome.keepRuns` says
  which to keep. Results are kept on disk and sent again until no longer
  wanted.
- Sabotage-tested: weakening the folder check, the secret guard, owner-only
  computer use, the day limit, the command-name check, the hello signature or
  a schema field name each fails its test.

```sh
cargo test                                               # unit + end-to-end with a fake CLI
cargo test --test e2e live_claude -- --ignored --nocapture   # with the real, signed-in claude
```

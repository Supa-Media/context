#!/usr/bin/env node
/**
 * `npx @supa-media/context <command>`.
 *
 * A thin shell: parse, dispatch, and turn a thrown error into one line a person
 * can act on. Everything with a decision in it lives in `src/commands.js`, so
 * the tests drive the real code rather than a process.
 */

import * as commands from "../src/commands.js";

const DEFAULT_ENDPOINT = "https://mcp.context.lc/mcp";

const USAGE = `Context in your coding agents, and your notes from the terminal.

  npx @supa-media/context install            sign in, then add Context to your coding agents
      --scope user|project|local             every folder (default), this folder shared
                                             with the team, or this folder only for you
      --agent claude-code,cursor             only these agents (default: every one found)
      --workspace @slug                      the workspace this folder belongs to
      -y                                     do not ask; take the defaults
  npx @supa-media/context uninstall          remove what install added (--agent to narrow)
  npx @supa-media/context status             sign-in, workspace, capture, installs
  npx @supa-media/context login              sign in (read and write; never private notes)
  npx @supa-media/context logout             delete this machine's stored sign-in
  npx @supa-media/context link @workspace    bind this folder to a workspace (.context.json)
      --private                              ...and keep that file out of git
  npx @supa-media/context unlink             remove this folder's binding
  npx @supa-media/context config list        every setting and where it came from
  npx @supa-media/context config set <key> <value>   (empty value unsets)

Options
  --endpoint <url>   your MCP endpoint (default ${DEFAULT_ENDPOINT})

Settings: endpoint, workspace, capture (on|off), captureExclude (comma-separated
folders), captureTo (personal|workspace), orient (instruction|live).
When a session ends it is saved to your Context inbox; turn that off with
"config set capture off".`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "-y" || token === "--yes") args.yes = true;
    else if (token.startsWith("--")) {
      const [flag, inline] = token.slice(2).split("=");
      if (inline !== undefined) args[flag] = inline;
      // A bare flag must not eat the next argument: `--orient --endpoint x`
      // set orient to "--endpoint" and left the endpoint at its default, which
      // is a silently wrong install rather than an error.
      else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) args[flag] = argv[++index];
      else args[flag] = true;
    } else args._.push(token);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    console.log(USAGE);
    return 0;
  }

  const options = {
    endpoint: args.endpoint || process.env.CONTEXT_ENDPOINT || DEFAULT_ENDPOINT,
    client: args.client || "claude-code",
    orient: args.orient === true || args.orient === "true",
  };

  switch (command) {
    case "login":
      await commands.login({ endpoint: args.endpoint });
      return 0;
    case "logout":
      await commands.logout({ endpoint: args.endpoint });
      return 0;
    case "link":
      await commands.link({ workspace: args._[1], private: args.private === true, endpoint: args.endpoint });
      return 0;
    case "unlink":
      await commands.unlink({});
      return 0;
    case "config":
      await commands.config({ action: args._[1] || "list", key: args._[2], value: args._[3] });
      return 0;
    case "install":
      await commands.install({
        scope: typeof args.scope === "string" ? args.scope : "user",
        agents: typeof args.agent === "string" ? args.agent.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
        yes: args.yes === true,
        workspace: typeof args.workspace === "string" ? args.workspace : undefined,
        source: typeof args.source === "string" ? args.source : undefined,
        endpoint: args.endpoint,
      });
      return 0;
    case "status":
      await commands.status({ endpoint: args.endpoint });
      return 0;
    case "uninstall":
      await commands.uninstall({
        agents: typeof args.agent === "string" ? args.agent.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
      });
      return 0;
    case "session-start": {
      // Same rule as capture, more so: this runs before the person has typed
      // anything. `sessionStart` already falls back to the directive on every
      // failure, so this catch is the floor under the floor.
      await commands.sessionStart(options).catch(() => {});
      return 0;
    }
    case "capture": {
      // Never non-zero. A failing SessionEnd hook is noise at the end of
      // somebody's work, and this is a safety net rather than the main path —
      // the agent's own `save_context` is. It says what happened and stops.
      await commands.capture(options).catch((error) => {
        console.log(`context: ${error.message}`);
      });
      return 0;
    }
    default:
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`context: ${error.message}`);
    process.exit(1);
  });

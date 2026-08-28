#!/usr/bin/env node
/**
 * `npx @context-lc/hook <command>`.
 *
 * A thin shell: parse, dispatch, and turn a thrown error into one line a person
 * can act on. Everything with a decision in it lives in `src/commands.js`, so
 * the tests drive the real code rather than a process.
 */

import { capture, install, status, uninstall } from "../src/commands.js";
import { CLIENTS } from "../src/install.js";

const DEFAULT_ENDPOINT = "https://mcp.context.lc/mcp";

const USAGE = `Save what an AI coding session learned into your Context.

  npx @context-lc/hook install      sign in, then add the hook to your client
  npx @context-lc/hook status       show whether this machine is signed in
  npx @context-lc/hook uninstall    remove the hook and forget the credential
  npx @context-lc/hook capture      run by the hook itself; reads stdin

Options
  --endpoint <url>   your MCP endpoint (default ${DEFAULT_ENDPOINT})
  --client <id>      ${Object.keys(CLIENTS).join(", ")} (default claude-code)

The hook asks for capture access only: it can add to your inbox and cannot
read a single note. Revoke it from Connections in the Context console.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token.startsWith("--")) {
      const [flag, inline] = token.slice(2).split("=");
      args[flag] = inline ?? argv[++index] ?? "";
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
  };

  switch (command) {
    case "install":
      await install(options);
      return 0;
    case "status":
      await status(options);
      return 0;
    case "uninstall":
      await uninstall(options);
      return 0;
    case "capture": {
      // Never non-zero. A failing SessionEnd hook is noise at the end of
      // somebody's work, and this is a safety net rather than the main path —
      // the agent's own `save_context` is. It says what happened and stops.
      await capture(options).catch((error) => {
        console.log(`context-hook: ${error.message}`);
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
    console.error(`context-hook: ${error.message}`);
    process.exit(1);
  });

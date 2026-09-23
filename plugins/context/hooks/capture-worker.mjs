#!/usr/bin/env node
/**
 * The detached half of the SessionEnd hook: filter the transcript and post it.
 *
 * Nobody is watching this process, so its outcome goes to
 * `~/.context/last-capture.json` for `status` to show. That file holds what
 * happened (saved or not, why, how many messages), never the transcript.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { capture } from "../src/commands.js";
import { writeConfig } from "../src/config.js";

const client = process.env.CONTEXT_CAPTURE_CLIENT || "claude-code";
const payload = process.env.CONTEXT_CAPTURE_PAYLOAD || "";
const said = [];
let outcome;
try {
  outcome = await capture({ client, stdin: [payload], log: (line) => said.push(String(line)) });
} catch (error) {
  outcome = { saved: false, reason: "error", error: error.message };
}
await writeConfig(
  {
    at: new Date().toISOString(),
    client,
    saved: outcome?.saved === true,
    reason: outcome?.reason || null,
    messages: outcome?.messages || 0,
    error: outcome?.error || null,
    said: said.slice(-3),
  },
  join(process.env.HOME || homedir(), ".context", "last-capture.json")
).catch(() => {});
process.exit(0);

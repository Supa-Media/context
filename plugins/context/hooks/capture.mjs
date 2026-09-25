#!/usr/bin/env node
/**
 * SessionEnd hook: hand the session to a background worker and exit at once.
 *
 * Claude Code gives every SessionEnd hook 1.5 seconds between them, and a
 * plugin's hooks cannot ask for more; Codex allows at most 3. Reading a long
 * transcript, refreshing a token and posting it does not fit, and a hook that
 * is cancelled halfway saves nothing. So this reads the small payload the
 * agent sends on stdin (the transcript's PATH, not the transcript), starts a
 * detached worker with it, and returns.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hookClient } from "../src/hookClient.js";

const STDIN_CAP_MS = 500;

async function readStdin() {
  const chunks = [];
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, STDIN_CAP_MS);
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return Buffer.concat(chunks).toString("utf8").trim();
}

try {
  const payload = await readStdin();
  if (payload) {
    const worker = fileURLToPath(new URL("./capture-worker.mjs", import.meta.url));
    spawn(process.execPath, [worker], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, CONTEXT_CAPTURE_PAYLOAD: payload, CONTEXT_CAPTURE_CLIENT: hookClient() },
    }).unref();
  }
} catch {
  // Never fail a session's end. The worker's outcome is in last-capture.json.
}
process.exit(0);

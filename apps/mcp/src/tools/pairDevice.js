/**
 * `pair_device` (`manage` action `pair_device`): a Claude Code or Codex
 * session approves the pairing code its own computer's runner is showing, from
 * the Context connection it already has (decided by the owner, 2026-11-04:
 * "we can have them pair using the mcp somehow because my claude and codex vms
 * would already be connected to the MCP";
 * docs/decisions/texting-assistant/machines.md).
 *
 * Nothing is decided here. The control plane (`/gateway/machines/pair/approve-grant`,
 * through `store.pairDevice`, attached in `http/routing.js`) approves the
 * code as this connection's own person, into its own workspace, under the
 * same role rule the app's approval uses, and always as a mail-only device
 * tied to this connection: it shows up in the workspace's devices and gets
 * mail at once, never takes a job, and goes when this connection is revoked.
 * This turns the answer into a sentence the agent can act on.
 */

import { toolError, toolText } from "./results.js";

const REFUSALS = {
  PAIRING_NOT_FOUND:
    "Not paired: no computer is showing that code now. Run `context-machine hook session-start` (or `context-machine join`) on this computer and pass the code it prints.",
  PAIRING_EXPIRED: "Not paired: that code ran out. Start pairing again on this computer and pass the new code.",
  INSUFFICIENT_ROLE: "Not paired: only an owner, or an editor of a shared workspace, can add a computer to it.",
  RATE_LIMITED: "Not paired: too many codes tried just now. Wait ten minutes and try again.",
};

const UNAVAILABLE = "Not paired: computers can't be paired through Context on this deployment.";

export async function toolPairDevice(store, args) {
  const code = typeof args?.code === "string" ? args.code.trim() : "";
  if (!/^[A-Za-z0-9]{3}-?[A-Za-z0-9]{3}$/.test(code)) return toolError('code is the six characters the computer printed, like "KQ7-4MP"');
  if (typeof store?.pairDevice !== "function") return toolError(UNAVAILABLE);
  let answer;
  try {
    answer = await store.pairDevice(code);
  } catch {
    return toolError("Not paired: the request could not be sent just now. Try again in a moment.");
  }
  if (answer?.approved) {
    const { name, os } = answer.approved;
    return toolText(
      `Paired: ${name} (${os}) is now one of this person's devices, mail only. It never takes Tex's jobs, and it leaves ` +
        "when this session ends, after 15 minutes offline, after a day, or when this connection is revoked. Its runner " +
        "connects within a few seconds; `context-machine status --json` then names its device id. To get note mail here " +
        'at once, join a note\'s mail with write action mail, args { join: "<name>", device: "<device id>" }, and keep ' +
        "`context-machine mail wait` running in the background: it ends the moment mail arrives.",
    );
  }
  const refusal = REFUSALS[answer?.refused];
  return toolError(refusal ?? "Not paired: this connection can't add a computer to this workspace.");
}

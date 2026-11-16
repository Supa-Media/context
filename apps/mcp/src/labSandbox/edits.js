/**
 * A LAB TEST CHAT'S EDITS AND UNSENDS, AS PRODUCTION TAKES THEM (Dev2, 2026-11-16: "not just edits but deleted messages
 * as well"; decisions `docs/decisions/texting-assistant/edits-and-unsends.md` and `lab-sandbox.md`).
 *
 * Production: Photon's `message.edited` / `message.unsent` reach the texting Worker's chat object, which asks node
 * `edit` ("A text is edited or unsent", `graph/nodes/edit.js`, over `/texts/edit`) what happened, then keeps the event
 * beside the text it changes (`edited: true` or `unsent: true`, `replyTo` and `quoted`) and, for `turn`, queues it like
 * a text (`apps/agent/src/editStep.ts`, `chatObject.ts` `takeEdit`). Here the same node runs on the gateway's graph with
 * the test chat's draft, its run written to the test chat's ledger beside the event, and the route (`route.js`) runs the
 * turn for `turn`, keeps an unsend as a quiet noted row (no turn), and changes nothing for `same`.
 */

import { gatewayGraph } from "../agent/graph/gatewayGraph.js";
import { nodeEntry } from "../agent/ledger.js";
import { TEX_CONFIG, withDraft } from "../agent/texConfig.js";

/** What a noted unsend's quiet row says: production runs no turn for it (`chatObject.ts` `takeEdit`). */
export const UNSENT_NOTE = "Taken back, not answered: production keeps an unsend beside the text and runs no turn; a turn not yet started on that text is dropped.";

/** The words a text says now: its latest edit's, else its own (the earlier words production's edit is compared with). */
export function wordsNow(rows, row) {
  let words = String(row.text ?? "");
  for (const r of rows ?? []) if (r.kind === "edit" && r.on === row.id && typeof r.text === "string") words = r.text;
  return words;
}

/**
 * Runs node `edit` for one test edit or unsend, on main's config or the draft's (`config`, `withDraft`). Answers
 * `{ to, why, entries }`: the node's output and its run as ledger entries for the test row. A node turned off or a run
 * that fails answers as `/texts/edit` does: an edit goes on as a text, an unsend is taken back.
 */
export async function runEditNode({ config = null, kind, change, words, earlier, turn = null }) {
  const runs = [];
  const graph = gatewayGraph({ config: config ? withDraft(TEX_CONFIG, config) : TEX_CONFIG, log: (run) => void runs.push(run) });
  const input = { kind, change, ...(typeof words === "string" ? { words } : {}), ...(typeof earlier === "string" ? { earlier } : {}) };
  const fallback = change === "unsend" ? "withdraw" : "turn";
  let output;
  try {
    const run = await graph.runNode("edit", input, {}, "labSandbox");
    output = run.ran ? run.output : { to: fallback, why: "the edit step is off" };
  } catch {
    output = { to: fallback, why: "the edit step failed" };
  }
  const at = Date.now();
  const entries = runs.map((run) => nodeEntry(run, { turn, at })).filter(Boolean);
  return { to: output.to, why: output.why, entries };
}

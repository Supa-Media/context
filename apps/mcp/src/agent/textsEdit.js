/**
 * A person's edit or unsend of a text they sent (node `edit`, `texConfig.json`), asked by the texting Worker's chat object over
 * the `TexTexts` binding before the edit is kept or queued (`packages/tex/worker/editStep.ts`). The node runs on the
 * gateway's graph, so its input, output and time are logged like every node's; the Worker keeps the edit and queues its
 * turn itself. The body holds the chat's kind and the words now and before, both capped at a text's length.
 */

import { gatewayGraph } from "./graph/gatewayGraph.js";

/** The path the texting Worker posts to on the `TexTexts` binding. */
export const TEXTS_EDIT_PATH = "/texts/edit";

/** Two texts at the Worker's cap (`MAX_INBOUND_TEXT`, 20,000 characters, up to 4 bytes each) and the rest of the body. */
const MAX_BYTES = 2 * 20_000 * 4 + 1024;

/** Runs `edit` on the posted input and answers its output: `{ to: "turn" | "same" | "withdraw", why }`. */
export async function editForTexts(request, { graph = gatewayGraph() } = {}) {
  if (request.method !== "POST") return Response.json({ error: "bad_request" }, { status: 400 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return Response.json({ error: "too_large" }, { status: 413 });
  let input;
  try {
    input = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ error: "bad_body" }, { status: 400 });
  }
  try {
    const run = await graph.runNode("edit", input, {}, "textsEdit");
    // A node turned off in the config never runs: an edit goes on as a text, an unsend is taken back, as on a failure.
    return Response.json(run.ran ? run.output : input?.change === "unsend" ? { to: "withdraw", why: "the edit step is off" } : { to: "turn", why: "the edit step is off" });
  } catch (error) {
    // A body the node's inSchema refuses, or a node that failed: the Worker takes an edit as a text, an unsend as taken back (`editStep.ts`).
    console.log(JSON.stringify({ event: "texts_edit", outcome: "failed", error: error instanceof Error ? error.name : "unknown" }));
    return Response.json({ error: "node_failed" }, { status: 422 });
  }
}

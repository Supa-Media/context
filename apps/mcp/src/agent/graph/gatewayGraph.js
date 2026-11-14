/**
 * The gateway's one graph: Tex's config (`texConfig.json`) run by the shared runner (`packages/shared/src/texGraph.cjs`)
 * over the nodes in `GATEWAY_NODES`, every node run written to the chat's ledger as a `step` entry `step: "node"`
 * (`ledger.js` `nodeEntry`). Every node runs in the gateway (Dev2, 2026-11-14), so this is the only place a turn's
 * wires are read.
 *
 * While the migration runs, plumbing that is not a node yet calls one node by id with `runNode(id, input, ctx, via)`,
 * `via` naming the caller ("sendTheReply", "claimCheck"), or over a config wire with `fire(from, to, input, ctx)`.
 */
import { createGraph } from "../../../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG } from "../texConfig.js";
import { nodeLog } from "../ledger.js";
import { GATEWAY_NODES } from "./gatewayNodes.js";

/**
 * One turn's graph. `writer` is the chat's ledger writer (`ledgerWriter`, `sessionLedger`), `turn` the turn's id,
 * `background` where a background wire's run goes (the request's `waitUntil`); `config` a turn's own copy of the config
 * (`turnGraph.js`, a setup's switches flipped), `log` a turn's own log in place of one write a run (`turnGraph.js` batches
 * them), `nodes` only for tests.
 */
export function gatewayGraph({ writer = null, turn = null, background = null, nodes = GATEWAY_NODES, config = TEX_CONFIG, log = null, now = Date.now } = {}) {
  return createGraph(config, nodes, { log: log ?? nodeLog(writer, { turn }), background, now });
}

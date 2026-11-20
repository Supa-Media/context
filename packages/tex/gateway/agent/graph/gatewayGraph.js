/**
 * The gateway's one graph: Tex's config (`texConfig.json`) run by the shared runner (`packages/tex/src/texGraph.cjs`)
 * over the nodes in `GATEWAY_NODES`, every node run written to the chat's ledger as a `step` entry `step: "node"`
 * (`ledger.js` `nodeEntry`). Every node runs in the gateway (Dev2, 2026-11-14), so this is the only place a turn's
 * wires are read.
 *
 * While the migration runs, plumbing that is not a node yet calls one node by id with `runNode(id, input, ctx, via)`,
 * `via` naming the caller ("sendTheReply", "claimCheck"), or over a config wire with `fire(from, to, input, ctx)`.
 */
import { createGraph } from "../../../src/texGraph.cjs";
import { TEX_CONFIG } from "../texConfig.js";
import { nodeLog } from "../ledger.js";
import { GATEWAY_NODES } from "./gatewayNodes.js";
import { sandboxGateOf } from "../../../../../apps/mcp/src/labSandbox/policy.js";

/**
 * One turn's graph. `writer` is the chat's ledger writer (`ledgerWriter`, `sessionLedger`), `turn` the turn's id,
 * `background` where a background wire's run goes (the request's `waitUntil`); `config` a turn's own copy of the config
 * (`turnGraph.js`, a setup's switches flipped), `log` a turn's own log in place of one write a run (`turnGraph.js` batches
 * them), `onStart` each run as it starts (a Lab test chat's running steps, `labSandbox/steps.js`), `env` the request's
 * (a Lab test chat's gate shows every run on its card), `nodes` only for tests.
 */
export function gatewayGraph({ env = null, writer = null, turn = null, background = null, nodes = GATEWAY_NODES, config = TEX_CONFIG, log = null, now = Date.now, onStart = null } = {}) {
  // A Lab test chat's request (`env` carries its gate, `labSandbox/policy.js`) shows each node of this graph on its run
  // card as it starts and ends, as the turn's own graph does (`turnGraph.js`); a real request's env carries no gate.
  const gate = sandboxGateOf(env);
  const written = log ?? nodeLog(writer, { turn });
  const watch = log === null && typeof gate?.onNode === "function" ? gate.onNode : null;
  const logged = watch === null ? written : (run) => {
    written(run);
    try {
      watch(run);
    } catch {
      /* the Lab's view never stops a node */
    }
  };
  return createGraph(config, nodes, { log: logged, background, now, onStart: onStart ?? gate?.onStart ?? null });
}

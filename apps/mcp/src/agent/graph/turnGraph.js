/**
 * TEX'S TURN RUNS ITS CONFIG'S GRAPH (Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the
 * connections between node to be code. They should be predefined").
 *
 * One turn is one run of `texConfig.json` from the first door step: the runner (`packages/shared/src/texGraph.cjs`)
 * follows the config's wires through the door, the front door and what it uses, the checks on its drafts and the way
 * out, and fires the background wires after it. The nodes are `GATEWAY_NODES`; the turn so far, `t`, is the run's
 * context (`ctx.turn`), shared by every node and never logged. The runner logs every node run itself, into the chat's
 * ledger once the turn has one (`prepareBookkeeping` opens it), the earlier door steps' runs kept until then.
 */
import { nodeEntry } from "../ledger.js";
import { TEX_CONFIG } from "../texConfig.js";
import { gatewayGraph } from "./gatewayGraph.js";

/** Where a turn's run starts: the first door step. */
export const TURN_START = "readTheText";

/**
 * The runner's log for one turn: each node run as a `step` entry `step: "node"` of the chat's ledger (`ledger.js` `nodeEntry`). Kept
 * as they run and written together when the run ends (and again after a background node), one ledger write, not one a
 * node: a turn's door steps cost no store call before its model. A turn with no ledger (an app question, a refusal at
 * the door before the ledger opened) keeps none.
 */
function ledgerLog(t) {
  const kept = [];
  return {
    keep: (run) => void kept.push({ run, turn: t.ledgerTurn ?? null }),
    write: () => {
      if (!t.chatLog || kept.length === 0) return;
      const entries = kept.splice(0).map(({ run, turn }) => nodeEntry(run, { turn: turn ?? t.ledgerTurn ?? null })).filter(Boolean);
      if (entries.length > 0) t.chatLog.write(entries);
    },
  };
}

/** The nodes a setup turns on or off, by what it says (`production.js`). Live Tex's setup names no models, so these are the config's own (`texConfig.js`). */
const SETUP_NODES = Object.freeze({
  planner: (setup) => setup.planBigAsks === true,
  reviewer: (setup) => Boolean(setup.replyJudge),
  advisor: (setup) => Boolean(setup.advisor),
  fallback: (setup) => setup.fallback !== null && setup.fallback !== undefined,
});

/** This turn's copy of the config, and the switch a setup that differs from it flips: each node it changed, as "planner on". */
function turnConfig() {
  const config = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.map((node) => ({ ...node })), edges: TEX_CONFIG.edges };
  const useSetup = (setup) => {
    if (!setup || typeof setup !== "object") return "";
    const changed = [];
    for (const [id, on] of Object.entries(SETUP_NODES)) {
      const node = config.nodes.find((n) => n.id === id);
      const want = on(setup);
      if (node && node.on !== want) {
        node.on = want;
        changed.push(`${id} ${want ? "on" : "off"}`);
      }
    }
    return changed.join(", ");
  };
  return { config, useSetup };
}

/** Runs one turn on the graph; its answer is the `Response` the node that answered left in `t.response`. */
export async function runTurnGraph(t) {
  const { config, useSetup } = turnConfig();
  const log = ledgerLog(t);
  const graph = gatewayGraph({
    config,
    log: log.keep,
    // A background wire's run is ours, not the person's: kept alive after the response, and its log flushed then.
    background: (running) => void t.tex.after("graph_background", running.finally(() => (log.write(), t.chatLog?.flush?.()))),
  });
  try {
    await graph.run(TURN_START, {}, { turn: t, useSetup });
  } finally {
    log.write();
  }
  return t.response;
}

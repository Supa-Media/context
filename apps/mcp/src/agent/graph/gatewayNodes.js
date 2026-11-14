/**
 * The gateway's nodes: the code of each `texConfig.json` node, by node id. The wires between them are never here:
 * `packages/shared/src/texGraph.cjs` reads them from the config (Dev2, 2026-11-14: "it's fine for node to be code, but
 * it's not fine for the connections between node to be code"). A node is `async (input, io) => output`; it reaches
 * another node only through `io.use`, `io.back` or `io.job`, which its wires decide, and it never imports another
 * node's code (`test/texGraphHome.test.mjs`).
 */
import card from "./nodes/card.js";
import daysum from "./nodes/daysum.js";
import dream from "./nodes/dream.js";
import egress from "./nodes/egress.js";
import housekeep from "./nodes/housekeep.js";
import nightly from "./nodes/nightly.js";
import nudge from "./nodes/nudge.js";
import picture from "./nodes/picture.js";
import reflect from "./nodes/reflect.js";

/** @type {Record<string, (input: any, io: any) => Promise<any>>} */
export const GATEWAY_NODES = { card, daysum, dream, egress, housekeep, nightly, nudge, picture, reflect };

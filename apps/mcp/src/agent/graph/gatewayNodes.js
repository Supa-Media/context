/**
 * The gateway's nodes: the code of each `texConfig.json` node that runs here, by node id (a node not here yet is in
 * `packages/shared/src/texGraphNotYet.json`). The wires between them are never here: `packages/shared/src/texGraph.cjs` reads them from the
 * config (Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the connections between node to be
 * code"). A node is `async (input, io) => output`; it reaches another node only through `io.use`, `io.back` or `io.job`,
 * which its wires decide, and it never imports another node's code.
 *
 * Empty while the migration runs: each node joins this table, and leaves `notYet`, in its own pull request.
 */

/** @type {Record<string, (input: any, io: any) => Promise<any>>} */
export const GATEWAY_NODES = {};

/**
 * The gateway's nodes: the code of each `texConfig.json` node that runs here (`packages/shared/src/texGraphHome.json`
 * `gateway`), by node id. The wires between them are never here: `packages/shared/src/texGraph.cjs` reads them from the
 * config (Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the connections between node to be
 * code"). A node is `async (input, io) => output`; it reaches another node only through `io.use`, `io.back` or `io.job`,
 * which its wires decide, and it never imports another node's code.
 *
 * Each node joins this table, and leaves `notYet`, in the pull request that moves it.
 */
import { checkin } from "./nodes/checkin.js";
import { notify } from "./nodes/notify.js";
import { jobcheck } from "./nodes/jobcheck.js";
import { handback } from "./nodes/handback.js";
import { mailadv } from "./nodes/mailadv.js";

/** @type {Record<string, (input: any, io: any) => Promise<any>>} */
export const GATEWAY_NODES = { checkin, notify, jobcheck, handback, mailadv };
